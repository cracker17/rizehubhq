# 10 · Deploy to your existing VPS: `hq.rizehub.ph`

Target: the existing Hostinger VPS (the one already running RizeHub). The dashboard is served at **https://hq.rizehub.ph**, and the worker and bot run alongside RizeHub and the other sites without disturbing them. The database is a hosted **Supabase** project in Singapore.

Everything in this document is scripted in `deploy/`:

| File | What it is |
|---|---|
| `deploy/setup-vps.sh` | First-time setup (idempotent): app user, Docker, `rizehub-internal` network, clone, `.env` prompts + generated secrets, validation, per-service env split, ownership fix, `compose up`, checklist. Optional `--with-nginx --email` does the proxy + TLS |
| `deploy/update.sh` | Pull `main` → validate `.env` → split it into `.env.dashboard` / `.env.bot` / `.env.worker` → check those → fix ownership → build → `up -d` → health check → prune. **Rolls back** to the previous images and commit if health fails |
| `deploy/fix-perms.sh` | Ownership for the worker's privilege split: `brain/` → the app user, workspaces volume → root at the top, task folders → agent uid 1001 |
| `deploy/backup.sh` | Nightly `pg_dump` of the Supabase `public` schema, with rotation (cron) |
| `deploy/supabase-setup.md` | Production Supabase: project, `db push`, seed, CEO user, private `evidence` bucket, auth settings, MFA |
| `deploy/nginx/hq.rizehub.ph.conf` | nginx site → `127.0.0.1:3100` (certbot adds TLS) |
| `deploy/nginx/rizehub-block-agent-api.conf` | Snippet for **RizeHub's** public vhost: `/agent-api/*` → 404 |
| `deploy/Caddyfile` | Alternative proxy if nothing owns 80/443 |
| `deploy/autodeploy.sh` + `deploy/systemd/` | Auto-deploy (pull): the VPS deploys `main` once CI passed for that commit |
| `.github/workflows/deploy.yml` | Alternative push-style auto-deploy over SSH (off until `DEPLOY_ENABLED=true`; not used) |
| `scripts/check-env.mjs` | `pnpm check:env [-- --production]`: per-service `.env` validation; `-- --split` checks the three per-service files and **fails** if a server secret (service-role key, vault key) is in `.env.dashboard` |
| `scripts/split-env.mjs` | Master `.env` → `.env.dashboard`, `.env.bot`, `.env.worker` (mode 600), each with only that container's variables |
| `scripts/check-deploy.mjs` | `pnpm check:deploy [-- --skip-db --skip-docker]`: everything checkable without a VPS (env schema ↔ `.env.example` ↔ compose/Dockerfile env, `docker compose config`, proxy domains, `bash -n` + shellcheck, migrations in PGlite, Dockerfile COPY paths / `.dockerignore`, Playwright version, health routes). Docker and shellcheck checks are skipped when not installed |
| `apps/worker/src/eval/` | `pnpm eval:roles [-- --role <id> --live]`: M10 role harness (3 fixture tasks per role through the real runner + QA). Offline = scripted model (CI); `--live` = configured providers. Scorecards in `reports/eval/` (gitignored) |

## Architecture on the VPS

```
Internet ──443──> nginx/Caddy/panel (already on the VPS) ──> 127.0.0.1:3100 ──> dashboard container (:3000)
                                                                                  │ http://hq-worker:4000 (x-hq-secret)
Browser ──wss──> Supabase Realtime (direct, NOT through the VPS proxy)             ▼
                                                            worker container "hq-worker" (:4000, no published port)
                                                                   │  networks: default + rizehub-internal
RizeHub app container ── http://hq-worker:4000/hooks/rizehub ──────┘
worker ── http://rizehub-app:8080/agent-api/v1 ──> RizeHub (private; /agent-api is 404 publicly)
bot container ── Telegram long polling (outbound only)
all three ── HTTPS ──> Supabase (ap-southeast-1)
```
Because the browser talks to Supabase Realtime directly, **the proxy does not need websocket configuration** (the nginx file includes harmless Upgrade headers anyway).

## 0. Pre-flight on the existing VPS (do this first)
```bash
lsb_release -a                       # Ubuntu version
nproc && free -h && df -h            # CPU, RAM, disk
sudo ss -tlnp | grep -E ':80 |:443 ' # who owns ports 80/443 (nginx? apache/openlitespeed? a panel?)
docker -v || echo "no docker"
```

