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

Viewer: DNS `ws.rizehub.ph` → the VPS, then `deploy/workspace/nginx-viewer.conf` + certbot (header of that
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

## Phase 2+ (not built yet)

Webflow Data API + Airtable PAT tools (approval-gated publish), session notes as Brain proposals, Gmail / Slack /
Teams / WhatsApp Business watchers, morning / evening digests, per-client autonomy editing on `/operator`, HQ-login
gating for the viewer (today: its own basic auth + HTTPS).
