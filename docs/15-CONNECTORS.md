# 15 · Connectors, Gmail accounts, storage and the Kimi backup model (M13 plan)

Status: **M13.2 + M13.3 MCP apps and M13.4 Gmail accounts built 2026-09-29** (migration `20260929020000_connectors.sql`, Admin → Connectors);
**Calendars (read-only, secret iCal address, §5b) built 2026-09-29 on branch `feat/calendar-ical`, not deployed** (migration
`20260929090000_calendar_ical.sql`); the rest planned. Research sources are listed at the end; every vendor detail was checked on
2026-09-29 against the vendor's own docs or live OAuth discovery files.

## Goal

From **Admin → Connectors** the CEO connects outside services in a short wizard, decides tool by tool what agents may
do, and picks which agents get each connection. Nothing that changes the outside world runs without the CEO's approval
(CLAUDE.md rule 4). Same page: Gmail accounts (App Password), Calendars (secret iCal address, read-only), and the storage where agents save images and deliverables
(Google Drive or Dropbox). Separately, Kimi becomes a paid backup model.

## 1. What connects, and how

| Service | Endpoint | How the CEO connects | Notes |
|---|---|---|---|
| Notion | `https://mcp.notion.com/mcp` | **Sign in** (one click) | OAuth, no API keys |
| Linear | `https://mcp.linear.app/mcp` | **Sign in**, or paste an API key | `/mcp/readonly` exists |
| Supabase | `https://mcp.supabase.com/mcp?project_ref=…&read_only=true` | **Sign in**, or paste a personal access token | Read-only by default in the wizard |
| Magnific | `https://mcp.magnific.com` | **Sign in** | Generation spends paid credits |
| Higgsfield | `https://mcp.higgsfield.ai/mcp` | **Sign in** | Generation spends plan credits |
| ElevenLabs | `https://api.elevenlabs.io/v1/mcp` | **Sign in** (needs CIMD, see §4) | Speech and agent tools; TTS likely spends credits |
| GitHub | `https://api.githubcopilot.com/mcp/` | Paste a fine-grained personal access token | No dynamic registration; `/readonly` or `X-MCP-Readonly: true` |
| HubSpot | `https://mcp.hubspot.com` | Own "MCP auth app" (client ID + secret), then **Sign in** | One-time app setup by the CEO |
| Meta Ads | `https://mcp.facebook.com/ads` | Own Meta app, then **Sign in** | **Can spend ad budget**: every write tool locked to "Ask me" |
| Dropbox (MCP) | `https://mcp.dropbox.com/mcp` | Own Dropbox app, then **Sign in** | Same app as storage (§6) |
| Google Drive (MCP) | `https://drivemcp.googleapis.com/mcp/v1` | Own Google OAuth client + Workspace Developer Preview | Developer Preview; storage uses the Drive API instead (§6) |
| Any other server | pasted URL (https) | Sign in if it supports it, else a token header | Custom |
| **Not possible** | Figma, Vercel, Canva | — | Figma and Vercel only allow approved clients; Canva needs app review. HQ keeps Figma's REST API (`figma_read`, token) |

## 2. The wizard (Admin → Connectors → Add)

1. **Pick** a catalog card (logo, what agents can do with it, "costs credits" / "can spend money" badges) or *Custom server*.
2. **Connect**: *Sign in with X* opens the vendor's consent page; or a key/token field (stored encrypted, never shown
   again); or, for own-app services, a short guide plus client ID/secret fields.
3. **Test**: the worker connects and lists the server's tools. Errors are plain ("The token was rejected", "This service
   only allows approved apps").
4. **Tools**: one row per tool with its description and a switch **Allowed / Ask me / Off**, pre-set (§3). Tools that
   spend money or credits show a badge.
5. **Agents**: tick the agents that may use it, pre-ticked by role (Designer: Magnific, Higgsfield, ElevenLabs;
   Web Developer: GitHub, Supabase; Writer: Notion; Sales: HubSpot, Gmail; COO: Linear, Notion).
