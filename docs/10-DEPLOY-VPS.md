# 10 · Deploy to your existing VPS: `hq.rizehub.ph`

Target: the existing Hostinger VPS (the one already running RizeHub). The dashboard is served at **https://hq.rizehub.ph**, and the worker and bot run alongside RizeHub and the other sites without disturbing them. The database is a hosted **Supabase** project in Singapore.

Everything in this document is scripted in `deploy/`:

| File | What it is |
|---|---|
| `deploy/setup-vps.sh` | First-time setup (idempotent): app user, Docker, `rizehub-internal` network, clone, `.env` prompts + generated secrets, validation, `compose up`, checklist. Optional `--with-nginx --email` does the proxy + TLS |
| `deploy/update.sh` | Pull `main` → validate `.env` → build → `up -d` → health check → prune. **Rolls back** to the previous images and commit if health fails |
| `deploy/backup.sh` | Nightly `pg_dump` of the Supabase `public` schema, with rotation (cron) |
| `deploy/supabase-setup.md` | Production Supabase: project, `db push`, seed, CEO user, private `evidence` bucket, auth settings, MFA |
| `deploy/nginx/hq.rizehub.ph.conf` | nginx site → `127.0.0.1:3100` (certbot adds TLS) |
| `deploy/nginx/rizehub-block-agent-api.conf` | Snippet for **RizeHub's** public vhost: `/agent-api/*` → 404 |
| `deploy/Caddyfile` | Alternative proxy if nothing owns 80/443 |
| `.github/workflows/deploy.yml` | Optional auto-deploy after CI on `main` (off until `DEPLOY_ENABLED=true`) |
| `scripts/check-env.mjs` | `pnpm check:env [-- --production]`: per-service `.env` validation |

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
5. runs `check-env.mjs --production` inside a `node:22-alpine` container (no Node needed on the host)
6. runs `docker compose up -d --build`, waits for health, and prints the go-live checklist

Edit `.env` later with `sudo -iu rizehq nano ~/rizehub-hq/.env`, then `cd ~/rizehub-hq && docker compose up -d` (and optionally `docker run --rm -v $PWD:/app -w /app node:22-alpine node scripts/check-env.mjs --production`).

### What `docker-compose.yml` runs
| Service | Image | Ports | Notes |
|---|---|---|---|
| `dashboard` | `rizehubhq-dashboard` (Next.js standalone, `node:22-alpine`, user `node`) | `127.0.0.1:3100→3000` | healthcheck `/api/health`; `./agents` mounted read-only for the Agents page; `HQ_WORKER_URL=http://hq-worker:4000` |
| `worker` | `rizehubhq-worker` (`mcr.microsoft.com/playwright:v1.56.1-noble`, user `pwuser`) | none (4000 internal) | `container_name: hq-worker`; networks `default` + `rizehub-internal`; mounts `agents` (ro), `brain`, `config` (ro), named volume `workspaces`; `shm_size: 1gb`; healthcheck `/health` with `x-hq-secret` |
| `bot` | `rizehubhq-bot` (`node:22-alpine`, user `node`) | none | Telegram long polling |

All three have `restart: unless-stopped`, memory limits, `init: true`, and json-file log rotation (10 MB × 5). The worker's Playwright image tag **must match** `playwright-core` in `apps/worker/package.json`. Bump both together (`ARG PLAYWRIGHT_VERSION`).

`brain/` is mounted read-write, but the worker runs as uid 1001 (`pwuser`). If agents need to write into `brain/`, run `sudo chown -R 1001 /home/rizehq/rizehub-hq/brain`.

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
`update.sh` holds a lock, refuses local changes, fast-forwards `main`, warns about new migrations (run `supabase db push` first) and changed `.env.example`, validates `.env`, builds, tags the running images `:previous`, and runs `up -d`. It then waits until dashboard + worker are **healthy** and the bot is stable. If they are not, it re-tags `:previous` → `:latest`, resets the checkout to the previous commit (so mounted `agents/`, `brain/`, `config/` match), and restarts. On success it tags images with the commit and keeps the last 3, then prunes.

Automatic (optional): `.github/workflows/deploy.yml` runs `update.sh` over SSH after CI passes on `main`.
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

## Checklist
- [ ] Existing sites on the VPS still load after the proxy + firewall changes
- [ ] https://hq.rizehub.ph loads with valid SSL, login required; `/api/health` → ok
- [ ] `docker compose ps`: dashboard + worker `healthy`, bot `running`
- [ ] Production bot responds only to you
- [ ] `/assign` test request flows end-to-end (plan → approve → work → QA → your approval)
- [ ] Worker restarts automatically after `docker compose restart worker` and after a VPS reboot
- [ ] Snapshot taken; `deploy/backup.sh` ran once and is in cron; `VAULT_MASTER_KEY` saved offline
- [ ] Worker reaches RizeHub's `/agent-api/v1/health` on the private network; `https://<rizehub domain>/agent-api/v1/health` returns 404 from outside
- [ ] Production HQ uses production RizeHub keys; local HQ only ever uses staging keys
