# 11 · Roadmap — build order with acceptance criteria

Each milestone ends with something you can **see working locally**. Don't start the next until the current one passes. Times assume part-time work with Claude Code assisting.

## Status (2026-09-28)

"Built" means the code exists and its checks pass offline (`pnpm typecheck`, `pnpm test`, `pnpm db:test` on in-memory Postgres, `check:roles`, the mock RizeHub). Nothing has run against live keys, the hosted Supabase or the VPS yet.

| Milestone | Status | What's left |
|---|---|---|
| M0 Foundation | ✅ Done: built and tested offline | |
| M1 Database + seed | ✅ Done: built and tested offline (`pnpm db:test`) | `supabase db push` to the production project |
| M2 Dashboard shell | ✅ Done: built and tested offline | |
| M3 Live data | ✅ Done: built and tested offline | Confirm Realtime against hosted Supabase |
| M4 Intake (modal + `/assign`) | ✅ Done: built and tested offline | Production bot token + your Telegram id |
| M5 COO planner + plan approval | ✅ Done: built and tested offline | Live run with free AI keys |
| M6 First specialist + QA loop | ✅ Done: built and tested offline | Live end-to-end `/assign` test |
| M7 Reports | ✅ Done: built and tested offline | First real 08:00 brief / 18:00 digest |
| M8 Virtual Office | ✅ Done: built and tested offline | Final isometric art pass |
| M9a Client Vault | ✅ Done: built and tested offline | `VAULT_MASTER_KEY` on the VPS; test-store login |
| M9 Dev agents + connections | ✅ Done: built and tested offline | Test Shopify store, GitHub token in the vault |
| M9b RizeHub Agent API | ✅ Done: built and tested offline (mock + reference kit `rizehub-agent-api/`) | RizeHub implements `/agent-api/v1` (staging), then real keys |
| M9c Onboarding automation | ✅ Done: built and tested offline (mock) | Staging RizeHub test client |
| **Go-live** (M11 deploy kit) | 🟡 Kit ready: `deploy/`, Dockerfiles, compose, CI image builds, `pnpm check:env`, `pnpm check:deploy`, Go-live runbook in docs/10 | **Pending:** hosted Supabase, DNS, `.env` with live keys, `setup-vps.sh`, CEO user, Telegram bot, `/assign` end-to-end (README "Go-live checklist") |
| M10 Remaining roles | 🟡 Ready offline: role files, SOPs, tools and `pnpm eval:roles` (18 fixture tasks, all ≥ 85 offline) | AI keys, then `pnpm eval:roles -- --live`, then 3 real tasks with QA ≥ 85 per role |
| M12 Hardening & scale | 🟡 In progress: TOTP 2FA + step-up, auto-approve rules for low-risk plans, /costs dashboard, Admin section (password change/reset, 2FA turn-off, Tool logins = internal vault for the agency's own accounts) done | Secrets manager, QA-Dev / QA-Content split, voice notes, client status pages |
| M13 Connectors | ⚪ Planned 2026-09-29 (docs/15) | Kimi backup model, MCP connector wizard (Sign in / token, per-tool Allowed/Ask me/Off), Gmail accounts via App Password, Drive/Dropbox storage |

## M0 · Foundation (Day 1)
- Monorepo, pnpm workspaces, local Supabase running, `.env.example`, `CLAUDE.md`.
- ✅ `pnpm dev` starts empty dashboard/worker/bot without errors; Studio opens.

## M1 · Database + seed (Day 1–2)
- Migration from 03, RLS, realtime, seed agents + settings (now 6 agents: `20260928080000_six_agent_roster.sql`), generated types.
- ✅ `supabase db reset` works; you can log in; agents visible in Studio.

## M2 · Dashboard shell matching mockup (Days 2–5)
- Tokens, sidebar, top bar, KPI cards, Office **Grid** view, Approvals column, Activity strip — mock data.
- ✅ Side-by-side with mockup A looks the same; responsive down to 375px.

## M3 · Live data (Days 5–6)
- Replace mock data with Supabase queries + realtime store.
- ✅ Editing an agent's status in Studio updates the tile instantly.

## M4 · Intake (Day 7)
- New Request modal + Telegram bot `/assign` (test bot, whitelist).
- ✅ A request from either source appears as `staged` in < 2s.

## M5 · COO planner + plan approval (Days 8–10)
- Worker loop, COO role file, plan zod schema, `approval(kind=plan)`, Approvals page plan view, Telegram buttons.
- ✅ "Write a blog post about Shopify speed for Madam Muse" produces a sensible plan; approving creates queued tasks.

## M6 · First specialist + QA loop (Days 10–14)
- Agent runner (Vercel AI SDK + model router with the free profile; see 14), hq tools (`report_progress`, `submit_output`, `ask_ceo`), Content Writer + QA, QA verdict schema, revision loop, deliverable approval.
- ✅ End-to-end: command → plan → article written → QA fails once → revised → QA passes → you approve → done. Costs logged.

## M7 · Reports (Days 14–16)
- Standups, 18:00 CEO digest (dashboard + Telegram), 08:00 morning brief, Reports page.
- ✅ Digest accurately lists today's done/in-progress/blocked/spend.

## M8 · Virtual Office (Days 16–30)
- Phases A1–A4 from 07: isometric Tiled map with placeholder figures → POV screen panel + agent chat → real isometric art (3D pipeline) → boardroom/QA Lab/idle games/CEO avatar. Optional B1: top-down view.
- Art pipeline (07 §10) can run in parallel from day 1.
- ✅ Idle agents walk to the coffee lounge, lobby or game room; claiming a task walks them back to their desk; planning puts the team in the Boardroom; waiting agents raise hands.
- ✅ Clicking any agent shows their live screen (code, browser, doc, leads, review) and "What are you doing?" gets an accurate answer in chat.
- ✅ The isometric office matches the chosen concept's look (lighting, materials, room signs, readable name tags).

## M9a · Client Vault (before any agent touches client systems)
- Encrypted vault (09), Access tab (06), vault tools (`vault_login`, `vault_api`), grants, audit log, client self-serve access link.
- ✅ You add a test login; the Shopify Dev logs into a **test** store through `vault_login` without the password ever appearing in prompts, logs, screen feed or chat; revoking the grant blocks it immediately.

## M9 · Dev agents + connections (Days 22–30)
- Workspaces, sandboxed shell, GitHub tool (branch + PR), Shopify theme tool (unpublished only), Playwright/Lighthouse QA toolkit, Connections page, external-action approvals.
- ✅ Shopify Dev builds a section on an unpublished theme of a **test store**, QA attaches mobile/desktop screenshots + Lighthouse, you approve, PR opened.

## M9b · RizeHub Agent API + first RizeHub workflows (in parallel with M6–M9)
- In RizeHub: API keys table + middleware, `/agent-api/v1/health`, Lead Finder read endpoints, report endpoints, `dry_run` + idempotency, webhooks; staging instance (12 checklist).
- In HQ: RizeHub tool layer (mock first, then staging), webhook receiver, Leads page, Jobs page.
- ✅ **Find leads** playbook end-to-end against staging: 10 leads researched, report + drafts in your approval inbox.
- ✅ **Monthly report** playbook: report generated in RizeHub, summary written, QA verifies every number, you approve, published in staging.
- ✅ **Job hunt** playbook: shortlist from your job-alert emails with drafts; "Mark applied" tracked.

## M9c · Onboarding automation
- RizeHub: account + workspace create endpoints, workspace templates, invite drafts, `test: true` accounts.
- HQ: COO-run onboarding (was the Client Success agent), onboarding playbook, `client.signed_up` webhook → auto request.
- ✅ Onboard a **test** client end-to-end: approval preview shows exactly what will be created; account + workspace appear in RizeHub staging; QA reads them back and they match the intake; welcome email draft ready.

## M10 · Remaining roles (Days 30–40)
- Add one capability at a time (the team is now 6 agents: coo, web-dev, designer, writer, sales, qa-lead): design (Magnific), social/SEO content, sales pipeline + prospecting + inbound, COO inbox, Webflow, WordPress, full-stack.
- ✅ Each new role completes 3 real tasks with QA pass ≥ 85 before the next role is added.

## M11 · Deploy to `hq.rizehub.ph` (Days 40–42)
- Per 10-DEPLOY-VPS (scripted in `deploy/`): production Supabase (`deploy/supabase-setup.md`), `deploy/setup-vps.sh`, production bot, snapshots, backups, monitoring. Updates via `deploy/update.sh` (auto-rollback) or the optional GitHub deploy workflow.
- ✅ Checklist in 10 all green; one week of real use.

## M12 · Hardening & scale (ongoing)
- Secrets manager, TOTP, auto-approve rules for low-risk plans, Admin → Tool logins (internal vault: the agency's own Semrush/Canva/hosting logins, granted per agent, usable in any task; docs/09 "Internal vault"; acceptance: a granted agent lists and uses a tool login in a task without a client, an ungranted one is refused, the internal client can't be archived: `scripts/db-tests/150-internal-vault.mjs`), split QA into QA-Dev / QA-Content, cost dashboards per client, voice-note commands, client-facing status pages.

---

## Open decisions (answer before/while building)

| # | Decision | Default in this spec |
|---|---|---|
| 1 | Domain | `hq.rizehub.ph` (decided) |
| 2 | What owns ports 80/443 on the VPS (nginx / panel / nothing)? | check in 10 step 0 |
| 3 | VPS free RAM/disk? | need ≥ 3 GB / 15 GB |
| 4 | Dashboard on VPS or Vercel? | VPS (one place) |
| 5 | First 2–3 clients to onboard into `brain/clients/` | e.g. one Shopify, one Webflow |
| 6 | Daily AI budget to start | $10/day |
| 7 | Digest times | 08:00 brief, 18:00 digest (Manila) |
| 8 | Auto-approve any plans? | No (everything manual at first) |
| 9 | Test Shopify store for M9 | create a free dev store |
| 10 | Brand for the HQ (RizeHub HQ name/colors) | as mockup A |
| 10b | Starting AI profile | `free` (Gemini + Groq + OpenRouter), budget $0 |
| 11 | RizeHub's language/framework (for the Agent API code) | tell Claude Code when starting M9b |
| 12 | Does RizeHub run in Docker on the VPS? | decides the network setup in 10 |
| 13 | Workspace templates per service package | list packages in `brain/company/services.md` |
| 14 | Cold-email sending domain (separate from main) | needed before outreach sends |
| 15 | Which job-alert emails to route to the Sales Agent (job search) | set up alerts on OJ.ph / Indeed / LinkedIn / Upwork |