| Resource | Minimum free for RizeHub HQ |
|---|---|
| RAM | 3 GB (limits: worker 2 GB, dashboard 512 MB, bot 256 MB). Chromium for QA is the heavy part |
| Disk | 15 GB (the worker image is roughly 2–3 GB with Chromium + ffmpeg; plus build cache and workspaces) |
| CPU | 2 vCPU shared is OK to start |

If RAM is tight: `MAX_PARALLEL_TASKS=1` in `.env`, or upgrade the plan. **Take a Hostinger snapshot before you start.**

Whatever already serves ports 80/443 stays in charge. HQ only adds a reverse-proxy entry for the new subdomain.

## 1. DNS
At the DNS provider for `rizehub.ph` (Hostinger hPanel → DNS Zone, or Cloudflare):
```
Type: A    Name: hq    Value: <VPS public IPv4>    TTL: 300
```
Check: `dig +short hq.rizehub.ph` returns the VPS IP. (Cloudflare: keep it **DNS only / grey cloud** until certbot has issued the certificate.)

## 2. Production Supabase
Follow **`deploy/supabase-setup.md`**: create the project (Singapore), `supabase link` → `supabase db push`, seed once, disable sign-ups, create your CEO user and its `ceo_users` row, create the private `evidence` bucket, and copy the URL and keys.

## 3. Get the code onto the VPS
Either way works with `setup-vps.sh`:
- **GitHub (recommended):** `--repo git@github.com:<you>/rizehub-hq.git`. The script creates a deploy key for the `rizehq` user and prints it; add it as a **read-only Deploy key** in the repo settings.
- **No GitHub yet:** make a bundle on your laptop with `git bundle create rizehub-hq.bundle --all`, then `scp` it to the VPS and pass `--repo /root/rizehub-hq.bundle`.

## 4. Run the setup script
```bash
# as root (or with sudo) on the VPS, from any copy of the repo or after downloading the script:
curl -fsSLO https://raw.githubusercontent.com/<you>/rizehub-hq/main/deploy/setup-vps.sh   # or scp it
sudo bash setup-vps.sh --repo git@github.com:<you>/rizehub-hq.git
#   add --with-nginx --email you@example.com   if nginx owns :80/:443 (step 5A done for you)
```
It is safe to re-run at any time. It:
1. creates the `rizehq` user (docker group) and installs Docker if missing
2. creates the `rizehub-internal` network
3. clones to `/home/rizehq/rizehub-hq` (or fast-forwards it)
4. creates `.env` (mode 600), **generates** `HQ_INTERNAL_SECRET`, `RIZEHUB_WEBHOOK_SECRET`, `VAULT_MASTER_KEY` (only if empty; copy the vault key to your password manager), sets `DASHBOARD_URL=https://hq.rizehub.ph`, and prompts for the Supabase keys, Telegram token and id, and free AI keys
5. runs `check-env.mjs --production` inside a `node:22-alpine` container (no Node needed on the host), then **splits** `.env` into `.env.dashboard`, `.env.bot` and `.env.worker` (`scripts/split-env.mjs`) and checks them with `--split --production`
6. runs `deploy/fix-perms.sh`, then `docker compose up -d --build`, waits for health, and prints the go-live checklist

Edit `.env` later with `sudo -iu rizehq nano ~/rizehub-hq/.env`, then `cd ~/rizehub-hq && ./deploy/update.sh --force` (validates, re-splits and restarts). Never edit the three per-service files by hand: they are regenerated from `.env`.

### Which container gets which variables
The master `.env` stays on the host (mode 600; `deploy/backup.sh` reads `SUPABASE_DB_URL` from it). Containers get only their own file:

