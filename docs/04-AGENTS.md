# 04 · Agents

## The team (6 agents + you)

```
                         CEO (Julev) — approves everything
                                   │
                                  COO  ── plans, routes, escalates; also runs onboarding,
                                   │      client reports, the inbox and the daily/weekly briefs
       ┌──────────────┬────────────┴───┬────────────────┬──────────────┐
  Web Developer   Graphic Designer  Content Writer    Sales Agent       QA
  (Shopify,       (UI/UX + ads,     (SEO, social,     (leads, outreach, (verifies all work
   Webflow, WP,    social graphics,  short-video       replies, proposals, before it reaches you)
   full-stack)     brand assets)     scripts)          job search)
```

Ids: `coo`, `web-dev`, `designer`, `writer`, `sales`, `qa-lead`. `runtime` (role front-matter + `agents.runtime`): `worker` = the
AI SDK runner in `apps/worker` (COO, QA); `hermes` = a Hermes Agent instance (Web Developer, Graphic Designer, Content Writer, Sales
Agent; until that runtime lands they run on the worker runner too). The team was 22 agents until migration
`20260928080000_six_agent_roster.sql`, which moved their work to these six. Video editing and sound/voice work types were dropped.

## Role file format — `agents/<id>.md`

Each agent is a markdown file with YAML front-matter. The worker loads it as the agent's system prompt. **You edit the agent by editing this file** (and later from the Agents page in the dashboard).

```markdown
---
id: web-dev
name: Web Developer
department: dev
model_role: dev            # lead | dev | design | writer | sales | qa → resolved via config/models.yaml (see 14)
runtime: hermes            # worker | hermes
max_turns: 60
budget_usd_per_task: 1.50
tools: [brain_read, workspace_fs, bash_sandboxed, github, shopify_theme, report_progress, submit_output, ask_ceo]
work_types: [shopify-section, shopify-page, shopify-theme-fix, shopify-speed, webflow-page, …]
---

# Role
You are the Web Developer at RizeHub, a growth agency. You build and fix Shopify
Online Store 2.0 themes, Webflow sites, WordPress sites and custom full-stack apps.

# How you work
1. Read the task, its acceptance criteria, and `brain/clients/<client>/profile.md` + `brand.md`.
2. Read the SOP: `brain/sops/<work_type>.md`.
3. Work ONLY in your task workspace and on a git branch named `agent/<task-id>`.
4. Push theme changes only to an UNPUBLISHED theme. Never publish. Never touch checkout settings.
5. Call `report_progress` at each milestone (this updates your status in the office).
6. When done, call `submit_output` with: summary, changed files, branch, preview URL, and
   how each acceptance criterion is met.

# If QA sends it back
Fix every failed check listed in `qa_feedback`. Do not argue with QA; if a check is wrong,
explain why in your output and QA or the CEO will decide.

# Never
- Publish a theme, merge to main, send messages, or spend money.
- Invent client facts. If information is missing, call `ask_ceo`.
- Exceed your budget. If the task is bigger than expected, stop and `ask_ceo`.

# Quality bar
Mobile-first, accessible (labels, alt text, contrast), no console errors, no hardcoded
text that should be a schema setting, Lighthouse performance not worse than before.
```

## `agents/roster.yaml` — what the COO routes on

`agents/roster.yaml` is the source of truth (`pnpm check:roles` validates it against the role files). In short:

```yaml
# work_type → owning agent (COO can override with reasons)
routing:
  # COO: planning, weekly-summary, inbox-triage, daily-report, client-report, meeting-prep,
  #      client-onboarding, workspace-setup, access-checklist
  # sales: lead-finder-search, lead-report, outreach-draft, dm-reply-draft, lead-qualification,
  #        proposal, follow-up-email, job-search, job-application
  # web-dev: shopify-section, shopify-page, shopify-theme-fix, shopify-speed, webflow-page, webflow-cms,
  #          webflow-interaction, wordpress-page, wordpress-plugin, wordpress-fix, web-app, api-integration, automation
  # designer: wireframe, ui-mockup, ux-audit, ad-creative, social-graphic, brand-asset
  # writer: seo-article, landing-copy, meta-tags, keyword-research, content-calendar, social-captions, short-video-script
  planning:             coo
  lead-finder-search:   sales
  shopify-section:      web-dev
  wireframe:            designer
  seo-article:          writer
  # …

# every deliverable goes through QA
qa:
  default: qa-lead

# client platform hints — lets "fix the Madam Muse store" route to the developer without saying Shopify
platform_to_dev:
  shopify: web-dev
  webflow: web-dev
  wordpress: web-dev
  custom: web-dev
```

## Agent capabilities (what each can actually do)

| Agent | Produces | Tools | Needs your approval for |
|---|---|---|---|
| **COO** | Plans, task breakdowns, escalations, weekly summary; inbox triage, meeting prep, daily digest / morning brief; client onboarding (RizeHub accounts + workspaces, access checklists) and client reports | brain_read/write, create_plan, gmail_read, gmail_draft, calendar_read, rizehub_onboarding, rizehub_reports, rizehub_readonly, ask_ceo | Every plan (until you enable auto-approve for low-risk), sending any email, creating accounts/workspaces, publishing reports |
| **Web Developer** | Shopify sections/pages/fixes on an unpublished theme, Webflow CMS + pages + interactions, WordPress pages/plugins (staging), full-stack features, APIs, integrations, automations | workspace, git/github, bash_sandboxed, shopify_theme, webflow_api, wp_rest, playwright, lighthouse, vault tools | Publishing a theme/site, pushing to live, merging, deploying |
| **Graphic Designer** | Wireframes, UI mockups, UX audits, ad creatives, social graphics, brand assets (always a design spec + assets) | figma_read, image_gen (Magnific), workspace, playwright, lighthouse | Sending to client / running ads |
| **Content Writer** | SEO articles, landing copy, meta tags, keyword research, content calendars, social captions, short-video scripts, report commentary | semrush, web_search, web_fetch, link_checker, rizehub_reports (notes only) | Publishing / scheduling / posting |
| **Sales Agent** | Lead Finder searches, lead reports, outreach and DM reply drafts, lead qualification, proposals, follow-ups; job shortlists + application drafts | rizehub_leads, gmail_read, gmail_draft, web_fetch, web_search, pagespeed, semrush, job_tracker | You send every message and submit every application yourself; sending proposals / pricing |
| **QA** | Verdicts, scores, evidence | playwright, lighthouse, pagespeed, link_checker, web_fetch, figma_read, rizehub_readonly, qa_submit_verdict | — (QA only passes/fails) |

## Client Vault tools (see 09)

| Tool | What it does | The agent sees |
|---|---|---|
| `vault_list(client)` | Which logins exist for this client and whether *this agent* may use them | Labels, platform, username (masked), status, never secrets |
| `vault_login(credential_id, url)` | Worker opens a sandboxed browser and fills the login itself; the agent then works in that logged-in session | "Logged in as j***@client.com"; screenshots with password fields blurred |
| `vault_api(credential_id, request)` | Worker makes the API call with the stored token | The API response only |
| `vault_request_2fa(credential_id)` | Pauses the task and asks you on Telegram for the one-time code | "Waiting for CEO 2FA code" |
| `vault_report_problem(credential_id, issue)` | Flags wrong password / expired token / locked account | Creates a task for you |

Agents only get the vault tools if their role lists them, and only for credentials you granted to that agent.

## RizeHub tools (see 12 for the API)

| Tool group | Key | Given to |
|---|---|---|
| `rizehub_leads` (search, get, notes, lists, stage) | `RIZEHUB_KEY_LEADS` | Sales Agent |
| `rizehub_onboarding` (accounts, workspaces, config, invites) | `RIZEHUB_KEY_ONBOARDING` | COO |
| `rizehub_reports` (metrics, generate, notes, publish) | `RIZEHUB_KEY_REPORTS` | COO (all), Content Writer (notes only) |
| `rizehub_readonly` | `RIZEHUB_KEY_READONLY` | COO, QA |

