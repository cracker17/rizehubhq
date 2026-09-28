# RizeHub HQ — AI Virtual Office · Build Spec

This folder is the complete plan for building **RizeHub HQ**: a team of AI employees you command with one message, a QA agent that verifies every deliverable, and a virtual office dashboard where you (the CEO) watch the team work and approve everything.

Everything is designed to **run locally first** (your laptop + Docker), then deploy unchanged to a Hostinger VPS.

## How to use these docs

Read in order. Each file is self-contained enough to hand to a developer — or to Claude Code — as a build instruction.

| File | What it covers |
|---|---|
| `00-README.md` | This overview |
| `01-ARCHITECTURE.md` | System design, components, tech stack, local vs production |
| `02-LOCAL-SETUP.md` | Step-by-step: from empty folder to running system on localhost |
| `03-DATABASE.md` | Supabase schema (full SQL), functions, security, realtime |
| `04-AGENTS.md` | The team roster, role file format, routing, models, tools per agent |
| `05-ORCHESTRATION.md` | Request lifecycle: one command → plan → tasks → work → QA → your approval |
| `06-DASHBOARD-UI.md` | Every page, component, and design token of the dashboard |
| `07-VIRTUAL-OFFICE.md` | The Gather-style office (top-down + isometric views): rooms, status behaviours, idle life, live POV screens, chat with agents, art pipeline |
| `08-TELEGRAM-BOT.md` | Commands, approval buttons, notifications |
| `09-SECURITY-CONNECTIONS.md` | Client Vault (client info + logins agents can use without seeing them), platform tokens, guardrails |
| `10-DEPLOY-VPS.md` | Moving from localhost to the Hostinger VPS at `hq.rizehub.ph`; the scripts live in `deploy/` (setup, update with rollback, backups, nginx/Caddy, Supabase setup) |
| `11-ROADMAP.md` | Milestones with acceptance criteria (the build order) and the current status of each |
| `12-RIZEHUB-INTEGRATION.md` | How HQ connects to RizeHub on the same VPS: the Agent API RizeHub exposes, keys, webhooks, testing |
| `14-MODELS-AND-COSTS.md` | Free AI setup now (Gemini, Groq, OpenRouter), switching to Claude or OpenAI later, and monthly cost estimates |
| `13-WORKFLOWS.md` | Playbooks: find leads (Lead Finder), find jobs + draft applications, onboard clients (account + workspace), monthly reports, proposals |
| `CLAUDE.md` | Drop into the repo root so Claude Code follows this spec while building |

## What RizeHub HQ does for you

Type a request on the website (or Telegram) and the AI team:
- **Finds leads** with the RizeHub Lead Finder, researches each one, and drafts outreach for you to approve
- **Finds jobs** and writes tailored applications; you click apply
- **Onboards clients**: creates their RizeHub account and workspace, sets it up, and drafts the welcome email and invite
- **Reports to clients** with the RizeHub report tools, with a human-written summary checked by QA
- **Does client work**: builds, fixes, designs and content, through the dev, design and content agents
- **Uses client logins safely**: you add client info and credentials to the Client Vault; granted agents can log in and work, but never see the passwords

You watch it all in a Gather-style virtual office: working agents at their desks, idle ones in the lounge, and a live view of any agent's screen. It runs on free AI models to start and switches to Claude or OpenAI by config (file 14).

HQ and RizeHub live on the same Hostinger VPS and talk through RizeHub's private Agent API (file 12).

## The system in one paragraph

You send `/assign Madam Muse needs a bundle landing page with SEO copy and 3 ad graphics, due Friday` from Telegram or the dashboard. The request is **staged** in Supabase. The **COO agent** reads it plus the client file, writes a plan (tasks, owners, order, acceptance criteria) and sends the plan to your **Approval Inbox**. You approve. The **worker** dispatches each task to the right specialist agent when its dependencies finish. Every output goes to the **QA agent**, which tests it against the acceptance criteria and sends it back for revision or forward to you. Anything external — publishing, sending, merging, deploying — waits for your approval. The **virtual office** shows each agent as a character: at its desk when working, on a coffee break when idle, raising a hand when it needs you.

## Guiding principles

1. **CEO approves everything external.** Agents draft, build on staging, and propose. Only you publish, send, merge, or spend.
2. **Every deliverable is QA'd** by a separate agent before it reaches you.
3. **Start small.** Two agents working end-to-end beats six half-working ones. Add roles one at a time.
4. **Everything is logged.** Every agent action, tool call, cost, and decision is in the activity log.
5. **Local first, cloud later.** The same code and Docker setup runs on your laptop and on the VPS.
