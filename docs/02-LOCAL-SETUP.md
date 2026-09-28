# 02 · Local Setup (run everything on your laptop)

Goal: from an empty folder to a working dashboard on `http://localhost:3000`, local Supabase, a running worker, and a test Telegram bot.

## Prerequisites (install once)

| Tool | Version | Check |
|---|---|---|
| Node.js | 22 LTS | `node -v` |
| pnpm | 9+ | `npm i -g pnpm` → `pnpm -v` |
| Docker Desktop | latest, running | `docker ps` |
| Supabase CLI | latest | `npm i -g supabase` (or scoop/brew) → `supabase -v` |
| Git | any | `git -v` |
| VS Code + Claude Code | optional but recommended | |

Accounts / keys:
- **Free AI keys**: Google AI Studio (Gemini), Groq console, OpenRouter. No card needed for the free tiers. (Claude / OpenAI keys only when you switch profiles; set a monthly spend limit in their consoles first.)
- **Telegram test bot**: message `@BotFather` → `/newbot` → name it e.g. `RizeHub HQ Dev` → copy the token.
- **Your Telegram user ID**: message `@userinfobot` → copy the numeric ID (used to whitelist you).

## Step 1 — Create the monorepo

```bash
mkdir rizehub-hq && cd rizehub-hq
git init
pnpm init
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

Root `package.json` scripts:
```json
{
  "private": true,
  "scripts": {
    "dev": "pnpm -r --parallel --filter ./apps/** dev",
    "dev:dashboard": "pnpm --filter dashboard dev",
    "dev:worker": "pnpm --filter worker dev",
    "dev:bot": "pnpm --filter bot dev",
    "db:types": "supabase gen types typescript --local > packages/shared/src/db.types.ts",
    "db:reset": "supabase db reset"
  }
}
```

Create folders:
```bash
mkdir -p apps packages/shared/src agents brain/{company,sops,qa-checklists,clients} assets/office workspaces supabase
printf "workspaces/\n.env*\n!.env.example\nnode_modules/\n.next/\n" > .gitignore
```

## Step 2 — Local Supabase

```bash
supabase init
supabase start
```
The output prints the local **API URL** (usually `http://127.0.0.1:54321`), **anon key**, **service_role key**, and **Studio URL** (`http://127.0.0.1:54323`). Save them.

Create the first migration and paste the SQL from `03-DATABASE.md`:
```bash
supabase migration new init_schema
# paste SQL into supabase/migrations/<timestamp>_init_schema.sql
```
Put the seed SQL (agents roster, settings) into `supabase/seed.sql`, then:
```bash
supabase db reset        # applies migrations + seed
pnpm db:types            # generates TypeScript types
```
Open Studio and confirm the tables and the 6 agents exist.

Create your CEO login: Studio → Authentication → Add user → your email + password. Then in the SQL editor: `insert into ceo_users (user_id) select id from auth.users where email = '<your email>';` (RLS only lets `ceo_users` in; see 03).

Check the schema any time without Docker: `pnpm db:test` (runs migration + seed + queue and RLS tests in an in-memory Postgres).

## Step 3 — Shared package

`packages/shared` exports:
- `db.types.ts` (generated)
- `status.ts` — enums for request/task/agent/approval statuses (mirror the DB enums)
- `schemas.ts` — zod schemas for the COO plan JSON, QA verdict JSON, report JSON
- `supabase.ts` — `createServiceClient()` (worker/bot) and `createBrowserClient()` (dashboard)

## Step 4 — Dashboard

```bash
cd apps
pnpm create next-app dashboard --ts --tailwind --app --eslint --src-dir --import-alias "@/*"
cd dashboard
pnpm add @supabase/supabase-js @supabase/ssr framer-motion lucide-react phaser easystarjs zustand zod date-fns
pnpm dlx shadcn@latest init
pnpm dlx shadcn@latest add button card badge dialog sheet tabs textarea input dropdown-menu tooltip avatar progress scroll-area sonner
```
`apps/dashboard/.env.local`:
```
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<local anon key>
```
Build UI per `06-DASHBOARD-UI.md`. **First build it with mock data** matching the mockup, then wire to Supabase.