| File | Variables | Never contains |
|---|---|---|
| `.env.dashboard` | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `HQ_WORKER_URL`, `HQ_INTERNAL_SECRET`, `DASHBOARD_URL`, `AGENTS_DIR` | service-role key, vault key, AI/platform keys, Telegram token (the dashboard has no code path that needs the service-role key: its server actions forward vault writes to the worker) |
| `.env.bot` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_*`, `DASHBOARD_URL`, `MONTHLY_BUDGET_USD`, `BOT_POLL_MS`, `TZ` | vault key, AI/platform keys, `HQ_INTERNAL_SECRET` |
| `.env.worker` | everything else the worker reads + unknown names (per-client tokens like `SHOPIFY_TOKEN_<SLUG>`) | Telegram token, `SUPABASE_DB_URL`, anon key |

`pnpm check:env -- --split --production` (run by both scripts) fails the deploy if a file holds another service's secret.

### What `docker-compose.yml` runs
| Service | Image | Ports | Notes |
|---|---|---|---|
| `dashboard` | `rizehubhq-dashboard` (Next.js standalone, `node:22-alpine`, user `node`) | `127.0.0.1:3100→3000` | healthcheck `/api/health`; `./agents` mounted read-only for the Agents page; `HQ_WORKER_URL=http://hq-worker:4000` |
| `worker` | `rizehubhq-worker` (`mcr.microsoft.com/playwright:v1.56.1-noble`, root **inside the container**, agent commands as uid 1001) | none (4000 internal) | `container_name: hq-worker`; networks `default` + `rizehub-internal`; mounts `agents` (ro), `brain`, `config` (ro), named volume `workspaces`; `shm_size: 1gb`; `cap_drop: ALL` + `CHOWN DAC_OVERRIDE FOWNER SETUID SETGID KILL`, `no-new-privileges`; healthcheck `/health` with `x-hq-secret` |
| `bot` | `rizehubhq-bot` (`node:22-alpine`, user `node`) | none | Telegram long polling |

All three have `restart: unless-stopped`, memory limits, `init: true`, and json-file log rotation (10 MB × 5). The worker's Playwright image tag **must match** `playwright-core` in `apps/worker/package.json`. Bump both together (`ARG PLAYWRIGHT_VERSION`).

**Why the worker is root in its container.** Every agent shell command (`bash_sandboxed`, and git/npm the dev tools start for agents) runs as the unprivileged `AGENT_UID` 1001, while the worker, which holds every secret in its environment, runs as uid 0. The kernel only lets a process read `/proc/<pid>/environ` of another process with the same uid (or with `CAP_SYS_PTRACE`, which Docker never grants), so agent code cannot read the worker's keys. Only root can start children under another uid; everything else root could do is dropped (`cap_drop: ALL`, only the six capabilities above, `no-new-privileges`). In production the shell refuses to run at all if this privilege drop is not effective and `DEV_SANDBOX_PREFIX` is empty (the worker logs a `SECURITY` warning at startup). Details: docs/09 "Agent uid".

**Ownership.** `brain/` is mounted read-write and stays owned by `rizehq`: files the worker writes there (brain_write) take `brain/`'s owner, so `git pull`/`git reset` keep working. Task workspaces live in the `workspaces` volume: the top folder is `root:root 0755`, each task folder is owned by uid 1001. `deploy/fix-perms.sh` (run by `setup-vps.sh` and every `update.sh`) repairs both, e.g. after upgrading from an image that ran as `pwuser`.

## 5. Reverse proxy for `hq.rizehub.ph`
Pick the one that matches whatever owns port 80/443 (step 0).

### A) nginx already running (most common)
```bash
sudo cp deploy/nginx/hq.rizehub.ph.conf /etc/nginx/sites-available/hq.rizehub.ph
sudo ln -sf /etc/nginx/sites-available/hq.rizehub.ph /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d hq.rizehub.ph --redirect -m you@example.com --agree-tos
sudo certbot renew --dry-run          # auto-renewal works
```
(`setup-vps.sh --with-nginx --email …` does exactly this.) After HTTPS works, you may uncomment the HSTS header in the site file.

### B) Control panel (CyberPanel / aaPanel / Hostinger panel with OpenLiteSpeed/Apache)
Create the subdomain `hq.rizehub.ph` in the panel, issue SSL there, and add a **reverse proxy** rule to `http://127.0.0.1:3100`. Don't hand-edit the panel's generated configs.

### C) Nothing on 80/443
Use Caddy on the host: `sudo apt install -y caddy && sudo cp deploy/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy`. Caddy gets the certificate automatically.

Open https://hq.rizehub.ph and you should see the login page. https://hq.rizehub.ph/api/health returns `{"ok":true,…}`.

