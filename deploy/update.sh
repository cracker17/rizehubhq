#!/usr/bin/env bash
# RizeHub HQ: deploy the latest main on the VPS, with automatic rollback. Run as the app user (rizehq).
#
#   deploy/update.sh                 pull main → validate .env → split into .env.dashboard/.env.bot/.env.worker
#                                    → fix brain/ + workspaces ownership → build → up -d → health check → prune
#                                    (health fails → previous images + previous commit restored)
#   deploy/update.sh --health-only   just wait for / report container health (used by setup-vps.sh)
#   deploy/update.sh --force         rebuild even if main has not moved
#
# Env: BRANCH (main), HEALTH_TIMEOUT seconds (180), KEEP_TAGS (3 commit-tagged images kept per service).
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${BRANCH:-main}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"
KEEP_TAGS="${KEEP_TAGS:-3}"
SERVICES=(dashboard worker bot)
HEALTH_ONLY=false
FORCE=false
for a in "$@"; do
  case "$a" in
    --health-only) HEALTH_ONLY=true ;;
    --force) FORCE=true ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $a" >&2; exit 2 ;;
  esac
done

log()  { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
die()  { log "ERROR: $*" >&2; exit 1; }
cd "$APP_DIR"
dc() { docker compose "$@"; }

# ---------- health ----------
# dashboard + worker: Docker HEALTHCHECK must report healthy. bot: running and not restart-looping.
wait_healthy() {
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT )) svc cid state health pending
  local bot_restarts=""
  while :; do
    pending=()
    for svc in "${SERVICES[@]}"; do
      cid="$(dc ps -q "$svc" 2>/dev/null || true)"
      if [[ -z "$cid" ]]; then pending+=("$svc:missing"); continue; fi
      state="$(docker inspect -f '{{.State.Status}}' "$cid")"
      health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid")"
      if [[ "$state" == restarting || "$state" == exited || "$state" == dead ]]; then
        log "$svc is $state"; dc logs --tail=40 "$svc" || true; return 1
      fi
      [[ "$health" == unhealthy ]] && { log "$svc is unhealthy"; dc logs --tail=40 "$svc" || true; return 1; }
      if [[ "$health" == none ]]; then
        # no healthcheck (bot): healthy once it has stayed up without restarts for two checks
        local rc; rc="$(docker inspect -f '{{.RestartCount}}' "$cid")"
        if [[ "$bot_restarts" == "$rc" ]]; then :; else bot_restarts="$rc"; pending+=("$svc:settling"); fi
      elif [[ "$health" != healthy ]]; then pending+=("$svc:$health"); fi
    done
    if [[ ${#pending[@]} -eq 0 ]]; then
      if curl -fsS --max-time 5 http://127.0.0.1:3100/api/health >/dev/null; then log "healthy: ${SERVICES[*]} (dashboard answers on 127.0.0.1:3100)"; return 0; fi
      pending+=("dashboard:http")
    fi
    (( $(date +%s) >= deadline )) && { log "timed out after ${HEALTH_TIMEOUT}s waiting for: ${pending[*]}"; return 1; }
    sleep 5
  done
}

if $HEALTH_ONLY; then wait_healthy; exit $?; fi

# One deploy at a time (manual + GitHub Action).
exec 9>"${TMPDIR:-/tmp}/rizehubhq-update.lock"
flock -n 9 || die "another update is running"

# ---------- validate .env, split per service (inside a node container: no Node needed on the host) ----------
node_run() { docker run --rm -u "$(id -u):$(id -g)" -v "${APP_DIR}:/app:$1" -w /app node:22-alpine node "${@:2}"; }
fail_env() { cat /tmp/rizehubhq-check-env.log; git reset --quiet --hard "$PREV_SHA"; die "$1; code reset to ${PREV_SHA:0:7}, nothing deployed"; }
prepare_env() {
  node_run ro scripts/check-env.mjs --file .env --production >/tmp/rizehubhq-check-env.log 2>&1 || fail_env ".env check failed"
  # Each container gets only its own variables (the dashboard never sees the service-role or vault key).
  node_run rw scripts/split-env.mjs --in .env >/tmp/rizehubhq-check-env.log 2>&1 || fail_env "splitting .env failed"
  chmod 600 .env.dashboard .env.bot .env.worker
  node_run ro scripts/check-env.mjs --split --production --file .env >/tmp/rizehubhq-check-env.log 2>&1 || fail_env "per-service env files failed the check"
  bash "${APP_DIR}/deploy/fix-perms.sh" || log "warning: deploy/fix-perms.sh failed (brain/ or workspaces ownership); continuing"
}

# ---------- pull ----------
if ! git diff --quiet || ! git diff --cached --quiet; then die "local changes in ${APP_DIR}: commit/stash them first (git status)"; fi
PREV_SHA="$(git rev-parse HEAD)"
git fetch --quiet origin "$BRANCH"
git checkout --quiet "$BRANCH"
git merge --ff-only --quiet "origin/${BRANCH}" || die "cannot fast-forward ${BRANCH} (history rewritten?). Resolve by hand."
NEW_SHA="$(git rev-parse HEAD)"
NEW_TAG="$(git rev-parse --short HEAD)"
if [[ "$PREV_SHA" == "$NEW_SHA" ]] && ! $FORCE; then
  log "already at ${NEW_TAG}; ensuring the stack is up (with the current .env)"
  prepare_env
  dc up -d --remove-orphans
  wait_healthy; exit $?
fi
log "deploying ${PREV_SHA:0:7} → ${NEW_TAG}"
git --no-pager log --oneline "${PREV_SHA}..${NEW_SHA}" | head -20 || true

if ! git diff --quiet "$PREV_SHA" "$NEW_SHA" -- supabase/migrations; then
  log "!!! This update contains NEW DATABASE MIGRATIONS:"
  git diff --name-only "$PREV_SHA" "$NEW_SHA" -- supabase/migrations | sed 's/^/      /'
  log "!!! Apply them with 'supabase db push' (deploy/supabase-setup.md) if you have not already."
fi
if ! git diff --quiet "$PREV_SHA" "$NEW_SHA" -- .env.example; then
  log "note: .env.example changed; new variables may need values in .env (then re-run with --force)"
fi

prepare_env

# ---------- build + switch ----------
for s in "${SERVICES[@]}"; do
  if docker image inspect "rizehubhq-${s}:latest" >/dev/null 2>&1; then docker tag "rizehubhq-${s}:latest" "rizehubhq-${s}:previous"; fi
done
if ! dc build --pull; then
  git reset --quiet --hard "$PREV_SHA"
  for s in "${SERVICES[@]}"; do
    if docker image inspect "rizehubhq-${s}:previous" >/dev/null 2>&1; then docker tag "rizehubhq-${s}:previous" "rizehubhq-${s}:latest"; fi
  done
  die "build failed; running containers untouched, code reset to ${PREV_SHA:0:7}"
fi
dc up -d --remove-orphans

if wait_healthy; then
  for s in "${SERVICES[@]}"; do
    docker tag "rizehubhq-${s}:latest" "rizehubhq-${s}:${NEW_TAG}"
    # keep the newest KEEP_TAGS commit tags per service (plus :latest and :previous)
    docker image ls "rizehubhq-${s}" --format '{{.CreatedAt}}\t{{.Tag}}' | sort -r | cut -f2 \
      | grep -vxE 'latest|previous|<none>' | tail -n +"$((KEEP_TAGS + 1))" \
      | while read -r t; do docker rmi "rizehubhq-${s}:${t}" >/dev/null 2>&1 || true; done
  done
  docker image prune -f >/dev/null
  docker builder prune -f --filter until=168h >/dev/null 2>&1 || true
  log "deployed ${NEW_TAG}"
  exit 0
fi

# ---------- rollback ----------
log "health check FAILED: rolling back to ${PREV_SHA:0:7}"
rolled=false
for s in "${SERVICES[@]}"; do
  if docker image inspect "rizehubhq-${s}:previous" >/dev/null 2>&1; then docker tag "rizehubhq-${s}:previous" "rizehubhq-${s}:latest"; rolled=true; fi
done
git reset --quiet --hard "$PREV_SHA"   # mounted agents/, brain/, config/ must match the old images
if $rolled; then
  dc up -d --no-build --remove-orphans
  if wait_healthy; then log "rolled back to ${PREV_SHA:0:7} (healthy). Investigate ${NEW_TAG} before deploying again."
  else log "rollback is ALSO unhealthy: check .env / Supabase / docker compose logs"; fi
else
  log "no previous images to roll back to (first deploy?)"
fi
exit 1
