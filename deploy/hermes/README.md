# Hermes Agent runtime for RizeHub HQ

The Web Developer, Graphic Designer, Content Writer and Sales Agent (`runtime: hermes` in `agents/roster.yaml`) can
run their tasks on their own [Hermes Agent](https://hermes-agent.nousresearch.com/docs/) instance instead of the
worker's built-in AI SDK runner. The worker stays in charge: it claims the task, sends the same task prompt to that
agent's Hermes API server, and saves the final answer as the task output. COO and QA always run on the worker.

```
worker (hq-worker) ──POST /v1/chat/completions (Bearer HERMES_KEY_<AGENT>)──▶ hermes-<agent>:8642
        ▲                  X-Hermes-Session-Id = task id · X-Hermes-Session-Key = agent id
        └──── POST /mcp (Bearer HQ_MCP_TOKEN_<AGENT>) ◀── Hermes calls HQ tools (report_progress, submit_output, …)
```

- **One container per agent**, each with its own `HERMES_HOME` volume (memory, skills, sessions never shared).
- **API server only.** No Telegram/Discord/Slack platforms: no platform tokens exist in these containers.
- **No publish/send credentials in Hermes.** The containers hold only their API server key, their HQ MCP token and
  the model provider key. Client logins, RizeHub keys and platform tokens stay in the worker; Hermes reaches them only
  through HQ tools, and anything that publishes, sends, merges, deploys or spends becomes a CEO approval.
- **Locked down:** no published ports (private `hermes` network shared with the worker only), no Docker socket
  (local terminal backend), read-only root filesystem with `/tmp` as tmpfs, `cap_drop: ALL`, `no-new-privileges`,
  a `/workspace` volume for the agent's own files.
- **Fallback:** if an agent's Hermes is not configured, `/health` fails, or a run fails with down/timeout, the worker
  runs the task on the built-in runner and logs `Hermes unavailable for <agent>, ran on the built-in runner (<reason>)`
  (activity `hermes.fallback`). `HERMES_FALLBACK=off` re-queues the task instead (fails it if Hermes is not configured).

## Setup (VPS)

1. **Secrets in the master `.env`** (per agent you want on Hermes; `openssl rand -hex 32` for each):
   ```
   HERMES_URL_WEB_DEV=http://hermes-web-dev:8642
   HERMES_KEY_WEB_DEV=<random>        # becomes that container's API_SERVER_KEY
   HQ_MCP_TOKEN_WEB_DEV=<random>      # that container's token for the worker's /mcp endpoint
   HERMES_MODEL=claude-sonnet-…       # Anthropic model id for Hermes (HERMES_MODEL_WEB_DEV overrides per agent)
   ANTHROPIC_API_KEY=sk-ant-…         # Hermes uses the same provider key
   ```
   Same for `DESIGNER`, `WRITER`, `SALES`. Leave an agent's values empty to keep it on the built-in runner.
2. **Split:** `node scripts/split-env.mjs` writes `.env.hermes-<agent>` (mode 600) for every agent whose
   `HERMES_KEY_<AGENT>` and `HQ_MCP_TOKEN_<AGENT>` are set. Each file holds only `API_SERVER_KEY`, `HQ_MCP_TOKEN`,
   `HERMES_MODEL`, the model provider key(s) and `TZ`. The worker keeps `HERMES_URL_*`, `HERMES_KEY_*`, `HQ_MCP_TOKEN_*`.
3. **Build and start** (the services are opt-in, profile `hermes`):
   ```bash
   docker compose --profile hermes build hermes-web-dev      # all four share one image
   docker compose --profile hermes up -d
   docker compose up -d worker                               # picks up the new HERMES_*/HQ_MCP_* values
   ```
4. **Check:** `docker compose --profile hermes ps` shows the four `hermes-*` containers healthy; run a small task
   for that agent and look for `mcp.tool_call` rows (and no `hermes.fallback` row) in the activity log.

`deploy/update.sh` rebuilds only the default services. After changing `deploy/hermes/*` or the Hermes version, run
step 3 again.

## Files

| File | What |
|---|---|
| `Dockerfile` | Debian slim + Hermes via its `install.sh --non-interactive --skip-browser --skip-computer-use` (see the note in the file) |
| `entrypoint.sh` | Copies `<agent>/config.yaml` into `$HERMES_HOME`, writes `$HERMES_HOME/.env` (API server + provider key), runs `hermes gateway` |
| `<agent>/config.yaml` | Model (`provider: anthropic`, `default: ${HERMES_MODEL}`), `terminal.backend: local`, `mcp_servers.hq` → `${HQ_MCP_URL}` with `Bearer ${HQ_MCP_TOKEN}` |

The templates are the source of truth: they are copied on every start, so `hermes config set` inside a container
does not survive a restart. Edit the file in the repo instead.

## Not verified yet (check on the first build)

- **The image has not been built yet** (the dev sandbox has no Docker daemon). The Hermes docs give only the
  `install.sh` one-liner (no pip/uv package, no official image). Reading that script (github.com/NousResearch/hermes-agent,
  `scripts/install.sh`) shows `--dir` (code), `HERMES_RUNTIME_DIR` (uv + Python + tools) and the `hermes` launcher in
  `~/.local/bin`; the Dockerfile puts code and runtime under `/opt/hermes` so the volume only holds data, and fails the
  build if `hermes` is not on `PATH`.
- **Read-only root.** If Hermes writes outside `/data/hermes`, `/workspace` and `/tmp` at runtime (for example an
  on-demand `pm install` into `/opt/hermes/tools`), remove `read_only: true` from the `x-hermes` block in
  `docker-compose.yml` (keep everything else).
- **Egress.** The `hermes` network is not `internal` because Hermes must reach the model provider API over HTTPS.
  Nothing is published to the host; add an egress proxy/firewall rule if you want to limit outbound hosts.
- **Chat `model` field.** The worker sends `"model": "hermes-agent"`; Hermes uses the model from its config.yaml.
