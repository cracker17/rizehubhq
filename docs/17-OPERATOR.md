# 17 · Julev Operator (phase 1: LvlUp Google Chat, read + draft, tiered sends)

The Operator watches client chats in a **logged-in browser per client**, drafts replies with the client's **project
memory from the HQ Brain**, and posts only what the **tiers or Julev** allow. You watch it work on `/operator` and
answer on Telegram. Approved plan: vault `projects/rizehub-hq/operator-plan.md`.

## How it works

```
 workspace (deploy/workspace)              HQ (docker-compose.yml)                     Julev
 ┌───────────────────────────┐  CDP   ┌──────────────────────────────┐            ┌──────────────┐
 │ ws-lvlup  headful Chromium│◄──────►│ hq-operator  apps/operator   │  Supabase  │ Telegram bot │
 │  profile ./profiles/lvlup │ :9223  │  watch → classify → send     │◄──────────►│ /operator    │
 │  web viewer :3101 (auth)  │        │  Claude Agent SDK + HQ Brain │            │ Approvals    │
 └───────────────────────────┘        └──────────────────────────────┘            └──────────────┘
```

1. **Watch** (every `OPERATOR_POLL_MS`, 2 min): for each watched chat, the operator opens (or reuses) its own tab in
   the client's browser and reads the visible messages. New ones go to `operator_inbox`. The **first read of a chat is
   a baseline**: stored as history, never answered. Julev's own messages are history too.
2. **Classify + draft** (one message at a time, only while the AI budget allows): the prompt holds the client's rules,
   the project memory (`brain_project_bundle` + `brain_search`, curated kinds only: never the profile or raw
   transcripts), the last 15 messages of the chat and the new message. Claude (Agent SDK, no tools, structured output,
   ≤ `OPERATOR_MAX_USD_PER_MESSAGE`) returns: FYI / reply / task, the action types, a confidence, the draft, @mentions
   and a short task plan. Cost is recorded as `usage.operator` (counts toward Admin → API & AI budgets and `/budget`).
3. **Tiers** (in SQL, `operator_record_draft`; the worker cannot skip them): the strictest action type wins.
   | mode | default action types | what happens |
   |---|---|---|
   | auto | ack, status, thanks | posts by itself, **only** when `operator_auto_send` is on and confidence ≥ 0.75 |
   | approve | factual, reply, task, publish, deadline, commitment, money, new_contact, delete | Telegram: ✅ Send / ✏️ Edit / ⏭ Skip |
   | never | credentials | blocked, nothing sent, Telegram notice |
   Per client overrides: a row in `operator_autonomy` with the client slug (`'*'` = default). Phase 1 ships with
   `operator_auto_send` **off**: every reply asks. Turn it on when you trust it:
   `insert into settings (key, value) values ('operator_auto_send', 'true') on conflict (key) do update set value = excluded.value;`
4. **Send**: `operator_claim_send` refuses while **any** pause is on. The operator types the reply into the composer
   (quoting the message, @mentions picked from Chat's list so they are real chips), checks the composer holds exactly
   the approved text, asks the database once more (`operator_may_send`: a `/pause` that landed meanwhile stops it here),
   then presses Enter. Once Enter is pressed a failure is **never retried automatically** (it may have posted); a send
   stuck for 10 minutes becomes "failed: check the chat".

Every step is a row in `operator_actions` (the audit log; realtime feeds `/operator`).

## Kill switch and pauses

| How | Effect |
|---|---|
| Telegram `/pause` | office paused **and** `operator_paused` on: no client message is posted at all |
| Telegram `/pause lvlup` | only LvlUp's sends stop (reading and drafting go on) |
| `/operator` → Stop all sends | same as `/pause` for the operator |
| `/operator` → Take over | pauses that client's sends and opens its browser for you; Hand back resumes |
| `OPERATOR_SENDS=off` | the container never posts (drafts and approvals still work) |
| `OPERATOR_ENABLED=false` | the container idles |

`/resume` / `/resume lvlup` undo them. Every pause is logged.

## Telegram

- Reply drafts arrive like other approvals: the client's message, the draft (quoted), the action types, confidence,
  the task plan. **✅ Send** posts the draft, **✏️ Edit** takes your next message as the exact text to post, **⏭ Skip**
  drops it. They also go out during quiet hours (a client is waiting).
- `/inbox` lists waiting drafts; `/status lvlup` shows online state, 7-day counts and each chat's last read.
- Notices: every auto-sent reply, a failed or blocked send, a chat it can't read (e.g. signed out), a message it
  failed to draft 3 times.

## Operator page (`/operator`)

Live screen (the client's real browser through the viewer, with an "AI is working" overlay and Take over / Hand
back), "What it's doing" (each step as it happens), the inbox with each message's draft and outcome (decide in
Approvals), and watched chats (add with name + chat.google.com address, stop/watch). Demo data without Supabase.

