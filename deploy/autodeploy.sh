#!/usr/bin/env bash
# RizeHub HQ auto-deploy (pull model): the VPS deploys main by itself once GitHub CI passed for that exact commit.
# No SSH key in GitHub and nothing new that can log in: the server only reads the public GitHub API.
#
# Run every 2 minutes as the app user by deploy/systemd/rizehq-autodeploy.timer (install: deploy/systemd/README.md).
#   nothing new on origin/main            → exit quietly
#   CI still running / not started        → wait for the next tick
#   CI failed (or update.sh failed)       → logged once, that commit is skipped; the next green commit deploys
#   CI passed                             → deploy/update.sh with TARGET_SHA = that commit (build, health check, rollback)
#
# Pause:  touch /home/rizehq/rizehub-hq/.autodeploy-off   (resume: rm it)   · Logs: journalctl -u rizehq-autodeploy
# Migrations are applied by hand: apply them to Supabase BEFORE pushing the commit that needs them.
# Env: BRANCH (main), AUTODEPLOY_REPO (cracker17/rizehubhq), CI_WORKFLOW (CI).
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${BRANCH:-main}"
REPO="${AUTODEPLOY_REPO:-cracker17/rizehubhq}"
CI_WORKFLOW="${CI_WORKFLOW:-CI}"
cd "$APP_DIR"

log() { printf '[%s] autodeploy: %s\n' "$(date '+%F %T')" "$*"; }

[[ -e .autodeploy-off ]] && exit 0
exec 9>"${APP_DIR}/.autodeploy.lock"
flock -n 9 || exit 0   # a deploy is still running

git fetch --quiet origin "$BRANCH"
HEAD_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse "origin/${BRANCH}")"
[[ "$HEAD_SHA" == "$REMOTE_SHA" ]] && exit 0
if ! git merge-base --is-ancestor "$HEAD_SHA" "$REMOTE_SHA"; then
  log "origin/${BRANCH} (${REMOTE_SHA:0:7}) is not ahead of the deployed ${HEAD_SHA:0:7}; not touching it"; exit 0
fi
[[ "$(cat .autodeploy-failed 2>/dev/null || true)" == "$REMOTE_SHA" ]] && exit 0

# Latest run of the CI workflow for this exact commit (public repo: no token needed, 60 calls/hour is plenty).
STATUS="$(curl -fsS --max-time 20 -H 'Accept: application/vnd.github+json' \
  "https://api.github.com/repos/${REPO}/actions/runs?head_sha=${REMOTE_SHA}&event=push&per_page=30" |
  CI_WORKFLOW="$CI_WORKFLOW" python3 -c '
import json, os, sys
runs = [r for r in json.load(sys.stdin).get("workflow_runs", []) if r.get("name") == os.environ["CI_WORKFLOW"]]
r = max(runs, key=lambda r: r["created_at"]) if runs else None
print(r["status"], r["conclusion"]) if r else print("none")
')" || { log "GitHub API unreachable; will retry"; exit 0; }

case "$STATUS" in
  "completed success") ;;
  completed*)
    log "CI ${STATUS#completed } for ${REMOTE_SHA:0:7}: not deploying it (the next green commit will deploy)"
    echo "$REMOTE_SHA" > .autodeploy-failed; exit 0 ;;
  *) exit 0 ;;   # queued / in_progress / none yet
esac

log "CI passed for ${REMOTE_SHA:0:7}: deploying ${HEAD_SHA:0:7} → ${REMOTE_SHA:0:7}"
if TARGET_SHA="$REMOTE_SHA" bash deploy/update.sh; then
  rm -f .autodeploy-failed
  log "deployed ${REMOTE_SHA:0:7}"
else
  echo "$REMOTE_SHA" > .autodeploy-failed
  log "update.sh failed for ${REMOTE_SHA:0:7} (it restored the previous version); skipping this commit"
  exit 1
fi
