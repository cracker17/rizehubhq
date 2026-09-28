#!/usr/bin/env bash
# RizeHub HQ: nightly logical backup of the Supabase database with rotation. Run as the app user.
#
#   deploy/backup.sh                    reads SUPABASE_DB_URL (+ BACKUP_DIR, BACKUP_KEEP_DAYS) from .env
#   crontab -e  →  17 3 * * * /home/rizehq/rizehub-hq/deploy/backup.sh >> /home/rizehq/backup.log 2>&1
#
# Produces <BACKUP_DIR>/rizehubhq-YYYYmmdd-HHMMSS.dump (pg_dump custom format of the `public` schema: all HQ
# tables, functions, RLS policies and data; vault secrets stay encrypted) plus a small data-only dump of auth.users
# for reference. pg_dump runs in the postgres:17 image, so no client install is needed and versions match.
# Supabase-managed schemas (auth, storage, realtime) are NOT fully restorable from this: storage objects
# (QA evidence) and logins are covered by Supabase's own backups / recreating the CEO user.
#
# Restore into a fresh project (after `supabase db push` created the schema, or into an empty db without it):
#   docker run --rm -i -e DBURL postgres:17-alpine sh -c 'pg_restore --clean --if-exists --no-owner --no-privileges -d "$DBURL"' < file.dump
# Keep a copy OFF the VPS too (e.g. rclone to Google Drive), and remember: VAULT_MASTER_KEY is not in the dump.
set -Eeuo pipefail
umask 077

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${APP_DIR}/.env}"

env_get() { [[ -f "$ENV_FILE" ]] && awk -F= -v k="$1" '$1==k { sub(/^[^=]*=/, ""); sub(/[ \t]+#.*$/, ""); gsub(/^["\x27]|["\x27]$/, ""); print; exit }' "$ENV_FILE"; }
DBURL="${SUPABASE_DB_URL:-$(env_get SUPABASE_DB_URL || true)}"
BACKUP_DIR="${BACKUP_DIR:-$(env_get BACKUP_DIR || true)}"
BACKUP_DIR="${BACKUP_DIR:-${HOME}/backups/rizehubhq}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-$(env_get BACKUP_KEEP_DAYS || true)}"
KEEP_DAYS="${KEEP_DAYS:-14}"
PG_IMAGE="${PG_IMAGE:-postgres:17-alpine}"

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
[[ -n "$DBURL" ]] || { log "SUPABASE_DB_URL is not set (in ${ENV_FILE} or the environment)"; exit 1; }
[[ "$KEEP_DAYS" =~ ^[0-9]+$ ]] || { log "BACKUP_KEEP_DAYS must be a number"; exit 1; }
mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${BACKUP_DIR}/rizehubhq-${STAMP}.dump"
AUTH_OUT="${BACKUP_DIR}/rizehubhq-${STAMP}.auth-users.sql.gz"
TMP="${OUT}.partial"
trap 'rm -f "$TMP" "${AUTH_OUT}.partial"' EXIT

log "pg_dump → ${OUT}"
# The connection string goes in through the environment, not argv (keeps the password out of `ps`).
DBURL="$DBURL" docker run --rm -e DBURL "$PG_IMAGE" \
  sh -c 'pg_dump --dbname="$DBURL" --format=custom --compress=9 --schema=public --no-owner --no-privileges' > "$TMP"
[[ -s "$TMP" ]] || { log "empty dump"; exit 1; }
mv "$TMP" "$OUT"

if DBURL="$DBURL" docker run --rm -e DBURL "$PG_IMAGE" \
     sh -c 'pg_dump --dbname="$DBURL" --data-only --table=auth.users --column-inserts' 2>/dev/null | gzip -9 > "${AUTH_OUT}.partial"; then
  mv "${AUTH_OUT}.partial" "$AUTH_OUT"
else
  log "note: auth.users dump skipped (not critical)"
fi

# Sanity: the archive must list HQ tables.
TOC="$(docker run --rm -i "$PG_IMAGE" pg_restore --list < "$OUT" || true)"
if ! grep -q 'TABLE public agents' <<<"$TOC"; then
  log "WARNING: dump does not list public.agents: check it by hand"
fi

log "done: $(du -h "$OUT" | cut -f1). Removing backups older than ${KEEP_DAYS} days"
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'rizehubhq-*' -mtime +"$KEEP_DAYS" -print -delete