## Step 5 — Worker

```bash
cd ../ && mkdir worker && cd worker && pnpm init
pnpm add ai @ai-sdk/google @ai-sdk/groq @openrouter/ai-sdk-provider @ai-sdk/anthropic @ai-sdk/openai @supabase/supabase-js zod yaml gray-matter pino
pnpm add -D tsx typescript @types/node
pnpm add playwright && pnpm exec playwright install chromium     # for QA checks
```
`package.json` → `"dev": "tsx watch src/index.ts"`

`apps/worker/.env.local`:
```
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SERVICE_ROLE_KEY=<local service_role key>
# AI providers (see 14). Free to start:
GOOGLE_GENERATIVE_AI_API_KEY=...
GROQ_API_KEY=...
OPENROUTER_API_KEY=...
# Later, when you switch profiles:
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
MODEL_PROFILE=free
MONTHLY_BUDGET_USD=0
VAULT_MASTER_KEY=<32 random bytes, base64>   # openssl rand -base64 32 ; different key for local and production
AGENTS_DIR=../../agents
BRAIN_DIR=../../brain
WORKSPACES_DIR=../../workspaces
POLL_INTERVAL_MS=3000
MAX_PARALLEL_TASKS=3
DAILY_BUDGET_USD=10
TZ=Asia/Manila
RIZEHUB_API_URL=http://localhost:8080/agent-api/v1   # your local/staging RizeHub, never production
RIZEHUB_KEY_LEADS=rzh_test_...
RIZEHUB_KEY_ONBOARDING=rzh_test_...
RIZEHUB_KEY_REPORTS=rzh_test_...
RIZEHUB_KEY_READONLY=rzh_test_...
RIZEHUB_WEBHOOK_SECRET=dev-secret
```
Build per `04-AGENTS.md`, `05-ORCHESTRATION.md` and `12-RIZEHUB-INTEGRATION.md`.

**RizeHub locally:** run a staging copy of RizeHub on your laptop (or point at the staging instance on the VPS through an SSH tunnel: `ssh -L 8080:localhost:8080 you@vps`). Until the Agent API exists, the worker can use a **mock RizeHub** (`apps/worker/src/mocks/rizehub.ts`) that returns realistic fake leads, accounts and reports, so the whole HQ can be built and tested first.

> Verify AI SDK function names (`generateText`, `tool`, `stopWhen`/`stepCountIs`) and provider package names against the current AI SDK docs when you start; APIs evolve.

## Step 6 — Telegram bot

```bash
cd ../ && mkdir bot && cd bot && pnpm init
pnpm add grammy @supabase/supabase-js zod
pnpm add -D tsx typescript @types/node
```
`apps/bot/.env.local`:
```
TELEGRAM_BOT_TOKEN=<test bot token>
TELEGRAM_ALLOWED_USER_IDS=<your numeric id>
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SERVICE_ROLE_KEY=<local service_role key>
DASHBOARD_URL=http://localhost:3000
```
Build per `08-TELEGRAM-BOT.md`.

## Step 7 — Run everything

```bash
# terminal 1 (if not running)
supabase start
# terminal 2 (repo root)
pnpm dev
```
- Dashboard → http://localhost:3000
- Supabase Studio → http://127.0.0.1:54323
- Send `/start` to your test bot, then `/assign test: write a 300-word blog intro about Shopify speed for Madam Muse`

## Step 8 — Local smoke test checklist

- [ ] Request appears in dashboard within 2s (realtime) with status `staged`
- [ ] COO plan arrives in Approval Inbox and in Telegram with Approve/Reject buttons
- [ ] Approving creates tasks; the assigned character walks to its desk (status `working`)
- [ ] Output reaches QA; QA verdict visible in QA Center
- [ ] Deliverable approval appears; approving marks task + request `done`
- [ ] Idle agents show coffee/lounge activities
- [ ] Activity log shows every step with cost
- [ ] Killing and restarting the worker mid-task recovers (stale task re-queued)

## Useful local commands

```bash
supabase stop                 # stop local DB (data kept)
supabase db reset             # wipe + re-apply migrations + seed
pnpm db:types                 # after any schema change
```
