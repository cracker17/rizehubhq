# 11 · Roadmap — build order with acceptance criteria

Each milestone ends with something you can **see working locally**. Don't start the next until the current one passes. Times assume part-time work with Claude Code assisting.

## M0 · Foundation (Day 1)
- Monorepo, pnpm workspaces, local Supabase running, `.env.example`, `CLAUDE.md`.
- ✅ `pnpm dev` starts empty dashboard/worker/bot without errors; Studio opens.

## M1 · Database + seed (Day 1–2)
- Migration from 03, RLS, realtime, seed 22 agents + settings, generated types.
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
- Agent runner (Vercel AI SDK + model router with the free profile; see 14), hq tools (`report_progress`, `submit_output`, `ask_ceo`), SEO Writer 1 + QA Lead, QA verdict schema, revision loop, deliverable approval.
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
- HQ: Client Success agent, onboarding playbook, `client.signed_up` webhook → auto request.
- ✅ Onboard a **test** client end-to-end: approval preview shows exactly what will be created; account + workspace appear in RizeHub staging; QA reads them back and they match the intake; welcome email draft ready.

## M10 · Remaining roles (Days 30–40)
- Add one role at a time: Graphic (Magnific), UI/UX, Social ×2, Pipeline, Prospector, Inbound, EA inbox, Webflow, WordPress, Full-Stack.
- ✅ Each new role completes 3 real tasks with QA pass ≥ 85 before the next role is added.

## M11 · Deploy to `hq.rizehub.ph` (Days 40–42)
- Per 10-DEPLOY-VPS. Production Supabase, production bot, snapshots, monitoring.
- ✅ Checklist in 10 all green; one week of real use.

## M12 · Hardening & scale (ongoing)
- Secrets manager, TOTP, auto-approve rules for low-risk plans, split QA into QA-Dev / QA-Content, cost dashboards per client, voice-note commands, client-facing status pages.

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
| 15 | Which job-alert emails to route to the Job Scout | set up alerts on OJ.ph / Indeed / LinkedIn / Upwork |
