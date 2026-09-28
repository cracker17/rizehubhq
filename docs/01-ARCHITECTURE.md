# 01 · Architecture

## Components

```
            ┌──────────────┐        ┌──────────────────┐
  You  ───► │ Telegram Bot │        │ Dashboard (Next) │ ◄─── You (browser / phone)
            └──────┬───────┘        └────────┬─────────┘
                   │  insert request /        │  read + realtime subscribe
                   │  approve / reject        │  approve / reject / new request
                   ▼                          ▼
            ┌─────────────────────────────────────────────┐
            │           SUPABASE (Postgres)               │
            │ requests · tasks · approvals · qa_reviews   │
            │ agents · reports · activity_log · clients   │
            │ connections · settings   + Realtime + Auth  │
            └──────────────────────┬──────────────────────┘
                                   │ claim_next_task() / write results
                                   ▼
            ┌─────────────────────────────────────────────┐
            │                 WORKER                      │
            │  Scheduler loop → Agent Runner (AI SDK)     │
            │  COO planner · Specialists · QA · Reporter  │
            │  Tool layer (holds all API tokens)          │
            └──────┬───────────┬───────────┬───────────┬──┘
                   ▼           ▼           ▼           ▼
             AI models   GitHub/Shopify/  /brain     RizeHub app (same VPS)
             (see 14)    Webflow/Figma…   (markdown) Agent API: Lead Finder,
                                                     accounts, workspaces, reports
                                                     (sends webhooks back to HQ)
```

| Component | Responsibility | Tech |
|---|---|---|
| **Dashboard** | Virtual office, approvals, tasks, reports, QA center, agents, clients, connections | Next.js (App Router) + TypeScript + Tailwind + shadcn/ui, Supabase JS (Realtime) |
| **Telegram bot** | Command intake, approval buttons, notifications, daily digest | Node + TypeScript + grammY, long polling |
| **Worker** | Picks up work from the queue, runs agents, enforces budgets and guardrails | Node + TypeScript + Vercel AI SDK (any model provider) |
| **Supabase** | Single source of truth: data, queue, auth, realtime | Supabase (local via CLI, cloud in production) |
| **Brain** | Company knowledge: SOPs, brand voice, client files, templates | Markdown folder in the repo (open it in Obsidian if you like) |
| **RizeHub** (existing) | Your product: client accounts, workspaces, Lead Finder, report tools | Your custom app on the VPS; exposes `/agent-api/v1` to HQ (see 12) |

**Rule:** HQ never touches RizeHub's database directly — only its Agent API. **Rule:** the dashboard and bot never talk to agents directly. They only write rows (requests, approval decisions). The worker only reads and writes rows. Supabase is the contract between everything. This keeps each part independently testable and restartable.

## Monorepo layout

```
rizehub-hq/
├── apps/
│   ├── dashboard/          # Next.js app
│   ├── worker/             # agent runner + scheduler
│   ├── bot/                # Telegram bot
│   └── webhooks/           # (inside worker is fine) receives RizeHub webhooks
├── packages/
│   └── shared/             # DB types (generated), zod schemas, constants, status enums
├── agents/                 # one .md role file per agent + roster.yaml
│   ├── roster.yaml
│   ├── coo.md
│   ├── qa-lead.md
│   └── …
├── brain/                  # company knowledge base (markdown)
│   ├── company/            # services, pricing, brand voice, policies
│   ├── sops/               # how-we-do-it per work type (shopify-build.md, seo-article.md…)
│   ├── qa-checklists/      # one checklist per work type
│   ├── playbooks/          # workflows: lead-gen, job-hunt, onboarding, monthly-report (see 13)
│   ├── career/             # job filters, portfolio, application style (Job Scout)
│   └── clients/            # one folder per client: profile.md, brand.md, access.md (no secrets!)
├── workspaces/             # per-task scratch dirs the worker creates (gitignored)
├── assets/office/          # character sprites + office background
├── supabase/
│   ├── migrations/
│   └── seed.sql
├── docker-compose.yml      # production (VPS)
├── docker-compose.dev.yml  # optional local containers
├── .env.example
├── CLAUDE.md
└── pnpm-workspace.yaml
```

## Tech decisions (defaults — change in 11-ROADMAP “Open decisions”)

| Area | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere | One language, shared types across dashboard, bot, worker |
| Package manager | pnpm workspaces | Fast, clean monorepo |
| Agent runtime | Vercel AI SDK (`ai`) + own tool layer | Free and provider-agnostic: Gemini, Groq, OpenRouter now; Claude or OpenAI later by changing config (see 14) |
| Models | Agents ask for a role (lead / specialist / dev / reports / qa / light); `config/models.yaml` maps roles to models per profile (free, hybrid, claude, openai) | Start free, upgrade only the roles that need it |
| DB / Auth / Realtime | Supabase | You already use it; realtime powers the live office |
| UI | Tailwind + shadcn/ui + lucide icons + Framer Motion | Matches the mockup, fast to build |
| Office rendering | Phaser 3 + Tiled maps (top-down and isometric views of one logical map) | Gather-style office with tilemaps, walking/pathfinding, zoom/pan (see 07) |
| Telegram | grammY | Modern, typed, simple inline keyboards |
| Browser checks (QA) | Playwright (headless Chromium) | Screenshots, console errors, link checks |
| Speed/a11y checks | Lighthouse CLI | Standard scores QA can attach as evidence |

## Local vs production

| | Local (testing) | Production |
|---|---|---|
| Supabase | `supabase start` (Docker) | Supabase cloud project |
| Dashboard | `pnpm dev` → localhost:3000 | Docker on VPS behind Caddy (HTTPS) — or Vercel |
| Worker | `pnpm dev` on your laptop | Docker on VPS, auto-restart |
| Bot | long polling from laptop | long polling from VPS |
| Secrets | `.env.local` files | `.env` on VPS (chmod 600) → later a secrets manager |

Only one bot instance may poll a Telegram token at a time. Use a **separate test bot** (from BotFather) for local development so production and local never fight.

## Data flow of one request (summary — full detail in 05)

1. `requests` row inserted (`staged`)
2. Worker's COO planner picks it up → writes plan → `approvals` row (`kind=plan`)
3. You approve → `tasks` rows created (`pending`/`queued`)
4. Worker claims queued tasks → specialist agent runs → output saved → task `qa_pending`
5. QA agent reviews → `pass` → `awaiting_ceo` approval, or `fail` → `revision` (back to specialist)
6. You approve deliverable → any external action executes → task `done`
7. When all tasks are `done` → request `done` → included in daily digest