Write tools marked external (account/workspace creation, invites, report publishing, lead stage "contacted") always go through an approval first.

## Built-in tools every agent gets (implemented in the worker)

| Tool | What it does | Side effects |
|---|---|---|
| `brain_read(path)` / `brain_search(query)` | Read company + client knowledge | none |
| `report_progress(percent, note)` | Updates task progress + agent bubble in office | DB write |
| `submit_output(summary, files, links, criteria_map)` | Ends the task, sends to QA | DB write |
| `ask_ceo(question, options?)` | Creates an approval of kind `external_action` / question; pauses the task | DB write + Telegram ping |
| `request_external_action(type, spec)` | Proposes publish/send/merge — executes only after you approve | queued until approved |

Rule of thumb: **tools that change the outside world never execute directly** — they create an approval, and the action happens only after `approved`: the worker executes the types it has an executor for (`rizehub.report_publish`, `rizehub.invite_send`, `rizehub.onboarding`); every other `request_external_action` type is stored with `executor: "manual"` and shown as "Manual step: you do this after approving" (the CEO carries it out).

## Model & cost policy

Agents never name a model. Each role file sets a `model_role`; the active profile in `config/models.yaml` decides the actual model (full detail and costs in 14).

| Role | Agents | Free profile (now) | Claude profile (later) |
|---|---|---|---|
| `lead` | COO | Gemini Flash → Groq fallback | Opus 5.5 or Sonnet 5 |
| `qa` | QA | Gemini Flash → Groq fallback | Opus 5.5 or Sonnet 5 |
| `dev` | Web Developer | Gemini Flash (draft-for-review mode) | Sonnet 5 |
| `design` | Graphic Designer | Gemini Flash → Groq → OpenRouter free | Sonnet 5 |
| `writer` | Content Writer | Gemini Flash → Groq → OpenRouter free | Sonnet 5 |
| `sales` | Sales Agent | Gemini Flash → Groq → OpenRouter free | Sonnet 5 |
| `light` | Agent chat, summaries, digests, routing | Groq small model | Haiku 4.5 |

(`specialist` and `reports` remain in `config/models.yaml` as fallbacks: a profile without `design`/`writer`/`sales` uses `specialist`.)

You can override any single agent from the Agents page (e.g. try the Web Developer on Claude for a week and compare QA scores and cost).

Limits enforced by the worker: `max_turns` per task, `budget_usd_per_task`, agent `daily_budget_usd`, global `daily_budget_usd`. On hitting a limit → task `failed`, agent `blocked`, Telegram alert.

## Brain (knowledge) files to write first

```
brain/company/about.md            # RizeHub: services, positioning, tone
brain/company/brand-voice.md      # how we write (email, proposals, social)
brain/company/pricing.md          # packages, rates (agents quote only from here)
brain/company/policies.md         # what agents must never do
brain/sops/shopify-section.md     # step-by-step how we build a section
brain/sops/seo-article.md         # structure, length, keyword rules
brain/sops/ad-creative.md         # sizes, safe zones, brand rules
brain/qa-checklists/<work_type>.md# one per work type (QA grades against these)
brain/clients/<slug>/profile.md   # who they are, platform, goals, contacts (no secrets)
brain/clients/<slug>/brand.md     # colors, fonts, voice, do/don't
brain/playbooks/*.md              # workflows from 13 (lead-gen, job-hunt, onboarding, monthly-report)
brain/career/job-filters.md       # roles, rates, hours, red flags (Sales Agent: job search)
brain/career/portfolio.md         # portfolio links by platform + resume links
brain/career/application-style.md # tone rules + example applications that got replies
brain/company/services.md         # RizeHub packages → which workspace template each uses
```
The quality of the team is mostly the quality of these files. Start with 2–3 clients and 3 SOPs.
