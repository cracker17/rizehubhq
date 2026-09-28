# 10 · Deploy to your existing VPS — `hq.rizehub.ph`

Target: the existing Hostinger VPS (the same one running RizeHub), with the dashboard at **https://hq.rizehub.ph**, and the worker + bot running alongside RizeHub and the other sites on that server — without disturbing them.


## 0. Pre-flight on the existing VPS (do this first)

SSH in and check what's already there:
```bash
lsb_release -a                 # Ubuntu version
nproc && free -h && df -h      # CPU, RAM, disk
sudo ss -tlnp | grep -E ':80|:443'   # who owns ports 80/443 (nginx? apache? openlitespeed? a panel?)
docker -v || echo "no docker"
```

| Resource | Minimum free for RizeHub HQ |
|---|---|
| RAM | 3 GB free (Playwright/Chromium for QA is the heaviest part) |
| Disk | 15 GB free (images, workspaces, Docker layers) |
| CPU | 2 vCPU shared is OK to start |

If RAM is tight: set `MAX_PARALLEL_TASKS=1` and run QA browser checks one at a time, or upgrade the plan.

**Important:** whatever already serves ports 80/443 stays in charge. We run our apps on local ports and add a **reverse-proxy entry** for the new subdomain — we don't replace the existing web server.

## 1. DNS

At the DNS provider for `rizehub.ph` (Hostinger hPanel → DNS Zone, or Cloudflare if used):
```
Type: A    Name: agents    Value: <VPS public IP>    TTL: 300
```
Check: `dig +short hq.rizehub.ph` → returns the VPS IP.

## 2. Production Supabase
- Create a Supabase cloud project (region: Singapore for low latency from PH).
- `supabase link --project-ref <ref>` → `supabase db push` (applies migrations) → run `seed.sql` once.
- Create your CEO user in Supabase Auth, then `insert into ceo_users (user_id) select id from auth.users where email = '<your email>';`, and enable TOTP.
- Copy URL, anon key, service_role key.

## 3. Install Docker (if missing)
```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker
docker compose version
```

## 4. App user + code
```bash
sudo adduser --disabled-password rizehq
sudo usermod -aG docker rizehq
sudo -iu rizehq
git clone git@github.com:<you>/rizehub-hq.git && cd rizehub-hq
cp .env.example .env && chmod 600 .env && nano .env      # production values, PRODUCTION bot token
```

## 5. `docker-compose.yml`

```yaml
services:
  dashboard:
    build: { context: ., dockerfile: apps/dashboard/Dockerfile }
    env_file: .env
    ports: ["127.0.0.1:3100:3000"]        # only reachable via the reverse proxy
    restart: unless-stopped
    mem_limit: 512m

  worker:
    build: { context: ., dockerfile: apps/worker/Dockerfile }   # based on mcr.microsoft.com/playwright image
    container_name: hq-worker            # stable name RizeHub uses for webhooks: http://hq-worker:4000/hooks/rizehub
    env_file: .env
    networks: [default, rizehub-internal]
    volumes:
      - ./agents:/app/agents:ro
      - ./brain:/app/brain
      - workspaces:/app/workspaces
    restart: unless-stopped
    mem_limit: 2g

  bot:
    build: { context: ., dockerfile: apps/bot/Dockerfile }
    env_file: .env
    restart: unless-stopped
    mem_limit: 256m

volumes:
  workspaces:

networks:
  default: {}
  rizehub-internal:
    external: true
```
The `worker` joins `rizehub-internal` (it calls RizeHub and receives its webhooks on port 4000, never published publicly). Create the shared network once and attach RizeHub to it too:
```bash
docker network create rizehub-internal
# in RizeHub's docker-compose: add the same external network to the RizeHub app service,
# with a stable name, e.g. container_name: rizehub-app
docker exec hq-worker wget -qO- http://rizehub-app:8080/agent-api/v1/health   # should answer
```
If RizeHub runs outside Docker, bind its API to `127.0.0.1:8080` and use `extra_hosts: ["host.docker.internal:host-gateway"]` + `RIZEHUB_API_URL=http://host.docker.internal:8080/agent-api/v1` in the worker.

Make sure the public Nginx config for RizeHub **does not** expose `/agent-api/` (add `location /agent-api/ { return 404; }` to RizeHub's public server block).
Ports bind to `127.0.0.1` so nothing is exposed publicly except through the proxy.

```bash
docker compose up -d --build
docker compose ps
curl -I http://127.0.0.1:3100      # dashboard answers locally
```

## 6. Reverse proxy for `hq.rizehub.ph`

Pick the one matching what owns port 80/443 (from step 0).

### A) Nginx already running (most common)
`/etc/nginx/sites-available/hq.rizehub.ph`
```nginx
server {
  server_name hq.rizehub.ph;
  location / {
    proxy_pass http://127.0.0.1:3100;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/hq.rizehub.ph /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d hq.rizehub.ph
```

### B) A control panel (CyberPanel / aaPanel / Hostinger panel with OpenLiteSpeed/Apache)
Create the subdomain `hq.rizehub.ph` in the panel, issue SSL there, then add a **reverse proxy** rule to `http://127.0.0.1:3100` (panels have a "Reverse Proxy" or "Proxy" option per site). Don't hand-edit the panel's generated configs.

### C) Nothing on 80/443
Add a Caddy container:
```
hq.rizehub.ph {
  reverse_proxy dashboard:3000
}
```
Caddy obtains HTTPS automatically.

Open https://hq.rizehub.ph → login page.

## 7. Firewall & hardening
```bash
sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443
sudo ufw enable     # check existing sites still work!
```
- SSH keys only (`PasswordAuthentication no`), non-root `rizehq` user.
- Enable **Hostinger VPS snapshots/backups** before first deploy.
- Anthropic console: monthly spend limit set.

## 8. Updates
```bash
sudo -iu rizehq && cd rizehub-hq
git pull && docker compose up -d --build
docker image prune -f
```
Later: GitHub Action that SSHes in and runs the above on push to `main`.

## 9. Monitoring
- `docker compose logs -f worker` for live agent logs.
- Worker posts a heartbeat row every minute; bot alerts you if it's older than 5 min ("Worker down").
- Uptime ping (e.g. UptimeRobot free) on `https://hq.rizehub.ph/api/health`.

## Checklist
- [ ] Existing sites on the VPS still load after the proxy + firewall changes
- [ ] https://hq.rizehub.ph loads with valid SSL, login required
- [ ] Production bot responds only to you
- [ ] `/assign` test request flows end-to-end
- [ ] Worker restarts automatically after `docker compose restart worker` and after VPS reboot
- [ ] Snapshot taken
- [ ] Worker reaches RizeHub's `/agent-api/v1/health` on the private network; `https://<rizehub domain>/agent-api/v1/health` returns 404 from outside
- [ ] Production HQ uses production RizeHub keys; local HQ only ever uses staging keys
