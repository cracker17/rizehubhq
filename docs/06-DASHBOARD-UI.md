# 06 · Dashboard UI / UX

**Visual reference:** Mockup A (the clean-text dark dashboard: left sidebar, 4 KPI cards, Office Floor grid, Approvals column, Today's Activity strip). The **Isometric 2.5D** concept is the reference for the Office map (see 07).

## Design tokens

```css
:root {
  /* surfaces */
  --bg:            #0B0A1F;   /* page background, deep indigo-navy */
  --bg-gradient:   radial-gradient(1200px 600px at 70% -10%, #2A1F6B55, transparent);
  --panel:         #15133A;   /* cards */
  --panel-2:       #1C1947;   /* inner cards (agent tiles, approval items) */
  --border:        #2C2863;   /* 1px card borders */
  --border-active: #7C5CFF;   /* selected nav item / focused card */

  /* text */
  --text:          #F3F2FF;
  --text-muted:    #A09CC9;
  --text-dim:      #6E6A9E;

  /* brand + status */
  --primary:       #6D4AFF;   /* New Request button, badges, links */
  --primary-hover: #7C5CFF;
  --success:       #1F9D6B;   /* Approve, working dot, QA pass */
  --warning:       #F5A524;   /* idle / coffee, waiting */
  --danger:        #E5484D;   /* Reject, blocked, QA fail */
  --info:          #3BA7FF;
  --teal:          #14B8A6;   /* charts, QA */

  /* shape */
  --radius-card: 20px;
  --radius-item: 14px;
  --radius-btn:  10px;
  --shadow:      0 10px 30px rgba(0,0,0,.35);
}
```
Font: **Inter** (400/500/600), numbers in KPI cards 40px/600. Icons: lucide, 18px, stroke 1.75. Dark mode only for v1.

Status → color mapping (use everywhere: dots, bubbles, progress bars):
| Status | Color | Label |
|---|---|---|
| working | `--success` | Working / Building / Writing (verb from task work_type) |
| idle | `--warning` | On break |
| waiting | `--primary` | Needs you |
| blocked | `--danger` | Blocked |
| offline | `--text-dim` | Offline |

## Layout

```
┌──────────────┬─────────────────────────────────────────────────────────────────┐
│ RizeHub  │ [ Search agents, tasks, requests…        ]   [New Request] 🔔 Julev │
│ HQ           ├─────────────────────────────────────────────────────────────────┤
│              │ [Active Agents] [Pending Approvals] [Tasks Done Today] [QA Pass] │
│ ▣ Office     ├──────────────────────────────────────────────┬──────────────────┤
│ ✓ Approvals 7│  OFFICE FLOOR        [Grid | Office] toggle  │ APPROVALS  7     │
│ ☰ Tasks      │  isometric office map OR agent grid          │ item cards with  │
│ ▤ Reports    │                                              │ Approve/Edit/    │
│ ◎ QA Center  │                                              │ Reject           │
│ ⚑ Leads      │                                              │                  │
│ ⌕ Jobs       │                                              │                  │
│ ◉ Clients    │                                              │                  │
│ ☺ Agents     ├──────────────────────────────────────────────┴──────────────────┤
│ 🔌 Connections│ TODAY'S ACTIVITY  timeline →                                     │
│ ⚙ Settings   │                                                                  │
└──────────────┴─────────────────────────────────────────────────────────────────┘
```
- Sidebar 264px, collapses to icons < 1280px, becomes bottom tab bar on mobile (Office, Approvals, New, Reports, More).
- Content max width 1680px, 24px gutters desktop / 16px mobile.
- Mobile priority: **Approvals first** — on phones, the home screen shows KPI row + approval list, office below.

## Pages

### 1. Office (home) `/`
- **KPI cards:** Active Agents (working / total enabled, sparkline of today), Pending Approvals (count, bars by kind), Tasks Done Today (count, sparkline), QA Pass Rate (7-day %, bars).
- **Office panel** with a toggle (default = Isometric map on desktop, Grid on phones):
  - **Map · Isometric** (main): the 2.5D office from the chosen concept (07). Characters walk between desks, lounge and boardroom by status.
  - **Map · Top-down** (optional, added later): same office, flat view.
  - **Grid** (mockup A): 3–4 column tiles. Tile = avatar, name, status label, status dot, progress bar, "Task: …" line.
  - In every view, clicking an agent opens the **Agent panel** (below).
  - "Full screen office" button opens `/office`, the map alone, for a big monitor.
- **Approvals column:** latest 5 pending, thumbnail, title, agent, due, **Approve / Edit / Reject**. "View all" → Approvals page.
- **Today's Activity:** horizontal timeline of key events (request created, plan approved, QA pass/fail, deliverable approved). Realtime.

### 2. Approvals `/approvals`
- Tabs: **Pending · Plans · Deliverables · Actions · History**.
- List left, detail right (sheet on mobile).
- **Plan detail:** summary, assumptions, questions (answer inline), task table (agent, work type, depends on, criteria), cost estimate. Buttons: Approve plan · Edit (reassign agent, edit criteria, remove task) · Reject.
- **Deliverable detail:** output preview (rendered markdown / images gallery / iframe preview URL / diff viewer for code), **QA report** (score ring, checks list with pass/fail, evidence screenshots), files download.
- **Action detail:** exact action ("Publish theme 'Bundle v2' (#1402) to madammuse.co"), risk label, what happens on approve.
- Keyboard: `A` approve, `R` request changes, `J/K` next/prev.

### 3. Tasks `/tasks`
- Kanban columns: Queued · Working · QA · Needs You · Done (today). Filters: client, agent, request, priority.
- Card: title, client chip, agent avatar, revision count badge, cost.
- Task drawer: instructions, criteria checklist, live agent log (streamed from activity_log), outputs, QA history, timeline.

### 4. Requests `/requests` + **New Request modal**
- New Request modal (from top bar): big textarea ("Tell the team what you need…"), optional client picker, priority, due date, attachments (files/links). Submit → staged → toast "COO is planning…".
- Requests list: title, client, status pipeline (staged → planning → review → in progress → done), progress % (tasks done / total), cost.

### 5. Daily Reports `/reports`
- Date picker. **CEO Digest** on top (from EA): done today, in progress, blocked, approvals waiting, spend.
- Below: each agent's standup card (Done / Next / Blockers).
- Weekly tab: COO weekly summary + charts (tasks by department, QA pass rate trend, cost by client).

### 6. QA Center `/qa`
- Stats: pass rate, avg score, avg revisions, top failure reasons (from checks).
- Review feed: each review with verdict, score, evidence thumbnails.
- Per-agent quality table (who fails QA most → improve that role file).

### 7. Clients `/clients`
- Client cards: name, platforms, service package, RizeHub workspace link, next report date, active requests, spend this month.
- Client page: profile & brand (edit → writes to `brain/clients/<slug>/`), requests history, reports history (from RizeHub), access checklist (what's still missing), connections status.
- **Onboard client** button → opens New Request prefilled with the onboarding playbook.

### 7a. Client Vault (inside each client page → **Access** tab)
- Add/edit client info (company, contacts, platforms, URLs, notes) and **logins/credentials** (see 09 "Client Vault").
- Form per credential: platform, login URL, username, password or API token, 2FA method, scopes/notes, which agents may use it, expiry reminder.
- After saving, secrets are **masked**. "Reveal" needs your password again (or TOTP) and is logged. Agents never get a reveal button.
- Each credential shows: status (active/expiring/revoked/failed login), last used by which agent and when, and a **Revoke** button.
- "Request access from client" button creates a secure one-time link where the client enters logins themselves (goes straight into the vault).

### 7b. Leads `/leads`
- Pipeline board: New → Researched → Drafted → Contacted → Replied → Proposal → Won / Lost (stages read from RizeHub via `rizehub_refs`).
- Lead card: company, site, platform, main signal (e.g. "LCP 6.2s"), fit score, agent's recommended angle, link to open in RizeHub Lead Finder.
- **Find leads** button → New Request prefilled: platform, country, signal, count.
- Stats: leads found this week, reply rate, proposals sent, won.

### 7c. Jobs `/jobs`
- Table from `job_opportunities`: title, company, source, rate, fit score, red flags, status.
- Row → drawer with the full listing link, why it fits, and the tailored draft with **Copy** + **Open job** buttons; **Mark applied** button sets status and schedules the follow-up.
- Filters: platform, source, status, score ≥ X.

### 8. Agents `/agents`
- Roster table: avatar, name, department, model, status, tasks today, QA pass %, cost today, enabled toggle.
- Agent page: role file editor (markdown with front-matter), budget, model select, skills, stats, recent tasks.

### 8a. Costs `/costs`
- Meter: today's AI spend vs `DAILY_AI_BUDGET_USD` (else `settings.daily_budget_usd`; 0 = no cap) with the 80% alert mark; teal < 80%, warning ≥ 80%, danger at 100% (paid models stopped, free profile takes over). Status always shown as icon + label, not colour alone.
- Stats: last 7/30 days, month to date, model runs, prompt-cache read share. Range tabs: last 7 / last 30 days.
- Spend by day (bars, cap as a dashed line, table view), by agent, by client ("Internal" for no client), top tasks by cost (task run + its QA reviews), model mix (runs, tokens, spend, share; paid vs free).
- Data: `ai_usage` view (one row per model run, Manila day; migration `20260928100000_costs_handoff.sql`). DEMO mode: generated paid-profile usage (`lib/data/costsModel.ts`).

### 9. Connections `/connections`
- Per client × platform grid: status (active / expiring / revoked / missing), scopes, last used. Revoke button (marks revoked + instructions to revoke at the platform). Shows every API token and login from the Client Vault in one grid, plus system-level keys from the server env. Secrets are entered through the vault form and never displayed again without re-authentication (see 09).

### 10. Settings `/settings`
- Budgets (global daily, per agent default), digest time, QA thresholds per work type, auto-approve rules (off by default), Telegram link status.
- Built in M12 (moved to Admin → Security, §11): **Two-factor sign-in** card (status pill "2FA on/off", *Set up 2FA* → QR + setup key shown once → code → on)
  and **Auto-approve rules** card (the always-on guards, rule list with on/off switch, edit/delete, "Add rule" dialog:
  name, max estimated cost, max tasks, internal work-type chips, client scope chips, recent auto-approvals/skips).
  Turning a rule on asks for the 2FA code (StepUpDialog). Spec: docs/05 "[3]", docs/09 "Two-factor (TOTP)".

### 11. Admin `/admin`
- Sidebar: an **Admin** group under the main pages (Security, Connections, Settings; API keys, tool logins and connectors join it as they ship). On phones the bottom bar's **More** opens `/admin`, which lists the admin tools and every page the bar has no room for.
- **Security** `/admin/security`: *CEO password* card (current password, new twice, 2FA code when on; live rule hints; "Show passwords") and the *Two-factor sign-in* card (set up; turn off with password + code, e.g. for a new phone). Spec: docs/09 "CEO password" + "Two-factor (TOTP)".
- **Connectors** `/admin/connectors` (docs/15): *Gmail accounts* card (address, status, Read only / Read + save drafts, which agents, last used, last error; Test, Access, Replace password, Turn off/on, Remove) and the *Add a Gmail account* dialog (Google links, address + App Password, label, agent checkboxes preset COO + Sales, mode, 2FA code). Adding an account, adding agents, allowing drafts and turning it back on ask for the 2FA code. *Apps (MCP)* card: connected apps (status, tools on, to-review count, agents, last used; Tools / Agents / Refresh tools / Disconnect) and the catalog (packages/shared `MCP_CATALOG`: Sign in / token / own app, credit and money badges) + *Any other MCP server (URL)*. Connect dialog: sign-in, token or own OAuth app (shows the redirect URL), agents, 2FA code; sign-in returns via `/api/connectors/callback` and opens the Tools dialog: per tool Allowed / Ask me / Off, locked tools can't be Allowed, *Review* badge for new/changed tools. `/oauth/client-metadata.json` is HQ's public OAuth client id (CIMD).
- Sign-in page: *Forgot password?* → email a reset link → `/auth/confirm` → 2FA step (when on) → `/reset-password`.

### Voice input
- A **mic button** sits next to Send in the agent chat and in the New Request box. Tap to record, tap again to stop (Esc
  cancels, 2 minutes max). The clip goes to `/api/transcribe` (CEO session only) → worker `POST /transcribe` →
  Whisper from `config/models.yaml` `transcription:` (Groq `whisper-large-v3-turbo`, then `whisper-large-v3`), and the
  text is added to the box to check before sending. The audio is never stored; `activity_log` gets `usage.transcribe`
  (model, seconds, source; no text). Browsers record WebM/Opus (Chrome, Edge, Firefox) or MP4 (Safari).
- **Voice mode** (agent chat, remembered per browser): what you say is sent straight away and the reply is read aloud
  with the browser's built-in voice (free, on-device).
- Telegram voice notes are the next step (the bot has no worker secret, so they go through Supabase).

## Agent panel (click any character/tile)
Tabs: **Screen** (live POV monitor, 07 §6) · **Chat** (07 §7) · **Task** · **Today**.

Header: avatar, name, status pill, current activity ("☕ On coffee break" / "Building bundle page 60%").
Sections: Current task (with live log) · Queue · Today's standup · Stats (tasks, QA %, cost) · Buttons: Pause agent · Open role file.

## Realtime wiring
```ts
supabase.channel('office')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'agents' }, onAgent)
  .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, onTask)
  .on('postgres_changes', { event: '*', schema: 'public', table: 'approvals' }, onApproval)
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activity_log' }, onActivity)
  .subscribe();
```
Keep a client store (Zustand) keyed by id; the grid, office scene, KPIs, and badges all read from it.

## Auth
Supabase email/password login (your account only) + **TOTP 2FA** (the dashboard holds client logins) → middleware protects all routes; with 2FA on, `/login?step=totp` asks for the code after the password. Sessions expire after 12 h; revealing a vault secret re-asks for your code. Approving a high-risk external action opens a "Confirm with 2FA" dialog (code valid for 5 minutes of approvals); those items show a "High risk" line in the action detail. Details: docs/09 "Two-factor (TOTP)".

## Build order for the UI
1. Static shell + tokens + sidebar + top bar (mock data)
2. Office grid view + KPI cards + approvals column + activity strip (mock data) — should match mockup A
3. Wire Supabase + realtime
4. Approvals page (the most important working page)
5. Tasks, Reports, QA Center
6. Office map: isometric (07); top-down view later if needed
7. Agents, Clients, Connections, Settings
