#!/usr/bin/env bash
# RizeHub HQ Brain (docs/16-BRAIN.md): one-time setup of the vault mirror on the VPS. Idempotent: safe to re-run.
#
#   sudo -u rizehq -H bash deploy/brain-setup.sh          run as the app user, from anywhere
#
# What it does (each step is skipped when already done):
#   1. creates secrets/brain/brain_deploy_key (ed25519, no passphrase) and prints the PUBLIC half: add it in GitHub ›
#      claude-memory-vault › Settings › Deploy keys, with "Allow write access" (M2 writes go back through it)
#   2. pins GitHub's ed25519 host key in secrets/brain/known_hosts, after checking it against GitHub's published
#      fingerprint (the brain's ssh runs with StrictHostKeyChecking=yes)
#   3. adds BRAIN_REPO_URL and generates BRAIN_INTERNAL_SECRET / BRAIN_WEBHOOK_SECRET in .env when they are missing
#      (values are never printed). BRAIN_OPENAI_API_KEY stays yours to paste into .env.
# Then: deploy/update.sh --force (splits .env into .env.brain and starts hq-brain).
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS_DIR="${APP_DIR}/secrets/brain"
KEY="${SECRETS_DIR}/brain_deploy_key"
KNOWN_HOSTS="${SECRETS_DIR}/known_hosts"
ENV_FILE="${APP_DIR}/.env"
REPO_URL_DEFAULT="git@github.com:cracker17/claude-memory-vault.git"
# https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
GITHUB_ED25519_FP="SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU"

log() { printf '[brain-setup] %s\n' "$*"; }
die() { printf '[brain-setup] ERROR: %s\n' "$*" >&2; exit 1; }

[[ "$(id -u)" -ne 0 ]] || die "run as the app user (sudo -u rizehq -H bash deploy/brain-setup.sh), not root"
[[ -f "$ENV_FILE" ]] || die "${ENV_FILE} not found (run deploy/setup-vps.sh first)"
umask 077
mkdir -p "$SECRETS_DIR"
chmod 711 "$SECRETS_DIR"   # traverse-only: the container user (uid 1000) reaches the files fix-perms hands to it

# 1. deploy key
if [[ -f "$KEY" ]]; then
  log "deploy key exists: ${KEY}"
else
  ssh-keygen -q -t ed25519 -N "" -C "hq-brain@hq.rizehub.ph" -f "$KEY"
  log "created deploy key ${KEY}"
fi

# 2. GitHub host key, verified against the published fingerprint
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
ssh-keyscan -t ed25519 github.com 2>/dev/null >"$tmp" || true
fp="$(ssh-keygen -lf "$tmp" 2>/dev/null | awk '{print $2}' || true)"
[[ "$fp" == "$GITHUB_ED25519_FP" ]] || die "github.com ed25519 fingerprint is '${fp:-none}', expected ${GITHUB_ED25519_FP}: not pinning it"
rm -f "$KNOWN_HOSTS"      # may be owned by the container uid after fix-perms; the directory is ours
cp "$tmp" "$KNOWN_HOSTS"
log "pinned github.com host key (${fp})"

# 3. .env entries (append only when missing or empty; never print values)
set_if_missing() {
  local name="$1" value="$2"
  if grep -Eq "^${name}=.+" "$ENV_FILE"; then log "${name} already set"; return; fi
  if grep -Eq "^${name}=" "$ENV_FILE"; then
    sed -i "s|^${name}=.*|${name}=${value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$name" "$value" >>"$ENV_FILE"
  fi
  log "${name} set in .env"
}
set_if_missing BRAIN_REPO_URL "$REPO_URL_DEFAULT"
set_if_missing BRAIN_INTERNAL_SECRET "$(openssl rand -hex 32)"
set_if_missing BRAIN_WEBHOOK_SECRET "$(openssl rand -hex 32)"
chmod 600 "$ENV_FILE"

# The container runs as uid 1000 (node) with the secrets mounted read-only: deploy/fix-perms.sh hands them over.
bash "${APP_DIR}/deploy/fix-perms.sh"

cat <<EOF

Next steps
  1. GitHub › cracker17/claude-memory-vault › Settings › Deploy keys › Add deploy key
     Title: hq-brain (VPS) · tick "Allow write access" · Key:
     $(cat "${KEY}.pub")
  2. Paste an OpenAI key for embeddings into ${ENV_FILE} as BRAIN_OPENAI_API_KEY= (optional: empty = keyword search).
  3. deploy/update.sh --force   (splits .env → .env.brain, starts hq-brain)
  4. GitHub webhook on the vault repo: https://hq.rizehub.ph/api/brain/github, content type application/json,
     secret = BRAIN_WEBHOOK_SECRET from .env, events: just the push event.
EOF