## 6. Connect RizeHub (docs/12)
- Add the external network `rizehub-internal` to RizeHub's compose file (app service, stable `container_name: rizehub-app`), then `docker compose up -d` there.
- In RizeHub's **public** nginx server block(s), add `include /etc/nginx/snippets/rizehub-block-agent-api.conf;` (copy from `deploy/nginx/`). Check that `curl -s -o /dev/null -w '%{http_code}' https://<rizehub domain>/agent-api/v1/health` returns `404`.
- `docker exec hq-worker node -e "fetch('http://rizehub-app:8080/agent-api/v1/health').then(r=>console.log(r.status))"` → `200`.
- Then set `RIZEHUB_API_URL=http://rizehub-app:8080/agent-api/v1` and the four `RIZEHUB_KEY_*` values in `.env`. The webhook URL for RizeHub is `http://hq-worker:4000/hooks/rizehub`, signed with `RIZEHUB_WEBHOOK_SECRET`. Until RizeHub exposes the API, leave `RIZEHUB_API_URL=mock`.
- RizeHub not in Docker? Bind its API to `127.0.0.1:8080`, add `extra_hosts: ["host.docker.internal:host-gateway"]` to the worker, and use `RIZEHUB_API_URL=http://host.docker.internal:8080/agent-api/v1`.

## 6b. Hermes Agent runtime (optional)
The Web Developer, Graphic Designer, Content Writer and Sales Agent can run on their own Hermes Agent containers
(docs/05 "Hermes runtime"). Without them those agents simply run on the worker's built-in runner (and each task logs
`hermes.fallback`). Full steps: **`deploy/hermes/README.md`**. In short:
1. In the master `.env`, per agent: `HERMES_URL_<AGENT>=http://hermes-<agent>:8642`, `HERMES_KEY_<AGENT>` and
   `HQ_MCP_TOKEN_<AGENT>` (`openssl rand -hex 32` each), plus `HERMES_MODEL` (Anthropic model id) and `ANTHROPIC_API_KEY`.
2. `node scripts/split-env.mjs` → also writes `.env.hermes-<agent>` (mode 600: API server key, MCP token, model id,
   provider key, TZ; nothing else) for every agent with a key and token.
3. `docker compose --profile hermes up -d --build` then `docker compose up -d worker`.

| Service | Image | Ports | Notes |
|---|---|---|---|
| `hermes-web-dev`, `hermes-designer`, `hermes-writer`, `hermes-sales` | `rizehubhq-hermes` (`deploy/hermes/Dockerfile`, Debian slim + Hermes install.sh, user 10001) | none (8642 on the private `hermes` network) | profile `hermes` (opt-in); own volumes `hermes-<agent>-home` (HERMES_HOME) + `hermes-<agent>-work` (`/workspace`); `deploy/hermes/<agent>/config.yaml` mounted read-only; API server only, no messaging platforms, local terminal backend, no Docker socket; `read_only`, `cap_drop: ALL`, `no-new-privileges`, 1 GB; healthcheck `/health` |

The worker joins the `hermes` network and serves `POST /mcp` (Bearer `HQ_MCP_TOKEN_<AGENT>`) there; that path is for
Hermes only and is never proxied publicly. RAM: budget about 1 GB more per Hermes container you start.
`deploy/update.sh` does not rebuild the Hermes profile: re-run step 3 after changing `deploy/hermes/`.

## 6c. Claude Agent SDK runtime (optional, off by default)
An agent with `runtime: claude` runs on the Claude Agent SDK inside the **worker container** (docs/05 "Claude runtime");
no extra container. Nothing to deploy beyond the normal worker image, which now carries the SDK's native Claude Code
binary (`@anthropic-ai/claude-agent-sdk-linux-x64`, glibc; the image is Ubuntu 24.04, so it runs as is; the Dockerfile drops
the unused musl build): expect the worker image to grow by about 240 MB. Each running Claude task is one extra Claude Code
process (a few hundred MB RAM): with `MAX_PARALLEL_TASKS=2` plus Chromium, watch the worker's `mem_limit: 2g` and raise it
if you run Claude tasks in parallel. It calls `api.anthropic.com` directly from the worker and its own `/mcp` over
127.0.0.1 (no new network or port). To turn it on for one agent: `.env.worker` `CLAUDE_RUNTIME_ENABLED=true`,
`ANTHROPIC_API_KEY`, `MONTHLY_BUDGET_USD` > 0, then the steps in docs/05 "Turning it on for one agent", then
`docker compose up -d worker`.

