#!/bin/sh
# RizeHub HQ Hermes container entrypoint (deploy/hermes/README.md).
#  1. copies the agent's config.yaml template (mounted read-only at /etc/hermes-hq/config.yaml) into $HERMES_HOME;
#     Hermes resolves its ${VAR} placeholders (HERMES_MODEL, HQ_MCP_URL, HQ_MCP_TOKEN) from this container's env
#  2. writes $HERMES_HOME/.env (mode 600) with the API server settings + the model provider key only
#  3. starts `hermes gateway` = the API server (no messaging platform tokens exist in this container)
set -eu

HERMES_HOME="${HERMES_HOME:-/data/hermes}"
: "${API_SERVER_KEY:?API_SERVER_KEY is empty: set HERMES_KEY_<AGENT> in the master .env and run scripts/split-env.mjs}"
: "${HQ_MCP_TOKEN:?HQ_MCP_TOKEN is empty: set HQ_MCP_TOKEN_<AGENT> in the master .env and run scripts/split-env.mjs}"
: "${HERMES_MODEL:?HERMES_MODEL is empty: set HERMES_MODEL (or HERMES_MODEL_<AGENT>) in the master .env}"
: "${HQ_MCP_URL:=http://hq-worker:4000/mcp}"
export HQ_MCP_URL

if [ ! -f /etc/hermes-hq/config.yaml ]; then
  echo "missing /etc/hermes-hq/config.yaml (mount deploy/hermes/<agent>/config.yaml)" >&2
  exit 1
fi

umask 077
mkdir -p "$HERMES_HOME"
cp /etc/hermes-hq/config.yaml "$HERMES_HOME/config.yaml"

{
  echo "API_SERVER_ENABLED=true"
  echo "API_SERVER_HOST=${API_SERVER_HOST:-0.0.0.0}"
  echo "API_SERVER_PORT=${API_SERVER_PORT:-8642}"
  echo "API_SERVER_KEY=${API_SERVER_KEY}"
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then echo "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}"; fi
  if [ -n "${OPENAI_API_KEY:-}" ]; then echo "OPENAI_API_KEY=${OPENAI_API_KEY}"; fi
} > "$HERMES_HOME/.env"
chmod 600 "$HERMES_HOME/.env"

# Never start messaging platforms: drop any platform token that could have leaked into the env.
unset TELEGRAM_BOT_TOKEN DISCORD_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN WHATSAPP_TOKEN 2>/dev/null || true

exec hermes gateway "$@"