6. **Done**: summary. The connector list shows status, tool count, agents, last used, with *Test*, *Reconnect*,
   *Edit tools*, *Edit agents*, *Disconnect*.

Connecting, switching a tool to **Allowed**, and adding agents ask for the 2FA code (same step-up as approvals).

## 3. Tool permissions

- **Allowed**: the agent calls the tool directly. Default only for tools the server marks `readOnlyHint: true`, or
  that a vendor read-only mode guarantees (GitHub `/readonly`, Linear `/mcp/readonly`, Supabase `read_only=true`).
- **Ask me**: the call becomes an `external_action` approval (action_type `mcp.call`, spec = connector, tool, arguments,
  shown in full). The task pauses; after approval the worker makes the call exactly once and the agent resumes with the
  result. Default for everything else: a missing annotation counts as "may write".
- **Off**: hidden from agents.
- **Locked rules** (the wizard can't loosen them): tools that spend ad budget (Meta), move money (Stripe) or contact a
  real person (any phone/call/SMS tool, e.g. ElevenLabs `make_outbound_call`) are never *Allowed*; outbound-call tools
  start **Off**. Generation tools of credit-based services (Magnific, Higgsfield, ElevenLabs) start at *Ask me*.
- **Tool changes**: the tool list is pinned at connect time. A new tool, or a changed description, arrives **Off**
  with a "Review" badge (protects against a server quietly adding or redefining tools).
- Tool results are untrusted data: capped (about 8 KB per result) and labelled as outside content in the agent prompt.

## 4. Architecture

**Database** (new migration `20260929020000_connectors.sql`; never edit applied ones):
- `connectors`: id, kind (`mcp` | `gmail` | `ical`; `storage` from M13.5), catalog_key, name, url, auth_type (`oauth` | `bearer` | `header` | `app_password`
  | `none`), auth_header, account_email, oauth_meta (issuer, client_id, scopes, expires_at; non-secret), status
  (`active` | `needs_reauth` | `error` | `disabled`), last_checked_at, last_used_at, last_error,
  **secret_cipher, secret_iv, key_version** (worker only).
- `connector_tools`: connector_id, name, description, input_schema, annotations, policy (`allow` | `ask` | `off`),
  locked_reason, badges (`credits` | `money` | `contact`), review_needed.
- `connector_grants`: connector_id, agent_id.
- Grants follow the Client Vault pattern: the CEO reads metadata but never ciphertext; secrets are written/read only by
  service-role RPCs guarded by `vault_service_guard()`; CEO changes go through RPCs that audit to `activity_log`.

**Worker**
- MCP client: `@modelcontextprotocol/sdk` 1.31 (v1 line; the vendor servers above still speak 2025-06-18 / 2025-11-25).
  Move to `@modelcontextprotocol/client` 2.x once the servers speak 2026-07-28. Streamable HTTP; SSE only as a fallback.
- OAuth client (MCP authorization spec): protected-resource discovery → auth-server metadata → client identity in this
  order: pre-registered (own-app services) → **CIMD** (client ID = `https://hq.rizehub.ph/oauth/client-metadata.json`,
  served publicly by the dashboard) → dynamic registration → PKCE S256 + `resource` parameter → issuer check on the
  redirect. Tokens are sealed with the vault keyring (`seal(…, 'connector:<id>')`), refreshed automatically; a failed
  refresh sets `needs_reauth` and tells the CEO.
- Routes (`x-hq-secret`): `/connectors/create`, `/connectors/test`, `/connectors/oauth/start`, `/connectors/oauth/finish`,
  `/connectors/delete`. Custom URLs: https only, public hosts only (same SSRF guard as the research tools).
- Tool bridge in `buildTools`: each granted, active connector adds AI SDK tools named `mcp_<connector>__<tool>`
  (Allowed → call; Ask me → approval + pause). Hermes agents get them through `/mcp` automatically.
- Executor: approved `mcp.call` approvals run in the existing approved-action loop with `external_action_exec`
  (claim → done/failed, max 3 attempts), then the paused task is requeued with the result.
- Limits: 60 s per call, per-task call cap, result truncation, everything logged (`mcp.tool_call`, arguments not logged).

**Dashboard**
- Admin → Connectors (list, catalog, wizard, detail page); `/oauth/client-metadata.json` (public);
  `/api/connectors/callback` (CEO session required; hands the code to the worker); step-up 2FA on the risky steps.

## 5. Gmail accounts (App Password)

All accounts are @gmail.com, so each connects with an **App Password** (Google's OAuth for Gmail is a restricted scope:
tokens expire every 7 days for unreviewed apps, and permanent access needs a paid security assessment).
- Wizard: turn on 2-Step Verification → create an App Password → paste it with the address → the worker checks IMAP
  (imap.gmail.com:993) and SMTP (smtp.gmail.com:465) → stored encrypted. Google revokes it when the Google password
  changes.
- Tools (replace today's single-account Google OAuth versions, which stay as a fallback): `gmail_read` (account,
  Gmail search syntax via IMAP `X-GM-RAW`), `gmail_draft` (saves to that account's Drafts via IMAP), `gmail_send` (queues a
  `gmail.send` approval holding the exact email; after the CEO approves, `connectors/gmailSend.ts` sends it once over SMTP,
  re-checking that the account is active, still at the send level and still granted to that agent).
- Per account: which agents, and a level: **Read only**, **Read + save drafts**, or **Read + drafts + send** (every email
  still waits for the CEO's approval, word for word; raising a level needs the 2FA code).
- Job hunting stays within OnlineJobs.ph's terms (no automated use, no account sharing): the Sales Agent reads the
  OnlineJobs/Indeed/LinkedIn **alert emails** in the granted accounts, scores the jobs and drafts applications; the CEO
  opens the listing and applies. Agents never log in to job sites (brain/playbooks/job-hunt.md).

## 5b. Calendars (Google Calendar, read-only, secret iCal address)

Why: the COO kept asking the CEO for "today's meetings" because `calendar_read` was a placeholder. App Passwords don't
cover Calendar, and Google's Calendar OAuth for personal accounts expires weekly unless the app is verified. Every Google
calendar has a read-only **Secret address in iCal format** instead (Calendar settings → the calendar → *Integrate
calendar*), which never expires until the CEO resets it.

- **Connect** (Admin → Connectors → *Calendars* → *Add a calendar*): the dialog walks through Google Calendar on a
  computer → Settings → pick the calendar → Integrate calendar → copy *Secret address in iCal format*. The CEO pastes it
  (password field), optionally names it and ticks agents (default COO); 2FA code when enrolled. Dashboard action
  `addCalendarAction` → worker `POST /connectors/ical/add` (`x-hq-secret`): the address must be https (`webcal://` is
  rewritten), have no login in it, end in `.ics` (the *public* `…/public/basic.ics` address is refused), then it is
  test-fetched and must parse as a VCALENDAR. Only then it is sealed (`seal(url, keyring, 'connector:<id>')`) and stored
  with `connector_insert` as kind `ical`, auth_type `none`, `url` null, settings `{timezone: 'Asia/Manila', host,
  calendar_name}`, catalog key `google_calendar` (or `ical` for other hosts).
- **The address is a credential** (docs/09): anyone with it reads the calendar. It is never in a readable column, a log,
  a tool result or an error message. Revoke by clicking **Reset** next to it in Google Calendar.
- **Fetching** (`apps/worker/src/connectors/ical.ts`): research SSRF guard on every hop (`safeFetch`: public hosts only,
  ≤3 redirects, must end on https), 20 s timeout, 5 MB cap. HTTP 401/403/404/410 = the address was reset → status
  `needs_reauth` ("Address stopped working"). Parsed feeds are cached per connector for 5 minutes (one process-wide cache
  shared by the tool and the Test button; Test always re-fetches).
- **Parsing**: `node-ical` 0.27 (bundles `rrule-temporal`): recurring events expanded with RRULE, EXDATE and
  RECURRENCE-ID overrides, VTIMEZONE/IANA zones and DST; cancelled events and cancelled instances are dropped. All-day
  events stay on their calendar date whatever the worker's own clock zone. Each event: start/end (ISO with the Manila
  offset, or the date for all-day), title, location, meeting link (Google Meet from `X-GOOGLE-CONFERENCE`, or Meet / Zoom /
  Teams / Webex found in location or description), organizer, guests with their answer, tentative, recurring.
- **Tool** `calendar_read` (`apps/worker/src/tools/calendar.ts`, listed before `researchTools` so it replaces the old
  placeholder): input `{from?, to?, account?}`; default = today in Asia/Manila; `YYYY-MM-DD` means whole days (`to`
  inclusive), date-times without an offset are read in Manila; at most 62 days and 100 events per calendar. Reads every
  active calendar granted to the agent (or the named one) and returns a compact list wrapped as outside data
  (`<calendar_events>`). No calendar granted → a message telling the agent the CEO connects one in Admin → Connectors →
  Calendars and **not** to ask the CEO to type the calendar.
- **Manage**: Test (re-fetch), Agents (`connector_set_grants`, 2FA for added agents), Turn off/on, Remove — the existing
  connector RPCs. No new SQL functions: the migration only widens `connectors.kind` to `gmail | mcp | storage | ical`.
- **Not verified yet**: a real Google secret address (tests use a Google-shaped fixture feed).

## 6. Storage: Google Drive and Dropbox

Storage is an HQ function (every deliverable and image gets saved), so it uses the plain APIs rather than MCP:
- **Google Drive**: the CEO's own Google Cloud OAuth client with the `drive.file` scope (HQ only sees files it created;
  a non-sensitive scope, so the app can be published without Google review and tokens don't expire weekly).
- **Dropbox**: the CEO's own app in the Dropbox App Console with *App folder* access (HQ only sees `/Apps/RizeHub HQ`),
  offline refresh token.
- Admin → Connectors → Storage: connect either or both, pick the **default**. Files go to
  `RizeHub HQ/<client or Internal>/<request title>/`. A `save_file` tool for agents, and QA-passed deliverables are
  saved automatically. Uploading to the CEO's own storage is internal (no approval); making a public/shared link is an
  approval.

## 7. Kimi as a backup model

- No free Kimi route exists (Moonshot has no free tier; OpenRouter has no `:free` Kimi; Groq retired it on 2026-04-15).
- Add a `moonshot` provider (OpenAI-compatible, `https://api.moonshot.ai/v1`, key `MOONSHOT_API_KEY`) to the router and
  price table, and put `moonshot:kimi-k2.6` (about $0.95 in / $4.00 out per million tokens) at the **end** of each role's
  free-profile list, so it only runs when Gemini, Groq and OpenRouter-free are all unavailable. `kimi-k3` ($3 / $15) is an
  option for the lead and QA roles later.
- It is paid, so it only runs when `MONTHLY_BUDGET_USD` > 0, and `DAILY_AI_BUDGET_USD` caps a bad day. Moonshot's new-account
  tier allows **3 requests/minute**, too low for an agent loop, so top up enough to leave tier 0.
- Also fix: OpenRouter models without `:free` must be priced as paid (today every OpenRouter call counts as $0).
- To test during the build: whether Kimi needs its `reasoning_content` sent back on tool-call turns.
- **Status (2026-09-29): code built on branch `feat/kimi`, not deployed.** `moonshot` provider + prices, Kimi last in every
  free role, a `kimi` profile (lead/QA `kimi-k3`, rest `kimi-k2.6`), and OpenRouter non-`:free` priced and budget-gated
  (docs/14 "Which models count as paid"). Router/usage tests cover it. Still to verify in production with a real key:
  multi-turn tool calls (`reasoning_content`), cached-token reporting, and the forced-outage acceptance below.

## 8. Build order and acceptance

| Step | What | Done when |
|---|---|---|
| M13.1 (code done, prod check open) | Kimi backup + paid-OpenRouter pricing | Router tests; a forced Gemini/Groq outage plans on Kimi and the cost shows on /costs |
| M13.2 ✅ | Connector core: migration, MCP client, Sign in (CIMD / dynamic registration), token paste, test, tool policies, approval + executor, wizard + list | Notion or Linear connected; an Allowed read tool works in a task; an Ask-me tool creates an approval that runs once after approval |
| M13.3 ✅ | Catalog: Magnific, Higgsfield, ElevenLabs, Supabase, GitHub; own-app form for HubSpot, Meta Ads, Dropbox MCP | Each connects and lists tools; locked rules hold |
| M13.4 ✅ | Gmail accounts (built first: the COO's inbox tasks were blocked) | Two accounts connected; job-alert search and a draft land in the right account; a send needs approval |
| M13.4b (code done, branch `feat/calendar-ical`) | Calendars: Google Calendar read-only via the secret iCal address, `calendar_read` | A real secret address connects; "what meetings today?" is answered from the calendar without asking the CEO |
| M13.5 | Storage: Drive + Dropbox, default picker, `save_file`, deliverable auto-save | A QA-passed deliverable appears in the default storage folder |
| then | API & AI panel, Tool logins (agreed earlier) | |

Each step: new migration only, tests, docs, and a heads-up before deploying (an open tab reloads itself after a deploy).

## 9. What the CEO sets up (one-time)

- **Kimi**: a Moonshot account (platform.kimi.ai), a top-up, an API key into `.env` (the API & AI panel later), and
  budget caps.
- **Gmail**: 2-Step Verification + one App Password per account.
- **Calendar**: copy each calendar's *Secret address in iCal format* (Google Calendar on a computer → Settings → the
  calendar → Integrate calendar) into Admin → Connectors → Calendars.
- **GitHub**: a fine-grained personal access token (repos HQ may touch; read-only first).
- **HubSpot / Meta Ads / Dropbox / Google Drive**: create the vendor app (guided in the wizard), redirect URL
  `https://hq.rizehub.ph/api/connectors/callback`.
- One-click services need nothing beforehand.

## Sources

Notion developers.notion.com/docs/get-started-with-mcp · Linear linear.app/docs/mcp · Supabase
supabase.com/docs/guides/getting-started/mcp · Magnific docs.magnific.com/modelcontextprotocol · Higgsfield higgsfield.ai/cli
· ElevenLabs elevenlabs.io/docs/eleven-agents/operate/hosted-mcp · GitHub docs.github.com (use-mcp/set-up-the-github-mcp-server)
· HubSpot developers.hubspot.com (integrate-with-the-remote-hubspot-mcp-server) · Meta developers.facebook.com
(ads-mcp-server-get-started) · Dropbox help.dropbox.com/integrations/connect-dropbox-mcp-server · Google
developers.google.com/workspace/guides/configure-mcp-servers · Figma developers.figma.com/docs/figma-mcp-server/remote-server-installation
· Vercel vercel.com/docs/agent-resources/vercel-mcp · Canva canva.dev/docs/apps/mcp/access · MCP authorization
modelcontextprotocol.io/specification/2026-07-28/basic/authorization · Kimi platform.kimi.ai/docs (api/chat, pricing/chat,
pricing/limits, models) · Groq console.groq.com/docs/deprecations · OnlineJobs.ph onlinejobs.ph/terms · Gmail App Passwords
support.google.com/mail/answer/185833
