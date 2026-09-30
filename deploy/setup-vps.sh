#!/usr/bin/env bash
# RizeHub HQ: first-time (and repeatable) setup on the existing Hostinger VPS. Idempotent: safe to re-run.
#
#   sudo bash deploy/setup-vps.sh --repo git@github.com:<you>/rizehub-hq.git [--with-nginx --email you@example.com]
#   sudo bash deploy/setup-vps.sh --repo /root/rizehub-hq.bundle          # no GitHub access yet: clone from a git bundle
#
# What it does (each step is skipped when already done):
#   1. creates the non-root app user (default rizehq) and adds it to the docker group
#   2. installs Docker Engine + compose plugin if missing (get.docker.com)
#   3. creates the shared Docker network rizehub-internal (docs/12)
#   4. clones the repo into /home/rizehq/rizehub-hq, or fast-forwards it
#   5. creates .env from .env.example (chmod 600), generates internal secrets, prompts for the rest
#   6. validates .env, splits it into .env.dashboard / .env.bot / .env.worker (each container gets only its own
#      variables) and validates those too (scripts/check-env.mjs --production / --split, run inside a node container)
#   7. fixes brain/ + workspaces ownership (deploy/fix-perms.sh), builds and starts the stack, waits for health
#   8. optional --with-nginx: installs deploy/nginx/hq.rizehub.ph.conf and runs certbot
#   9. prints the go-live checklist
# It never touches existing nginx sites, the firewall, or RizeHub itself.
set -Eeuo pipefail

HQ_USER="${HQ_USER:-rizehq}"
REPO_URL="${REPO_URL:-}"
BRANCH="${BRANCH:-main}"
DOMAIN="${DOMAIN:-hq.rizehub.ph}"
WITH_NGINX=false
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
NONINTERACTIVE=false

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO_URL="${2:?--repo needs a value}"; shift 2 ;;
    --branch) BRANCH="${2:?}"; shift 2 ;;
    --user) HQ_USER="${2:?}"; shift 2 ;;
    --domain) DOMAIN="${2:?}"; shift 2 ;;
    --with-nginx) WITH_NGINX=true; shift ;;
    --email) CERTBOT_EMAIL="${2:?}"; shift 2 ;;
    --yes|-y|--non-interactive) NONINTERACTIVE=true; shift ;;
    -h|--help) usage 0 ;;
    *) echo "Unknown option: $1" >&2; usage 1 ;;
  esac
done
[[ -t 0 ]] || NONINTERACTIVE=true

APP_HOME="/home/${HQ_USER}"
APP_DIR="${APP_DIR:-${APP_HOME}/rizehub-hq}"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
as_app() { sudo -u "$HQ_USER" -H -- "$@"; }
trap 'die "setup-vps.sh failed at line $LINENO (re-run after fixing; every step is idempotent)"' ERR

[[ $EUID -eq 0 ]] || die "Run as root: sudo bash $0 $*"
command -v sudo >/dev/null || die "sudo is required"
[[ -n "$REPO_URL" && -f "$REPO_URL" ]] && REPO_URL="$(realpath "$REPO_URL")"
cd /   # the app user must not inherit root's (unreadable) working directory

# ---------- 1. app user ----------
say "App user: ${HQ_USER}"
if id "$HQ_USER" >/dev/null 2>&1; then ok "exists"
else adduser --disabled-password --gecos "RizeHub HQ" "$HQ_USER" >/dev/null; ok "created"; fi

# ---------- 2. docker ----------
say "Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
  ok "installed $(docker --version)"
else ok "$(docker --version)"; fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version >/dev/null 2>&1 || die "docker compose plugin missing (apt install docker-compose-plugin)"
ok "$(docker compose version)"
getent group docker >/dev/null || groupadd docker
if id -nG "$HQ_USER" | tr ' ' '\n' | grep -qx docker; then ok "${HQ_USER} is in the docker group"
else usermod -aG docker "$HQ_USER"; ok "added ${HQ_USER} to the docker group"; fi

