# 04 · Agents

## The team (22 agents + you)

```
                         CEO (Julev) — approves everything
                                   │
                                  COO  ── plans, routes, escalates
                                   │
   ┌────────────┬─────────────┬────┴───────┬──────────────┬──────────────┐
  Ops          Growth          Dev          Design          Content         QA
  EA &         Pipeline Desk   Shopify      UI/UX ×2        Social Mktg ×2  QA Lead
  Report Desk  Social          Webflow      Graphic ×2      SEO Writer ×2   (verifies all work
  Client       Prospecting     WordPress                                     before it reaches you)
  Success      Social+Inbound  Full-Stack
               Job Scout
                                                             Multimedia: Video Editor · Sound & Voice Specialist
```

## Role file format — `agents/<id>.md`

Each agent is a markdown file with YAML front-matter. The worker loads it as the agent's system prompt. **You edit the agent by editing this file** (and later from the Agents page in the dashboard).

```markdown
---
id: shopify-dev
name: Shopify Dev
department: dev
model_role: dev            # lead | specialist | dev | reports | qa | light → resolved via config/models.yaml (see 14)
max_turns: 60
budget_usd_per_task: 1.50
tools: [brain_read, workspace_fs, bash_sandboxed, github, shopify_theme, report_progress, submit_output, ask_ceo]
work_types: [shopify-section, shopify-page, shopify-theme-fix, shopify-speed]
---

# Role
You are the Shopify Developer at RizeHub, a growth agency. You build and fix Shopify
Online Store 2.0 themes: Liquid sections, blocks, schema settings, metafields, JS/CSS.

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

```yaml
# work_type → default agent (COO can override with reasons)
routing:
  planning:             coo
  inbox-triage:         ea
  daily-report:         ea
  proposal:             pipeline
  follow-up-email:      pipeline
  lead-research:        prospector
  outreach-draft:       prospector
  dm-reply-draft:       inbound
  lead-finder-search:   prospector
  lead-report:          prospector
  job-search:           job-scout
  job-application:      job-scout
  client-onboarding:    client-success
  workspace-setup:      client-success
  access-checklist:     client-success
  client-report:        ea
  video-edit:           video-editor
  reel:                 video-editor
  subtitles:            video-editor
  voiceover:            sound-engineer
  voice-design:         sound-engineer
  audio-cleanup:        sound-engineer
  music-sfx:            sound-engineer
  shopify-section:      shopify-dev
  shopify-page:         shopify-dev
  shopify-theme-fix:    shopify-dev
  webflow-page:         webflow-dev
  webflow-cms:          webflow-dev
  wordpress-page:       wordpress-dev
  wordpress-plugin:     wordpress-dev
  web-app:              fullstack-dev
  api-integration:      fullstack-dev
  wireframe:            [uiux-1, uiux-2]        # list = load-balance by queue length
  ui-mockup:            [uiux-1, uiux-2]
  ad-creative:          [graphic-1, graphic-2]
  social-graphic:       [graphic-1, graphic-2]
  content-calendar:     [social-1, social-2]
  social-captions:      [social-1, social-2]
  seo-article:          [seo-1, seo-2]
  landing-copy:         [seo-1, seo-2]
  meta-tags:            [seo-1, seo-2]

# every deliverable goes through QA
qa:
  default: qa-lead
  # later split: dev work → qa-dev, everything else → qa-content

# client platform hints — lets "fix the Madam Muse store" route to shopify-dev without saying Shopify
platform_to_dev:
  shopify: shopify-dev
  webflow: webflow-dev
  wordpress: wordpress-dev
  custom: fullstack-dev
