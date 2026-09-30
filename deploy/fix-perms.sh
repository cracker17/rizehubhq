#!/usr/bin/env bash
# RizeHub HQ: repair file ownership for the worker's privilege split (docs/09 "Agent uid", docs/10). Idempotent.
#
#   deploy/fix-perms.sh        run by deploy/setup-vps.sh and deploy/update.sh; safe to run by hand any time
#
# The worker runs as root inside its container and starts every agent command as AGENT_UID (1001). So:
#   brain/                 host bind mount: owned by the host app user (the owner of this checkout). The worker keeps
#                          that owner on files it writes; this fixes files left by older images (uid 1001) so
#                          `git pull` / `git reset` in update.sh can always replace them.
#   workspaces volume      root:root 0755 at the top (one task cannot rename another task's folder); every task jail
#                          inside owned by AGENT_UID:AGENT_GID (the uid agent commands run as).
# Uses throwaway containers, so the app user (docker group) needs no sudo.
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OWNER_UID="${OWNER_UID:-$(stat -c %u "$APP_DIR")}"
OWNER_GID="${OWNER_GID:-$(stat -c %g "$APP_DIR")}"
AGENT_UID="${AGENT_UID:-1001}"
AGENT_GID="${AGENT_GID:-1001}"
IMAGE="${FIX_PERMS_IMAGE:-node:22-alpine}"
VOLUME="${WORKSPACES_VOLUME:-rizehubhq_workspaces}"

log() { printf '[fix-perms] %s\n' "$*"; }

if [[ -d "${APP_DIR}/brain" ]]; then
  docker run --rm -v "${APP_DIR}/brain:/brain" "$IMAGE" chown -R "${OWNER_UID}:${OWNER_GID}" /brain
  log "brain/ owned by ${OWNER_UID}:${OWNER_GID}"
fi

# Brain deploy key + pinned host keys (deploy/brain-setup.sh): read-only for the brain container's user (node, uid 1000);
# the directory stays the app user's (0711) so brain-setup.sh can replace known_hosts.
BRAIN_SECRETS="${APP_DIR}/secrets/brain"
BRAIN_UID="${BRAIN_UID:-1000}"
if [[ -f "${BRAIN_SECRETS}/brain_deploy_key" ]]; then
  chmod 711 "$BRAIN_SECRETS"
  # shellcheck disable=SC2016 # $1 is expanded by the container's sh, not here
  docker run --rm -v "${BRAIN_SECRETS}:/s" "$IMAGE" sh -c     'chown "$1:$1" /s/brain_deploy_key && chmod 0400 /s/brain_deploy_key && if [ -f /s/known_hosts ]; then chown "$1:$1" /s/known_hosts && chmod 0444 /s/known_hosts; fi'     sh "$BRAIN_UID"
  log "secrets/brain: deploy key readable by uid ${BRAIN_UID} only"
fi

if docker volume inspect "$VOLUME" >/dev/null 2>&1; then
  # shellcheck disable=SC2016 # $1/$2 are expanded by the container's sh, not here
  docker run --rm -v "${VOLUME}:/ws" "$IMAGE" sh -c \
    'chown root:root /ws && chmod 0755 /ws && find /ws -mindepth 1 -maxdepth 1 -exec chown -R "$1:$2" {} +' \
    sh "$AGENT_UID" "$AGENT_GID"
  log "workspaces volume ${VOLUME}: root 0755, task folders owned by ${AGENT_UID}:${AGENT_GID}"
else
  log "workspaces volume ${VOLUME} does not exist yet (created on first 'docker compose up')"
fi