## Live wall (`/wall`)

Every AI worker's screen at once, like a CCTV wall: the six HQ agents (from `agent_screens` + `activity_log`, live
over realtime) and one camera per Operator client (from `operator_actions`). Each camera shows the worker's app
(a screenshot when the agent saved one, else a rendering of its editor / browser / doc / sheet / chat), a Claude-style
cursor moving to what it works on with a highlight box and click ripple, the current step as a caption, REC + clock.
Click a camera for the big view with its recording: drag the scrubber (or pick a step) to replay what it did. The
cursor is a visual of the steps HQ records, not a video; the Operator's real screen is the live screen on `/operator`.

## Workspace (browsers)

`deploy/workspace/docker-compose.yml`: one `lscr.io/linuxserver/chromium` container per client (headful Chromium in
a web desktop, profile in `deploy/workspace/profiles/<client>`, gitignored: **it holds live logins**), plus a `socat`
sidecar that exposes Chrome's DevTools port as `ws-<client>:9223` on the private Docker network `operator-ws`, which
only `hq-operator` joins. CDP is never on a public interface. Chrome 136+ refuses remote debugging on its default
profile, so the profile is `/config/hq-profile`; an init script clears stale profile locks after a crash.

### Now: same box as HQ (Hostinger VPS)

Check memory first: `free -h` (each browser is capped at 1.5 GB; HQ + Jitsi + trades already run there).

```bash
cd /home/rizehq/rizehub-hq
docker network create operator-ws 2>/dev/null || true
cp deploy/workspace/.env.example deploy/workspace/.env && chmod 600 deploy/workspace/.env
#   set WS_VIEWER_PASSWORD to `openssl rand -base64 24` (keep it in your password manager)
mkdir -p deploy/workspace/profiles/lvlup
docker compose -f deploy/workspace/docker-compose.yml --env-file deploy/workspace/.env up -d
```

Viewer: DNS `ws.rizehub.ph` → the VPS, then `deploy/workspace/nginx-ws.rizehub.ph.conf` + certbot (header of that
file). Or, with no DNS yet, an SSH tunnel from your PC: `ssh -L 3101:127.0.0.1:3101 rizehq@76.13.222.107` and open
`https://localhost:3101` (accept the self-signed certificate). Set the page's live screen to
`https://ws.rizehub.ph/` (Operator → Add live screen address). Each further client gets its own hostname.

### Later: its own VPS (8 vCPU / 16–32 GB, Ubuntu 24.04, stable IP)

1. Keys-only SSH: create user `ws` with your public key, then in `/etc/ssh/sshd_config` set
   `PasswordAuthentication no`, `PermitRootLogin no`; `systemctl reload ssh`.
2. Firewall: `ufw default deny incoming; ufw allow OpenSSH; ufw allow 80,443/tcp; ufw allow 51820/udp; ufw enable`.
   Docker publishes ports past ufw, so the compose file binds the viewer to 127.0.0.1 and CDP to the WireGuard IP only.
3. Docker (docs.docker.com/engine/install/ubuntu) and WireGuard: tunnel HQ (10.66.0.1) ↔ workspace (10.66.0.2); allow
   9223/tcp only from 10.66.0.1: `ufw allow from 10.66.0.1 to any port 9223 proto tcp`.
4. Copy `deploy/workspace/` there, `.env` with `WG_ADDRESS=10.66.0.2`, then
   `docker compose -f docker-compose.yml -f docker-compose.remote.yml --env-file .env up -d`; nginx + certbot as above.