## 7. Firewall & hardening
```bash
sudo ufw status                        # if already active, just make sure 80/443/OpenSSH are allowed
sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443
sudo ufw enable                        # only if it was off; check existing sites still work
```
Docker publishes only `127.0.0.1:3100`, so nothing of HQ is reachable except through the proxy (Docker bypasses ufw for published ports, which is exactly why they are loopback-only).
- SSH keys only (`PasswordAuthentication no`), non-root `rizehq` user.
- Hostinger VPS snapshots on; monthly spend limits in the Anthropic/OpenAI consoles once you use paid models.

## 8. Updates
Manual:
```bash
sudo -iu rizehq && cd rizehub-hq && ./deploy/update.sh
```
`update.sh` holds a lock, refuses local changes, fast-forwards `main`, warns about new migrations (run `supabase db push` first) and changed `.env.example`, validates `.env`, re-splits it into the per-service files and checks them, runs `fix-perms.sh`, builds, tags the running images `:previous`, and runs `up -d`. It then waits until dashboard + worker are **healthy** and the bot is stable. If they are not, it re-tags `:previous` → `:latest`, resets the checkout to the previous commit (so mounted `agents/`, `brain/`, `config/` match), and restarts. On success it tags images with the commit and keeps the last 3, then prunes.

Automatic (in use since 2026-09-29): **pull model**. A systemd timer on the VPS runs `deploy/autodeploy.sh` every
2 minutes; it deploys a new `main` commit only after the GitHub **CI** workflow passed for that exact commit
(`update.sh` with `TARGET_SHA`), and skips a commit whose CI or deploy failed. No SSH key or secret lives in GitHub.
Install, pause, logs: `deploy/systemd/README.md`. Apply new migrations *before* pushing the commit that needs them.