# ---------- 3. shared network ----------
say "Docker network rizehub-internal"
if docker network inspect rizehub-internal >/dev/null 2>&1; then ok "exists"
else docker network create rizehub-internal >/dev/null; ok "created (attach RizeHub's app service to it too: docs/12)"; fi

# ---------- 4. code ----------
say "Code in ${APP_DIR}"
command -v git >/dev/null || { apt-get update -qq && apt-get install -y -qq git >/dev/null; }
if [[ -d "${APP_DIR}/.git" ]]; then
  as_app git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
  as_app git -C "$APP_DIR" checkout --quiet "$BRANCH"
  as_app git -C "$APP_DIR" merge --ff-only --quiet "origin/${BRANCH}" && ok "up to date with origin/${BRANCH} ($(as_app git -C "$APP_DIR" rev-parse --short HEAD))"
else
  [[ -n "$REPO_URL" ]] || die "No checkout yet: pass --repo <git url or .bundle path>"
  if [[ "$REPO_URL" == git@* || "$REPO_URL" == ssh://* ]]; then
    # Private GitHub repo over SSH: a read-only deploy key for the app user.
    KEY="${APP_HOME}/.ssh/id_ed25519"
    if [[ ! -f "$KEY" ]]; then
      as_app mkdir -p "${APP_HOME}/.ssh" && chmod 700 "${APP_HOME}/.ssh"
      as_app ssh-keygen -q -t ed25519 -N '' -C "rizehq-deploy@$(hostname)" -f "$KEY"
    fi
    as_app sh -c "ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null; sort -u -o ~/.ssh/known_hosts ~/.ssh/known_hosts"
    if ! as_app git ls-remote "$REPO_URL" >/dev/null 2>&1; then
      echo; echo "Add this public key as a READ-ONLY deploy key (GitHub repo → Settings → Deploy keys):"; echo
      cat "${KEY}.pub"; echo
      $NONINTERACTIVE && die "deploy key not authorised yet; add it and re-run"
      read -r -p "Press Enter once the key is added… " _
      as_app git ls-remote "$REPO_URL" >/dev/null || die "still no access to ${REPO_URL}"
    fi
  elif [[ -f "$REPO_URL" ]]; then
    install -o "$HQ_USER" -g "$HQ_USER" -m 600 "$REPO_URL" "${APP_HOME}/rizehub-hq.bundle"
    REPO_URL="${APP_HOME}/rizehub-hq.bundle"
    warn "cloning from a git bundle: later switch origin with: git -C ${APP_DIR} remote set-url origin <github url>"
  fi
  as_app git clone --quiet --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  ok "cloned ($(as_app git -C "$APP_DIR" rev-parse --short HEAD))"
fi
chmod +x "${APP_DIR}"/deploy/*.sh 2>/dev/null || true

# ---------- 5. .env ----------
say ".env"
ENV_FILE="${APP_DIR}/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  as_app cp "${APP_DIR}/.env.example" "$ENV_FILE"
  ok "created from .env.example"
fi
chown "$HQ_USER:$HQ_USER" "$ENV_FILE"; chmod 600 "$ENV_FILE"

env_get() { awk -F= -v k="$1" '$1==k { sub(/^[^=]*=/, ""); sub(/[ \t]+#.*$/, ""); print; exit }' "$ENV_FILE"; }
env_set() { # env_set KEY VALUE: replace (or append) KEY=VALUE without sed-escaping problems
  local tmp; tmp="$(mktemp)"
  K="$1" V="$2" awk 'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; done = 0 }
    $0 ~ "^[ \t]*" k "=" { print k "=" v; done = 1; next } { print }
    END { if (!done) print k "=" v }' "$ENV_FILE" > "$tmp"
  cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
}
gen_if_empty() { # generated secrets: only when empty, never overwritten (the vault key especially!)
  if [[ -z "$(env_get "$1")" ]]; then env_set "$1" "$2"; ok "$1 generated"; else ok "$1 kept"; fi
}
gen_if_empty HQ_INTERNAL_SECRET "$(openssl rand -hex 32)"
gen_if_empty RIZEHUB_WEBHOOK_SECRET "$(openssl rand -hex 32)"
if [[ -z "$(env_get VAULT_MASTER_KEY)" ]]; then
  env_set VAULT_MASTER_KEY "$(openssl rand -base64 32)"
  warn "VAULT_MASTER_KEY generated: copy it to your password manager NOW (losing it = all vault credentials unreadable):"
  warn "  sudo grep ^VAULT_MASTER_KEY= ${ENV_FILE}"
else ok "VAULT_MASTER_KEY kept"; fi
[[ "$(env_get DASHBOARD_URL)" == "https://${DOMAIN}" ]] || { env_set DASHBOARD_URL "https://${DOMAIN}"; ok "DASHBOARD_URL=https://${DOMAIN}"; }

ask() { # ask KEY "question" [secret]
  local cur; cur="$(env_get "$1")"
  if [[ -n "$cur" && "$cur" != http://127.0.0.1* && "$cur" != http://localhost* ]]; then ok "$1 already set"; return; fi
  $NONINTERACTIVE && { warn "$1 empty (non-interactive: edit ${ENV_FILE})"; return; }
  local v
  if [[ "${3:-}" == secret ]]; then read -r -s -p "    $2: " v; echo; else read -r -p "    $2: " v; fi
  if [[ -n "$v" ]]; then env_set "$1" "$v"; fi
}
echo "    Fill in production values (Enter = skip; edit later with: sudo -u ${HQ_USER} nano ${ENV_FILE}, then deploy/update.sh --force)"
ask SUPABASE_URL "Supabase URL (https://<ref>.supabase.co)"
if [[ "$(env_get SUPABASE_URL)" == https://* && "$(env_get NEXT_PUBLIC_SUPABASE_URL)" != https://* ]]; then
  env_set NEXT_PUBLIC_SUPABASE_URL "$(env_get SUPABASE_URL)"; ok "NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL"
fi
ask NEXT_PUBLIC_SUPABASE_ANON_KEY "Supabase anon / publishable key" secret
ask SUPABASE_SERVICE_ROLE_KEY "Supabase service_role / secret key" secret
ask TELEGRAM_BOT_TOKEN "PRODUCTION Telegram bot token (@BotFather)" secret
ask TELEGRAM_ALLOWED_USER_IDS "Your numeric Telegram user id (@userinfobot)"
ask GOOGLE_GENERATIVE_AI_API_KEY "Gemini API key (free, aistudio.google.com)" secret
ask GROQ_API_KEY "Groq API key (free, console.groq.com)" secret
ask OPENROUTER_API_KEY "OpenRouter API key (free models, openrouter.ai)" secret
chown "$HQ_USER:$HQ_USER" "$ENV_FILE"; chmod 600 "$ENV_FILE"

# ---------- 6. validate + split ----------
node_run() { # node_run <mount mode ro|rw> args…: Node inside a container, files written as the app user
  local mode="$1"; shift
  docker run --rm -u "$(id -u "$HQ_USER"):$(id -g "$HQ_USER")" -v "${APP_DIR}:/app:${mode}" -w /app node:22-alpine node "$@"
}
say "Validating .env (production rules)"
if ! node_run ro scripts/check-env.mjs --file .env --production; then
  $NONINTERACTIVE && die "fix .env, then re-run"
  read -r -p "    .env has errors. Start anyway? [y/N] " a; [[ "$a" =~ ^[Yy]$ ]] || die "fix ${ENV_FILE}, then re-run"
fi
say "Per-service env files (.env.dashboard / .env.bot / .env.worker)"
node_run rw scripts/split-env.mjs --in .env
for f in .env.dashboard .env.bot .env.worker .env.brain; do chown "$HQ_USER:$HQ_USER" "${APP_DIR}/${f}"; chmod 600 "${APP_DIR}/${f}"; done
# Hard stop: a server secret in the dashboard file (service-role key, vault key) must never be deployed.
node_run ro scripts/check-env.mjs --split --production --file .env || die "per-service env files failed the check (see ✗ above)"

# ---------- 7. build + start ----------
say "File ownership (brain/ → ${HQ_USER}, workspaces → agent uid 1001)"
as_app bash "${APP_DIR}/deploy/fix-perms.sh"
say "Building and starting the stack (first build takes a few minutes)"
as_app bash -c "cd '$APP_DIR' && docker compose up -d --build --remove-orphans"
for img in dashboard worker bot; do docker image inspect "rizehubhq-${img}:latest" >/dev/null 2>&1 && docker tag "rizehubhq-${img}:latest" "rizehubhq-${img}:$(as_app git -C "$APP_DIR" rev-parse --short HEAD)"; done
bash "${APP_DIR}/deploy/update.sh" --health-only || warn "not healthy yet: docker compose -f ${APP_DIR}/docker-compose.yml logs --tail=100"

# ---------- 8. reverse proxy ----------
if $WITH_NGINX; then
  say "nginx site for ${DOMAIN}"
  command -v nginx >/dev/null || die "nginx is not installed/owning :80 (use deploy/Caddyfile or your panel's reverse proxy instead)"
  SITE=/etc/nginx/sites-available/${DOMAIN}
  if [[ -f "$SITE" ]] && grep -q "ssl_certificate" "$SITE"; then ok "${SITE} already has TLS (certbot ran): left untouched"
  else
    sed "s/hq\.rizehub\.ph/${DOMAIN}/g" "${APP_DIR}/deploy/nginx/hq.rizehub.ph.conf" > "$SITE"
    ln -sf "$SITE" "/etc/nginx/sites-enabled/${DOMAIN}"
    nginx -t && systemctl reload nginx && ok "site enabled"
  fi
  if [[ -n "$CERTBOT_EMAIL" ]]; then
    command -v certbot >/dev/null || { apt-get update -qq && apt-get install -y -qq certbot python3-certbot-nginx >/dev/null; }
    certbot --nginx -d "$DOMAIN" --redirect -m "$CERTBOT_EMAIL" --agree-tos -n --keep-until-expiring && ok "TLS certificate ready"
  else warn "no --email: run later: sudo certbot --nginx -d ${DOMAIN} --redirect"; fi
fi

# ---------- 9. checklist ----------
IP="$(curl -fsS -4 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
DNS="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}')"
say "Done. Go-live checklist"
cat <<EOF
    [$( [[ "$DNS" == "$IP" ]] && echo x || echo ' ')] DNS: A record ${DOMAIN} → ${IP}   (now resolves to: ${DNS:-nothing})
    [ ] Reverse proxy + TLS: deploy/nginx/hq.rizehub.ph.conf + certbot (or deploy/Caddyfile / your panel's proxy)
    [ ] https://${DOMAIN} shows the login page; https://${DOMAIN}/api/health → {"ok":true}
    [ ] Supabase: migrations pushed, seed run, CEO user + ceo_users row, MFA  (deploy/supabase-setup.md)
    [ ] Telegram: message your PRODUCTION bot /status; only your id gets answers
    [ ] RizeHub: app service on network rizehub-internal; /agent-api blocked publicly (deploy/nginx/rizehub-block-agent-api.conf)
    [ ] /assign "Write a short blog outline about Shopify speed" → plan in Approvals → approve → QA → deliverable
    [ ] Backups: crontab -e (as ${HQ_USER}):  17 3 * * * ${APP_DIR}/deploy/backup.sh >> ${APP_HOME}/backup.log 2>&1
    [ ] Hostinger VPS snapshot taken; existing sites on this VPS still load
    [ ] Auto-deploy (optional): GitHub secrets VPS_HOST, VPS_USER=${HQ_USER}, VPS_SSH_KEY + variable DEPLOY_ENABLED=true
Useful: sudo -iu ${HQ_USER}; cd ${APP_DIR}; docker compose ps; docker compose logs -f worker
After editing .env: node scripts/split-env.mjs (or deploy/update.sh --force) so the containers get the new values.
EOF