5. Move the profile (stop both sides first): `rsync -a deploy/workspace/profiles/lvlup/ ws@<new>:…/profiles/lvlup/`,
   or log in once more through the new viewer.
6. On HQ: `OPERATOR_CDP_LVLUP=http://10.66.0.2:9223` in `.env`, `deploy/update.sh --force`. Remove the workspace
   containers from the HQ box.

Profiles at rest: put `deploy/workspace/profiles` on an encrypted volume on the dedicated VPS (LUKS or the
provider's encrypted disk). Back them up only encrypted.

## Setup checklist (Julev)

1. Apply `supabase/migrations/20261015000000_operator.sql` (SQL editor, project rizehub-hq) **before** the merge
   reaches main.
2. Admin → API & AI: Anthropic key set, monthly budget > 0 (the operator never runs paid calls without it).
3. Start the workspace (above), open the viewer, log in to Google Chat (and Webflow / Airtable if wanted) with your
   LvlUp account; finish 2-step verification yourself. Log in once; the profile keeps it.
4. `.env` (master): `OPERATOR_ENABLED=true`, `OPERATOR_CDP_LVLUP=http://ws-lvlup:9223`, optionally
   `OPERATOR_SENDS=off` for a read-only first day. `deploy/update.sh --force` (splits `.env.operator`, restarts).
5. Tune the reader if needed (Google changes Chat's markup without notice):
   `docker compose exec operator ./node_modules/.bin/tsx src/probe.ts lvlup https://chat.google.com/room/<id> Julev`
   prints what each selector finds and the last messages it would store. Fix with `OPERATOR_GCHAT_SELECTORS`
   (JSON, e.g. `{"message":"div[data-id]","messageIdAttr":"data-id"}`) and restart.
6. `/operator` → Add chat for each LvlUp chat to watch (copy the address bar in the viewer), set the live screen.

## Verification (phase 1)

1. Post a test message in a watched LvlUp chat (from another account, or ask someone).
2. Within ~2 minutes: `/operator` shows "New message…" then "Drafted…", and Telegram shows the draft with the right
   project context (the memory facts it used are in the draft, the client rules are respected).
3. ✅ Send: the reply appears in the chat, quoting the message, with real @mention chips; the inbox row says Sent.
4. `/pause`, then approve another draft: nothing is posted (the row waits as Approved); `/resume` posts it.
5. Restart the browser container (`docker compose … restart ws-lvlup`) and the VPS: the viewer still shows Chat
   logged in, and `/status lvlup` reads the chats again.
6. Check the audit trail: `select action, ok, detail from operator_actions order by id desc limit 30;`

## Isolation and secrets

- `.env.operator` (scripts/split-env.mjs): Supabase service key, the vault key (only to read the dashboard's Anthropic
  key), the Anthropic key, budgets, model settings, `OPERATOR_*`. Never Telegram, never the brain's secrets, never
  the worker's internal secret. The container is read-only, no capabilities, unprivileged.
- The Claude Code child gets only harmless env + the API key; no tools, no MCP, no settings files.
- Chat text is fenced as data in the prompt; an injection attempt is told to show up as low confidence.
- Passwords are typed by Julev in the viewer, never by the operator, never stored in HQ or the vault.

## Risks to settle

- **Account ownership**: the LvlUp Webflow login in use is not Julev's own account, and Google Chat is a client
  Workspace account. Get the client's OK for a bot acting in their tools; ideally Julev's own Webflow seat + API token
  (details in the vault, not here: this repo is public).
- **Google re-verification** from datacenter IPs: keep one stable IP, log in through the viewer, expect an occasional
  "verify it's you" (the operator reports "can't read … signed out" on Telegram). A residential proxy is a last resort.
- **WhatsApp** (later phases): personal numbers read + draft only; the Business Cloud API for business numbers.
- **Google Chat markup** changes: the probe + selector overrides; the composer check refuses to send anything that
  doesn't match the approved text.
- **Costs**: per message ≤ `OPERATOR_MAX_USD_PER_MESSAGE`; the dashboard's monthly / daily budgets stop it.

## Phase 2: worker mode (jobs)

The operator also **does the work** a client asks for: it works in the client's logged-in workspace browser and their
APIs, checks the result like QA would, asks you before anything changes the outside world, tells the client when it is
done, and writes what it did to the project memory. You only add tasks (or approve "new task" drafts) and answer
approvals; Telegram tells you when a job starts, when it is done (with QA screenshots) and when the client was informed.
Schema: `supabase/migrations/20261016000000_operator_worker.sql`; code: `apps/operator/src/jobs/`.

```
 client asks in chat ──► "new task" draft ──► ✅ Send + start ─┐        /task lvlup Add Sam to the team page
                                                               ▼                     │
                                                  operator_jobs: queued ◄────────────┘
                                                               │  job loop (OPERATOR_JOB_TICK_MS)
                                                               ▼
     ┌──── run: Claude Agent SDK, ONLY the op tools (browser_*, fetch_url, check_links, qa_check, webflow, airtable,
     │     memory_search, report_progress, request_action, wait_for_approvals, finish), ≤ OPERATOR_MAX_USD_PER_JOB_RUN
     │                    │ request_action                                   │ finish(summary, links, client_update…)
     │                    ▼                                                  ▼
     │     approval "operator_action" ──✅──► action loop runs it    verifying: QA 375 / 1366 px, console errors,
     │     (Webflow CMS / publish, Airtable,   exactly as approved,   failed requests, overflow, links
     │      risky click, delete)               never retried            │ fail → next run with the findings (max_runs)
     └─────────── waiting ◄── results ─────────┘                       ▼ pass
                                              done → client update (tier 'status': approval "operator_update",
                                              Send / Edit / Skip) → posted in the chat → "📣 Client informed"
                                              + memories → HQ Brain proposals (approval "brain_proposal" / "operator_memory")
```

### What a job can and cannot do

- **Free**: read and navigate in the client's browser (own tabs, never your open ones), fill drafts in editors,
  screenshots, console, read Webflow (sites, collections, items, pages) and Airtable (bases, tables, records), fetch
  public pages, check links, search the project memory, run QA.
- **Only after your ✅** (`request_action` → Telegram "🚀"): Webflow CMS writes and publishing, Airtable writes, deletes,
  and any browser click that publishes / sends / submits / pays / invites / deletes. The browser tools refuse those
  clicks themselves (`jobs/guards.ts`: risky words, Enter in chat apps, password fields, private URLs); the API tools
  have no write operations at all. The approved action is run by the operator from the spec you saw, after the pauses
  are checked once more; a failed one is reported and **never retried** (it may have half-happened).
- **Never**: type passwords, read secrets, post in a client chat directly (that only happens through the outbox and
  its tier), use Claude Code's own tools (a hook denies everything that is not `mcp__op__*`).
- **Terminal** (`terminal` tool): only when agent commands are isolated from the operator's secrets (root in the
  container + `AGENT_UID`, or `DEV_SANDBOX_PREFIX`; same rules as the worker's `bash_sandboxed`). The shipped
  `hq-operator` container is unprivileged, so the terminal is **off** there; the startup log says which.

### Telegram (phase 2)

| You get | Buttons / what to do |
|---|---|
| 💬 REPLY with "(new task)" | **✅ Send + start** posts the ack and queues the job; ✏️ Edit = your exact text (+ starts); ⏭ Skip = neither |
| 🚀 action (Webflow change, Publish ⚠️, Airtable change, Click, Delete ⚠️) | **✅ Do it** · ✏️ Not like this (not done; the job reads your note) · ❌ Don't |
| 📣 CLIENT UPDATE | ✅ Send · ✏️ Edit (exact text) · ⏭ Skip. Auto-sent only if the `status` tier is auto **and** `operator_auto_send` is on |
| 🧠 MEMORY (session note / decision / next step) | ✅ Save · ❌ Drop |
| notices | 🛠 Started · ✅ Done (summary, links, QA, cost + QA screenshots as an album) · 🙋 Needs you · ❌ Job failed · 📣 Client informed (+ chat link) · ✅ Reply posted (every send, not only auto) · ☑️ / ⚠️ action done / failed · 🔑 signed out / 🔓 logged in again |

Commands: `/task <client> <what to do>` (the result goes to Telegram; no chat update unless the job came from a
chat), `/jobs [client]`, `/logins [client]`, plus `/status <client>` (now with jobs and logins). Client updates and
actions also go out in quiet hours (someone is waiting); memories wait for the morning. `/pause` stops jobs, actions
and client updates too (SQL refuses to claim them).

### Memory

When a job is done its summary becomes a **session note**, plus up to 5 **decisions** and 5 **next steps** it
reported. With HQ Brain M4 installed they are `brain_proposals` (hq-brain writes the approved ones into the vault);
without it they wait in `operator_memory` and `operator_memory_promote()` (daily, and after each job) hands them over
once M4 exists. The next job for the same client sees its recent work in the prompt, and `memory_search` finds the
rest. QA screenshots older than 30 days are deleted daily.

### Logins ("never log in again")

The workspace profile keeps the logins; `--restore-last-session` (deploy/workspace) keeps session-only cookies over a
restart. Each `operator_logins` row (LvlUp: Google Chat, Webflow dashboard, Airtable account page) is opened in its
own tab 15 s after the operator starts and every `OPERATOR_LOGIN_CHECK_MS` (6 h): a sign-in redirect, a visible
password field or a known logged-out page means signed out → one "🔑 Signed out" notice, and one "🔓" when it is back.
Add a site: `select operator_set_login_site('lvlup', 'shopify', 'Shopify', 'https://admin.shopify.com/', true);`.
Restart test: `docker compose exec operator ./node_modules/.bin/tsx src/logins.ts lvlup`.

### Environment (phase 2)

| Variable | Default | |
|---|---|---|
| `OPERATOR_JOBS` | on | off = only read + draft replies |
| `OPERATOR_JOB_TICK_MS` | 10000 | how often a queued job is looked for |
| `OPERATOR_MAX_USD_PER_JOB_RUN` | 2 | spend cap of one run (the monthly / daily budgets still apply) |
| `OPERATOR_LOGIN_CHECK_MS` | 21600000 | login checks (min 10 min) |
| `OPERATOR_WORKSPACES_DIR` | /tmp/operator-jobs | job sandbox folders (terminal only) |
| `OPERATOR_WEBFLOW_TOKEN_<CLIENT>` / `OPERATOR_AIRTABLE_TOKEN_<CLIENT>` | – | fallback API tokens; `scripts/split-env.mjs` puts them in `.env.operator` only |

API tokens come from the **Client Vault** first: add the credential on `/vault`, then
`select operator_set_credential('lvlup', 'webflow', '<credential id>');` (same for airtable). The token is decrypted in
the operator per call, never shown to the model, redacted from every tool result.

### Setup checklist (phase 2)

1. Apply `20261015000000_operator.sql` and then `20261016000000_operator_worker.sql` (SQL editor) before the merge.
2. Link the Webflow and Airtable tokens for LvlUp (Client Vault + `operator_set_credential`, or the env fallback).
3. Admin → API & AI: budget > 0 (a job run can use up to `OPERATOR_MAX_USD_PER_JOB_RUN`).
4. Workspace: `docker compose -f deploy/workspace/docker-compose.yml --env-file deploy/workspace/.env up -d` (picks up
   `--restore-last-session`), log in once per site in the viewer (Google, Webflow, Airtable).
5. `deploy/update.sh --force`; the operator log says `worker mode on: ≤ $2 per job run …`.
6. `/logins` on Telegram: all 🟢 after the first check.

### Verification (phase 2)

1. `/task lvlup Check the team page on mobile and list anything broken` (read-only): "🛠 Started", then "✅ Done" with
   a summary, the link, QA ✅ and two screenshots (375 / 1366 px). `/jobs lvlup` shows it done with its cost.
2. A task that needs a change (e.g. fix a typo in a CMS item): a "🚀 Webflow CMS change" approval with the exact
   fields; ❌ Don't → the job continues without it (or asks you); ✅ Do it → "☑️ Done", then QA, then "✅ Done".
3. A client asks for something in a watched chat: the draft says "(new task)" with **✅ Send + start**; after the job,
   a "📣 CLIENT UPDATE" approval; ✅ Send → posted in the thread, quoting the request → "📣 Client informed".
4. `/pause` while a job waits for an action: approving it does nothing until `/resume`.
5. Restart the workspace container and the operator: `/logins` stays 🟢; sign out of Webflow in the viewer → within a
   check "🔑 Signed out of Webflow".
6. `select action, ok, detail from operator_actions where job_id is not null order by id desc limit 40;` is the trail.

### A Claude Code terminal in the workspace desktop? (evaluated, not recommended by default)

Running Claude Code (or the Claude in Chrome extension) inside the client's workspace desktop would give a second
agent the same logged-in sessions **without** the operator's guards: no risky-click refusal, no approval gate on
publish / send / delete, no per-run spend cap or usage record, no audit rows, and a subscription seat used for client
work. Worker mode already covers what it would add (browser + QA + APIs + memory) inside those rules. If you want it
for hands-on debugging, use it yourself through the viewer while the client is on **Take over** (sends paused), sign
it out afterwards, and never leave it running unattended.

## Phase 3

Built milestone by milestone on `feat/operator-phase3`; each part lists its migration (apply them in order, after the
phase 1 and 2 ones).

### Jobs and reply rules on `/operator` (`20261017000000_operator_dashboard.sql`)

- **Jobs** (under the live screen): open jobs first (Queued, Working, Needs your OK, Checking), then the last week's
  finished ones. Each shows where it came from, runs used, cost, why it needs you, its summary, links and QA result,
  and every change it asked for (with **Decide** → Approvals). **Add task** queues a job (same as `/task`) and can
  name the chat the client update goes to; without one the result only goes to Telegram. **Cancel job** stops it and
  its waiting changes.
- **Reply rules** (right column): the auto-send master switch, and per reply type **Auto / Ask / Never** for the
  selected client or for all clients (the default). A client's own rule wins; **Default** removes it. Deadlines,
  commitments, publishing, money, new people and deleting can never be Auto; logins and keys are always Never
  (`operator_set_autonomy` enforces the same, so SQL is the rule even outside the page). Every change is logged
  (`autonomy.changed`, `autosend.on/off`) and shows in "What it's doing".

### Digests (`20261017010000_operator_digests.sql`)

Two Telegram digests a day, built from the database only (no AI, no cost). **Morning** (08:00): everything since
yesterday's evening digest plus what waits for you now. **Evening** (18:00): everything since the morning digest plus
what is still open. Per client: messages in, replies sent (and how many auto), client updates, what waits for you,
jobs done (with links), stuck and open, signed-out logins, failures; on top: kill switch / auto-send state, whether the
operator is online, and its spend. The operator calls `operator_digest_tick()` every minute; SQL saves each digest once
per local day (timezone setting), only within 3 hours of its time (a late restart never sends a stale morning digest),
as a `reports` row (`operator_morning` / `operator_evening`) the bot sends like the CEO digest (held in quiet hours).
Change the times on `/operator` → Reply rules → Digests (empty = off), or
`select operator_set_digest_times('07:30', null);`.

### Viewer login (HQ login instead of a second password)

The live screen (`ws.rizehub.ph`) opens only for the CEO signed in to HQ with 2FA. `/operator` (live screen, New tab,
Take over) goes through `/api/operator/viewer?client=<slug>`: HQ checks the session, signs a 12 h token for that viewer
host (HMAC with `OPERATOR_VIEWER_SECRET`, dashboard only) and hands it to the viewer's `/__hq/login`, which stores it
as an HttpOnly cookie for that host. nginx then asks `/api/operator/viewer-check` (auth_request) before every request;
no or a bad token → back to HQ (login if needed) → a fresh token. Tokens are bound to one viewer host. The browser
container keeps its own basic auth as a second lock, injected by nginx so you never type it.

Setup: set `OPERATOR_VIEWER_SECRET` (`openssl rand -hex 32`) in `.env`, `deploy/update.sh --force`; install the new
`deploy/workspace/nginx-ws.rizehub.ph.conf` and its auth snippet (commands in the file header), `nginx -t`, reload.
Check: open `https://ws.rizehub.ph/` in a private window → it sends you to the HQ login; from `/operator` the screen
loads with no password prompt. To end every viewer session at once, change the secret. Without the secret the
dashboard links to the viewer directly (phase 1: basic auth only).

## Phase 3+ (not built yet)

Gmail / Slack / Teams / WhatsApp Business watchers.