Alternative (off, don't enable both): `.github/workflows/deploy.yml` runs `update.sh` over SSH after CI passes on `main`.
1. On the VPS: `sudo -iu rizehq ssh-keygen -t ed25519 -f ~/.ssh/gha -N '' && cat ~/.ssh/gha.pub >> ~/.ssh/authorized_keys`
2. GitHub → Settings → Secrets and variables → Actions → **Secrets**: `VPS_HOST`, `VPS_USER=rizehq`, `VPS_SSH_KEY` (contents of `~/.ssh/gha`), optional `VPS_PORT`, `VPS_KNOWN_HOSTS` (`ssh-keyscan -t ed25519 <host>`).
3. **Variables**: `DEPLOY_ENABLED=true` (and `VPS_APP_DIR` if not `/home/rizehq/rizehub-hq`).

## 9. Backups
```bash
# SUPABASE_DB_URL (Session pooler string) in .env, then as rizehq:
./deploy/backup.sh                         # test once
crontab -e                                 # 17 3 * * * /home/rizehq/rizehub-hq/deploy/backup.sh >> /home/rizehq/backup.log 2>&1
```
Dumps go to `~/backups/rizehubhq` (`BACKUP_DIR`) and are kept `BACKUP_KEEP_DAYS` (14). Copy them off the VPS too. `VAULT_MASTER_KEY` lives only in `.env` and your password manager.

## 10. Monitoring
- `docker compose ps` (health column), `docker compose logs -f worker`.
- Worker heartbeat: the bot alerts you if the worker stops reporting.
- Uptime ping (e.g. UptimeRobot free) on `https://hq.rizehub.ph/api/health`.

## Go-live runbook (CEO, once the keys and the VPS exist)

Follow it top to bottom; each step says how you know it worked. Sections above have the detail. The README "Go-live checklist" is the short version of the same steps.

**Before you touch the VPS (on your laptop)**
1. **Offline readiness is green.** `pnpm install` → `pnpm check:deploy` must end with `0 failed` (env schema + `.env.example`, `docker compose config`, proxy domains = `hq.rizehub.ph` → `127.0.0.1:3100`, deploy scripts `bash -n` + shellcheck, migrations in PGlite, Dockerfile paths, Playwright version). `pnpm eval:roles` (offline role harness) must say `All tasks passed.` CI runs both on every push.
2. **Code is on GitHub** (private repo), or you have a `git bundle` (step 3 above).
3. **AI keys work (M10 pre-check, no VPS needed).** Put the free keys in your local `.env` (`GOOGLE_GENERATIVE_AI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`; `MODEL_PROFILE=free`, `MONTHLY_BUDGET_USD=0`), then `pnpm eval:roles -- --live --role writer`. It runs the role's 3 sample tasks through the real runner + QA with the configured models (in-memory database, mock RizeHub, nothing is sent or published) and writes `reports/eval/latest-live.md` (+ `.json`). A missing key stops it with exit code 2 and names the variable. Repeat per role (`coo`, `web-dev`, `designer`, `writer`, `sales`, `qa-lead`); a role is ready when its row says `3/3 … yes`. If a role fails, tune `agents/<role>.md` / its SOP and re-run: the scorecards are timestamped, so you can compare runs.

**Accounts and DNS**
4. **Snapshot + pre-flight.** Hostinger snapshot, then the step 0 commands on the VPS. Write down who owns ports 80/443 (decides 5A/5B/5C), free RAM ≥ 3 GB, free disk ≥ 15 GB.
5. **DNS.** A record `hq` → VPS IP (step 1). Done when `dig +short hq.rizehub.ph` prints the VPS IP.
6. **Production Supabase** (Singapore), `deploy/supabase-setup.md` §1–4 and §6: `supabase link` → `supabase db push` → seed once → sign-ups off → private `evidence` bucket. Copy the URL, anon key and service-role key into your password manager.
7. **Production Telegram bot** from @BotFather (keep the test bot for local work) and your numeric id from @userinfobot.

**On the VPS**
8. **Setup script** (step 4): `sudo bash setup-vps.sh --repo git@github.com:<you>/rizehub-hq.git [--with-nginx --email you@example.com]`. Add the deploy key it prints, answer the prompts (Supabase URL/keys, bot token, Telegram id, AI keys). Done when `check-env` shows `0 error(s)` for `--production` and for `--split --production`, and the script ends with healthy containers. **Save `VAULT_MASTER_KEY` in your password manager now.**
9. **Proxy + TLS** (step 5 A, B or C). Done when https://hq.rizehub.ph/api/health returns `{"ok":true,…}` with a valid certificate, and your other sites on the VPS still load.
10. **Firewall** (step 7): OpenSSH, 80, 443 allowed; SSH keys only.
11. **CEO login.** `deploy/supabase-setup.md` §5 (auth user + `ceo_users` row, MFA). Done when you log in at https://hq.rizehub.ph and see the 6 agents.
12. **Bot.** `/status` to the production bot answers you, and only you.
13. **End-to-end.** `/assign Write a 600-word blog post about Shopify speed for Madam Muse` → plan in Approvals → approve → agent works → QA → deliverable waits for you → approve. Check the cost shows on `/costs`.
14. **Resilience.** `docker compose restart worker`, then reboot the VPS: `docker compose ps` shows dashboard + worker `healthy` and bot `running` both times.
15. **Backups** (step 9): `SUPABASE_DB_URL` in `.env`, `./deploy/backup.sh` once, cron line added, one dump copied off the VPS.
16. **Monitoring** (step 10): UptimeRobot (or similar) on `https://hq.rizehub.ph/api/health`.

**Later / optional**
17. **RizeHub link** when RizeHub exposes `/agent-api/v1` (step 6): join `rizehub-internal`, block `/agent-api` publicly, set `RIZEHUB_API_URL` + the four keys. Until then `RIZEHUB_API_URL=mock`.
18. **Hermes runtime** (step 6b) and **auto-deploy** (step 8) when you want them.
19. **M11 done** when the Checklist below is all ticked and HQ has had one week of real use. Then **M10**: per role, one at a time, 3 real client tasks with QA ≥ 85 (the dashboard shows each task's QA score); `pnpm eval:roles -- --live --role <role>` stays the quick re-check after you edit a role file or switch `MODEL_PROFILE`.

## Checklist
- [ ] `pnpm check:deploy` 0 failed and `pnpm eval:roles` all passed on the commit you deploy
- [ ] Existing sites on the VPS still load after the proxy + firewall changes
- [ ] https://hq.rizehub.ph loads with valid SSL, login required; `/api/health` → ok
- [ ] `docker compose ps`: dashboard + worker `healthy`, bot `running`
- [ ] Production bot responds only to you
- [ ] `/assign` test request flows end-to-end (plan → approve → work → QA → your approval)
- [ ] Worker restarts automatically after `docker compose restart worker` and after a VPS reboot
- [ ] Snapshot taken; `deploy/backup.sh` ran once and is in cron; `VAULT_MASTER_KEY` saved offline
- [ ] Worker reaches RizeHub's `/agent-api/v1/health` on the private network; `https://<rizehub domain>/agent-api/v1/health` returns 404 from outside
- [ ] Production HQ uses production RizeHub keys; local HQ only ever uses staging keys
