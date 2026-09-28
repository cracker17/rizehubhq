# RizeHub HQ

The AI virtual office for **RizeHub**: a team of 6 AI agents (COO, Web Developer, Graphic Designer, Content Writer, Sales Agent, QA) you command with one message, a QA agent that checks every deliverable, and an isometric office where you watch them work and approve everything.

Live target: **https://hq.rizehub.ph** (Hostinger VPS, next to the RizeHub app) + a hosted Supabase project (Singapore).

## What's in here

| Path | What |
|---|---|
| `docs/` | The full build spec (00 to 14). Start with `docs/00-README.md` |
| `apps/dashboard` | Next.js dashboard (the office, approvals, reports, vault, leads, jobs) |
| `apps/worker` | The AI team runtime: scheduler, model router (free / hybrid / Claude / OpenAI), agents, tools, QA |
| `apps/bot` | Telegram bot: `/assign`, `/status`, approvals |
| `packages/shared` | Shared status enums + schemas (plan, QA verdict) |
| `agents/` | 6 role files (coo, web-dev, designer, writer, sales, qa-lead) + `roster.yaml` (who does which work type) |
| `brain/` | Company knowledge: SOPs and QA checklists for all 44 work types, playbooks, brand voice, career files, pricing template |
| `config/models.yaml` | Which AI model each role uses, per profile |
| `supabase/` | Database migrations + seed |
| `rizehub-agent-api/` | Reference kit for the RizeHub side of the Agent API (OpenAPI, auth middleware, webhook signer) |
| `deploy/` | Production kit: `setup-vps.sh`, `update.sh` (auto-rollback), `backup.sh`, nginx/Caddy configs, `supabase-setup.md` |
| `scripts/check-env.mjs` | `pnpm check:env`: validates `.env` per service; `-- --split` validates the per-service production files |
| `scripts/split-env.mjs` | `.env` → `.env.dashboard`, `.env.bot`, `.env.worker` (production: one env file per container) |

## Run it locally

Requirements: Node 22, pnpm 9, Docker Desktop, Supabase CLI.

```bash
pnpm install
cp .env.example .env            # fill in keys (free: Gemini, Groq, OpenRouter)
pnpm check:env                  # tells you what is missing, per service
supabase start                  # local database (Docker)
supabase db reset               # applies migrations + seed (6 agents)
pnpm dev                        # dashboard on http://localhost:3000, worker, bot
```
Then create your login in Supabase Studio (Authentication → Add user) and run
`insert into ceo_users (user_id) select id from auth.users where email = '<your email>';`

Without Supabase env the dashboard runs in **DEMO** mode (mock data), which is handy for UI work.

## Checks

```bash
pnpm typecheck        # all packages
pnpm test             # worker, bot, dashboard office logic
pnpm db:test          # migrations + seed + queue functions + security rules, in-memory Postgres
pnpm check:roles      # every agent file valid; every work type has an SOP + QA checklist
pnpm check:env        # your .env; `-- --production` for the VPS rules, `-- --example` for the template
```
CI runs all of these on every push, plus the `rizehub-agent-api` tests, shellcheck of `deploy/*.sh`, `docker compose config`, and builds of the three production images (dashboard and bot are smoke-tested).

## Status

"Built" = code complete and tested **offline** (unit tests, in-memory Postgres, mock RizeHub). Nothing has run on live keys, the hosted Supabase or the VPS yet. Details are in `docs/11-ROADMAP.md`.

| Milestone | State |
|---|---|
| M0 Foundation (monorepo, config, Docker, CI) | ✅ built, tested offline |
| M1 Database (schema, queue, RLS, Client Vault tables, seed) | ✅ built, tested offline |
| M2 Dashboard shell · M3 Live data · M4 Intake (`/assign`) | ✅ built, tested offline |
| M5 COO planning · M6 Specialist + QA loop · M7 Reports | ✅ built, tested offline |
| M8 Virtual Office | ✅ built, tested offline |
| M9a Client Vault · M9 Dev agents + connections | ✅ built, tested offline |
| M9b RizeHub Agent API · M9c Onboarding automation | ✅ built, tested offline against the mock |
| M11 Deploy kit (`deploy/`, Dockerfiles, compose, CI, `check:env`) | 🟡 ready; **go-live pending** (checklist below) |
| M10 Real-task tuning per role | ⏳ after go-live: 3 real tasks with QA ≥ 85 per role |
| M12 Hardening (TOTP in dashboard, auto-approve rules, cost dashboards…) | ⏳ |