```

## Agent capabilities (what each can actually do)

| Agent | Produces | Tools | Needs your approval for |
|---|---|---|---|
| **COO** | Plans, task breakdowns, escalations, weekly summary | brain_read, create_plan, ask_ceo | Every plan (until you enable auto-approve for low-risk) |
| **EA & Report Desk** | Inbox triage, reply drafts, daily digest, meeting prep, client reports via RizeHub report tools | brain_read, gmail_read, gmail_draft, calendar_read, rizehub_reports | Sending any email, publishing reports |
| **Pipeline Desk** | Proposals, quotes, follow-up drafts, lead stage updates | brain_read, rizehub_leads, docs_write | Sending proposals / pricing |
| **Social Prospecting** | Lead Finder searches, researched lead lists, lead reports, outreach drafts | rizehub_leads, web_fetch, pagespeed, brain_read | You send every message yourself |
| **Job Scout** | Job shortlists, tailored application drafts, follow-up reminders | gmail_read (job alerts), web_fetch (allowed boards/RSS), brain_read (career files) | You submit every application yourself |
| **Client Success** | RizeHub accounts + workspaces, client brain files, access checklists, welcome/invite drafts | rizehub_onboarding, rizehub_readonly, brain_write (clients/), gmail_draft | Creating accounts/workspaces, sending invites and welcome emails |
| **Video Editor** | Reels/shorts cuts, ad edits, subtitles, colour grade, B-roll, motion titles, thumbnails with Graphic team | Magnific video tools (cut, concatenate, crop, color grade, upscale, generate), ffmpeg (sandboxed), brain_read (brand) | Sending to client / publishing |
| **Sound & Voice Specialist** | Voiceovers (TTS), custom voice direction, voice changing, dialogue isolation/cleanup, music beds, SFX, final mix & loudness | Magnific audio tools (tts, voice change, isolate, music, sfx), ffmpeg/sox (sandboxed) | Using a real person's voice (needs their written consent), sending to client |
| **Social + Inbound** | Comment/DM reply drafts, lead qualification | brain_read, (platform read APIs later) | Posting any reply |
| **Shopify Dev** | Sections, pages, fixes on unpublished theme | workspace, git, shopify_theme, playwright | Publishing theme, merging |
| **Webflow Dev** | CMS items, page edits, custom code | webflow_api, workspace, playwright | Publishing site |
| **WordPress Dev** | Pages, Elementor templates, plugin code | workspace, git, wp_rest (staging) | Pushing to live |
| **Full-Stack Dev** | Features, APIs, integrations | workspace, git, bash_sandboxed, supabase (dev projects) | Merging, deploying |
| **UI/UX ×2** | Wireframes, flows, HTML mockups, UX audits | figma_read, image_gen, workspace | Sending to client |
| **Graphic ×2** | Ad creatives, social graphics, banners | image_gen (Magnific), brain_read | Sending to client / running ads |
| **Social Mktg ×2** | Calendars, captions, hooks, repurposing | brain_read, web_search | Scheduling/posting |
| **SEO Writer ×2** | Articles, landing copy, meta, briefs, report commentary | semrush, web_search, brain_read, rizehub_reports (notes only) | Publishing |
| **QA Lead** | Verdicts, scores, evidence | playwright, lighthouse, web_fetch, brain_read (checklists), link_checker, rizehub_readonly | — (QA only passes/fails) |

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
| `rizehub_leads` (search, get, notes, lists, stage) | `RIZEHUB_KEY_LEADS` | Social Prospecting, Pipeline Desk |
| `rizehub_onboarding` (accounts, workspaces, config, invites) | `RIZEHUB_KEY_ONBOARDING` | Client Success |
| `rizehub_reports` (metrics, generate, notes, publish) | `RIZEHUB_KEY_REPORTS` | EA & Report Desk (all), SEO/Social (notes only) |
| `rizehub_readonly` | `RIZEHUB_KEY_READONLY` | COO, QA Lead |

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
| `qa` | QA Lead | Gemini Flash → Groq fallback | Opus 5.5 or Sonnet 5 |
| `dev` | Shopify, Webflow, WordPress, Full-Stack | Gemini Flash (draft-for-review mode) | Sonnet 5 |
| `reports` | EA & Report Desk | Gemini Flash | Sonnet 5 |
| `specialist` | Everyone else | Gemini Flash → Groq → OpenRouter free | Sonnet 5 |
| `light` | Agent chat, summaries, digests, routing | Groq small model | Haiku 4.5 |

You can override any single agent from the Agents page (e.g. try the Shopify Dev on Claude for a week and compare QA scores and cost).

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
brain/career/job-filters.md       # roles, rates, hours, red flags (Job Scout)
brain/career/portfolio.md         # portfolio links by platform + resume links
brain/career/application-style.md # tone rules + example applications that got replies
brain/company/services.md         # RizeHub packages → which workspace template each uses
```
The quality of the team is mostly the quality of these files. Start with 2–3 clients and 3 SOPs.
