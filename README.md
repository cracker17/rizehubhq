# RizeHub HQ

The AI virtual office for **RizeHub**: 22 AI employees you command with one message, a QA agent that checks every deliverable, and an isometric office where you watch them work and approve everything.

Live target: **https://hq.rizehub.ph** (Hostinger VPS, next to the RizeHub app).

## What's in here

| Path | What |
|---|---|
| `docs/` | The full build spec (00 to 14). Start with `docs/00-README.md` |
| `apps/dashboard` | Next.js dashboard (the office, approvals, reports) |
| `apps/worker` | The AI team runtime: scheduler, model router (free / hybrid / Claude / OpenAI), agents |
| `apps/bot` | Telegram bot: `/assign`, `/status`, approvals |
| `packages/shared` | Shared status enums + schemas (plan, QA verdict) |
| `agents/` | 22 expert role files + `roster.yaml` (who does which work type) |
| `brain/` | Company knowledge: SOPs and QA checklists for all 53 work types, playbooks, brand voice, career files, pricing template |
| `config/models.yaml` | Which AI model each role uses, per profile |
| `supabase/` | Database migration + seed |

## Run it locally

Requirements: Node 22, pnpm 9, Docker Desktop, Supabase CLI.

```bash
pnpm install
cp .env.example .env            # fill in keys (free: Gemini, Groq, OpenRouter)
supabase start                  # local database (Docker)
supabase db reset               # applies migration + seed (22 agents)
pnpm dev                        # dashboard on http://localhost:3000, worker, bot
```
Then create your login in Supabase Studio (Authentication → Add user) and run
`insert into ceo_users (user_id) select id from auth.users where email = '<your email>';`

## Checks

```bash
pnpm typecheck        # all packages
pnpm test             # worker (model router, idle behaviour) + bot (request parser)
pnpm db:test          # migration + seed + queue functions + security rules, in-memory Postgres
pnpm check:roles      # every agent file valid; every work type has an SOP + QA checklist
```
CI runs all of these on every push.

## Status

| Milestone | State |
|---|---|
| M0 Foundation (monorepo, config, Docker, CI) | ✅ |
| M1 Database (schema, queue, RLS, Client Vault tables, seed) | ✅ tested |
| M2 Dashboard shell (mockup look, mock data) | ✅ |
| Agents: 22 expert role files, 53 SOPs + QA checklists, playbooks | ✅ |
| Worker skeleton (model router + idle behaviour, tested) | ✅ |
| Telegram bot (`/assign`, `/status`, whitelist) | ✅ needs Supabase + bot token |
| M3 Live data, M4 intake, M5 COO planning, M6 first agent + QA… | next, see `docs/11-ROADMAP.md` |

Build rules for AI coding assistants are in `CLAUDE.md`.