## Go-live checklist

The exact steps, in order. Full detail: `docs/10-DEPLOY-VPS.md` ("Go-live runbook") and `deploy/supabase-setup.md`.

0. **Offline readiness:** `pnpm check:deploy` → `0 failed`, and `pnpm eval:roles` → `All tasks passed.` With AI keys in `.env`, `pnpm eval:roles -- --live --role <role>` scores each role's 3 sample tasks against QA ≥ 85 (`reports/eval/latest-live.md`).

1. **Code reachable from the VPS.** Push this repo to GitHub (private). If this build came from a Claude Code session, add the GitHub repo to the session's sources, or push the git bundle yourself: `git bundle create rizehub-hq.bundle --all` → `git clone rizehub-hq.bundle` → `git remote set-url origin git@github.com:<you>/rizehub-hq.git` → `git push -u origin main`.
2. **Supabase project** (Singapore): create it, then `supabase link --project-ref <ref>` → `supabase db push` → run `supabase/seed.sql` once → disable sign-ups → create the private `evidence` bucket (`deploy/supabase-setup.md` §1–6).
3. **DNS:** A record `hq` → VPS public IP (`dig +short hq.rizehub.ph`).
4. **Telegram:** create the **production** bot with @BotFather (keep the test bot for local dev) and get your numeric id from @userinfobot.
5. **Free AI keys:** Gemini (aistudio.google.com), Groq (console.groq.com), OpenRouter (openrouter.ai). Keep `MODEL_PROFILE=free`, `MONTHLY_BUDGET_USD=0`.
6. **Snapshot the VPS** in hPanel.
7. **Run the setup** on the VPS: `sudo bash deploy/setup-vps.sh --repo git@github.com:<you>/rizehub-hq.git [--with-nginx --email you@example.com]`. Add the deploy key it prints; answer the `.env` prompts (Supabase URL/anon/service keys, bot token, Telegram id, AI keys). Secrets are generated for you. **Save `VAULT_MASTER_KEY` in your password manager.** `check-env` must show 0 errors. The script splits `.env` into `.env.dashboard` / `.env.bot` / `.env.worker` (each container gets only its own variables; the dashboard never sees the service-role or vault key) and fixes `brain/` + workspace ownership (`deploy/fix-perms.sh`). After editing `.env` later, run `./deploy/update.sh --force`.
8. **Proxy + TLS** (if you didn't pass `--with-nginx`): `deploy/nginx/hq.rizehub.ph.conf` + `certbot --nginx -d hq.rizehub.ph`, or your panel's reverse proxy to `127.0.0.1:3100`, or `deploy/Caddyfile`.
9. **CEO user:** Supabase → Authentication → Add user (auto-confirm) → `insert into ceo_users …` (`deploy/supabase-setup.md` §5). Log in at https://hq.rizehub.ph and you should see the 6 agents.
10. **Telegram test:** send `/status` to the production bot. Only your id should get an answer.
11. **End-to-end:** `/assign Write a 600-word blog post about Shopify speed for Madam Muse` → plan appears in Approvals → approve → the agent works → QA → deliverable in your inbox → approve.
12. **Backups:** add `SUPABASE_DB_URL` (session pooler) to `.env`, run `./deploy/backup.sh` once, add the cron line.
13. **RizeHub link** (when RizeHub exposes `/agent-api/v1`): join `rizehub-internal`, block `/agent-api` publicly (`deploy/nginx/rizehub-block-agent-api.conf`), then set `RIZEHUB_API_URL` + keys (`docs/10` §6).
14. **Optional auto-deploy:** GitHub secrets `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` + variable `DEPLOY_ENABLED=true`.

Build rules for AI coding assistants are in `CLAUDE.md`.
