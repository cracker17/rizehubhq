# 09 · Security & Platform Connections

## Principles
1. **Prefer scoped API tokens and collaborator accounts** over passwords. Store a password only when a platform offers nothing else.
2. **Agents never see secrets.** Tokens and passwords live encrypted in the Client Vault; the worker's tools use them at call time. The AI model only sees results.
3. **One token per client per platform**, least privilege, revocable on its own.
4. **Outside-world changes require CEO approval** (publish, merge, send, deploy, spend).
5. **Everything is logged** — every tool call with agent, client, action, result.

## Per-platform setup

### Shopify
- Get **collaborator access** to the client store (you log in yourself).
- Create a **custom app** (store admin → Apps → Develop apps / Dev Dashboard) with only needed Admin API scopes, e.g. `read_products`, `read_themes`, `write_themes`, `read_content`, `write_content`. Copy the Admin API access token.
- For theme pushes via Shopify CLI, install the **Theme Access** app and create a theme password for your team email.
- **Guardrail in tool code:** theme write operations only allowed on theme IDs where `role != 'main'` (unpublished). Publishing = `external_action` approval.

### GitHub
- Create a **fine-grained personal access token** (or a GitHub App later) limited to selected repos: Contents read/write, Pull requests read/write, Metadata read. No admin, no workflows unless needed.
- Protect `main` in every repo: require PR + your review. Agents push to `agent/<task-id>` branches and open PRs.
- Merge = `external_action` approval (or you merge in GitHub).

### Figma
- **Personal access token** with read scopes (file content, comments read). Agents read frames and export assets; they don't edit your Figma files in v1.

### Webflow
- **Site API token** per site from Site settings → Apps & integrations, scopes limited to what's needed (e.g. CMS read/write, pages read). Agents edit CMS items as drafts.
- Publishing the site = `external_action` approval.

### WordPress
- **Application Passwords** (Users → Profile) for a dedicated `rizehub-agent` user with Editor role — on **staging** sites first. Never an admin account. Pushing to live = approval.

### RizeHub (your own app)
- Separate scoped **Agent API keys** per agent group (`RIZEHUB_KEY_LEADS`, `_ONBOARDING`, `_REPORTS`, `_READONLY`), stored hashed in RizeHub, revocable individually. Details in 12.
- Agent API reachable only on the private Docker network, never from the internet.
- Account/workspace creation, invites, report publishing = approvals.
- HQ never uses a RizeHub admin login or its database password.

### Gmail / Calendar (EA) — later
- **Built (M13.4, docs/15 §5):** @gmail.com accounts connect with a Google **App Password** in Admin → Connectors (IMAP read-only; drafts via IMAP; sending only per email after the CEO approves it, level *Read + drafts + send*). The App Password is tested against Google, sealed with the vault keyring (context `connector:<id>`) and stored in `connectors.secret_cipher` (browser role can't read it); agents get only accounts granted to them; a rejected password marks the account *needs a new App Password*. The OAuth plan below stays for Calendar.
- Google OAuth with `gmail.readonly` + `gmail.compose` (drafts only) + `calendar.readonly`. Sending = approval, executed by worker code.

### Social platforms & job sites
- The Sales Agent **drafts only** (outreach, DM replies, follow-ups). You send social messages yourself — automated DMs break platform rules and risk your accounts.
- The Sales Agent (job search) reads job alerts and public feeds only; it never logs into job sites or submits applications. You apply.

### Outreach & personal data
- Lead data: business contact info only. Suppression list (opt-outs) stored in RizeHub and checked before every send.
- Cold email only from a separate warmed-up sending domain, volume-capped, with opt-out link; follow the lead country's anti-spam law and the PH Data Privacy Act.

## Client Vault (client info + logins your AI team can use)

You add each client's details and access (logins, API tokens, app passwords, hosting/FTP, CMS logins) in the dashboard: **Clients → client → Access**. Any agent you grant can then use them. Design:

**Storage**
- Table `client_credentials` stores secrets **encrypted** (AES-256-GCM, envelope encryption). The encryption key `VAULT_MASTER_KEY` lives **only in the worker's env** on the VPS, not in Supabase, the dashboard or git. Someone with only the database gets ciphertext.
- The dashboard sends new secrets to a server action that forwards them to the worker's `/vault/store` endpoint (private network) for encryption; the browser never reads a secret back.
- Non-secret fields (platform, login URL, username, notes, 2FA method) are stored in plain columns so agents and the UI can see what exists.

**Using a credential (agent side)**
- `vault_login`: the worker launches an isolated Playwright browser profile for that task, fills username + password itself, and hands the logged-in page to the agent. Password fields are blurred in every screenshot, and the POV screen, logs and chat are redacted.
- `vault_api`: the worker adds the token to the request itself.
- The model's prompt never contains the secret, so it can't leak it in output, and this also keeps secrets away from free-tier AI providers.
- Sessions are closed and cookies deleted when the task ends.

**Access control**
- **Grants**: each credential lists which agents may use it (e.g. Madam Muse Shopify login → Web Developer + QA only). No grant, no access.
- **Scope notes** are shown to the agent ("theme edits on unpublished themes only; never touch orders or payments") and enforced by the tool layer where possible (URL allowlist per credential, e.g. only `/admin/themes`).
- **Risky actions** during a logged-in session (publish, delete, change settings, anything involving payments) still require an approval.
- **2FA**: prefer adding your team email as a collaborator with its own 2FA. If a login asks for a code, `vault_request_2fa` pings you on Telegram and you reply with the code; the task waits. Storing TOTP seeds is off by default (can be enabled per credential if you accept the risk).

**Audit & hygiene**
- Every use is logged in `credential_access_log`: agent, task, action, time, success or failure. It's visible on the credential and in the activity log.
- Revealing a secret in the dashboard requires re-authentication and is logged too.
- Expiry reminders, a "rotate" button, and auto-revoke of grants when a client is archived.
- Failed logins flag the credential "check needed" and stop retries after 2 attempts (avoids locking the client's account).

**Clients & consent**
- Get the client's written OK (in your contract or onboarding form) to store and use access for the agreed work.
- Better: send the client the **secure access link** (one-time, expires in 72 h) so they enter logins themselves, and ask them to create a separate user or collaborator account for you rather than sharing their own.
- Some platforms forbid shared logins (e.g. Shopify expects collaborator accounts). Use their proper access method whenever it exists.

### Internal vault (Admin → Tool logins)

The agency's **own** tool accounts (Semrush, Ahrefs, Canva, Figma, Shopify Partner, GitHub, hosting, Google, Meta…) use the Client Vault itself, not a parallel system (migration `20260929060000_internal_vault.sql`, UI docs/06 §11):
- They are `client_credentials` of one special client row, **RizeHub (internal)** (`clients.is_internal = true`, slug `rizehub-internal`). `internal_client_id()` (CEO session or service role, `hq_guard`) returns it and creates it on first call; a unique partial index allows only one.
- Everything above applies unchanged: worker-side AES-256-GCM encryption, per-agent grants, URL allowlist, API write allowlist, publishing always needs an approval, reveal needs the CEO password + 2FA code, two failed logins → "check needed" and no more tries, `vault_request_2fa` for sites that ask for a code, every use in `credential_access_log` + `activity_log` (with `client_id` = the internal client).
- **Scope difference:** a client's logins are listed only for tasks of that client. Tool logins are usable in **any** task, with or without a client: `vault_list_for_agent(agent, client | null)` returns the client's granted credentials plus `tools` (the internal client's credentials granted to that agent) and `tools_not_granted` (a count). `vault_get_for_agent` already checks only the grant and the status, so a granted tool login works from any task; an ungranted one is refused ("not granted") and the attempt logged.
- The internal client is not a customer: it is hidden from the Clients page, the New Request / Tasks client pickers, auto-approve client scopes, the Telegram `/assign` client lookup and Connections (tool logins have their own page), and `/clients/<its id>` is a 404.
- It can never be archived (archiving would revoke every grant) or deleted (would delete the logins), and `is_internal` can't be flipped: trigger `clients_protect_internal`.
- Prefer a team seat or a login made for the agents over a personal account, and a read-only / least-privilege API key where the tool offers one.

## Where system secrets live

**v1 (local + VPS):** env file readable only by the worker. On the VPS the master `.env` is split per container (`scripts/split-env.mjs` → `.env.worker`, `.env.bot`, `.env.dashboard`); the dashboard file never holds the service-role key or `VAULT_MASTER_KEY` (`check-env --split` fails the deploy otherwise). See docs/10.
```
# .env.worker   (chmod 600, never committed)
GOOGLE_GENERATIVE_AI_API_KEY=...   # free tier: never send secrets or confidential client data here
GROQ_API_KEY=...
OPENROUTER_API_KEY=...
ANTHROPIC_API_KEY=                 # later
OPENAI_API_KEY=                    # later
SHOPIFY_TOKEN_MADAM_MUSE=shpat_...
SHOPIFY_STORE_MADAM_MUSE=madammuse.myshopify.com
GITHUB_TOKEN_DEFAULT=github_pat_...
WEBFLOW_TOKEN_MID_AM=...
FIGMA_TOKEN=figd_...
RIZEHUB_API_URL=http://rizehub-app:8080/agent-api/v1
RIZEHUB_KEY_LEADS=rzh_...
RIZEHUB_KEY_ONBOARDING=rzh_...
RIZEHUB_KEY_REPORTS=rzh_...
RIZEHUB_KEY_READONLY=rzh_...
RIZEHUB_WEBHOOK_SECRET=...
```
`connections.secret_ref` stores only the **name** (`SHOPIFY_TOKEN_MADAM_MUSE`), never the value. Per-client logins and tokens you add in the dashboard go to the Client Vault (above); the env file keeps only system keys (AI providers, RizeHub Agent API keys, `VAULT_MASTER_KEY`). Back up `VAULT_MASTER_KEY` offline (e.g. password manager); if it's lost, stored secrets can't be decrypted.

**v2:** move to a secrets manager (Supabase Vault, Infisical, or Doppler) → rotate from one place.

## Worker guardrails (implement in tool layer, not prompts)

| Guardrail | Implementation |
|---|---|
| Tool allowlist per agent | `resolveTools(role.tools)` — agent can't call unlisted tools |
| Workspace jail | File tools reject paths outside `workspaces/<task-id>` and read-only `brain/` |
| Shell allowlist | Only `git, node, pnpm, npm, npx shopify, lighthouse, playwright` (+ file utilities); block `curl|wget` to non-allowlisted hosts, `rm -rf` outside workspace, `env`, `cat .env`. Never `node -e/-p/-r/--import/--eval/--require`, never a script outside the jail. Anything that runs workspace code (`node <script>`, `npm run/test/start`, `pnpm <script>`, `npx` beyond `@shopify/cli`, `tsc`, `eslint`, `prettier`, `theme-check`, `lighthouse`; `playwright test`) only when the command is isolated (next row) |
| Agent uid | The worker runs as root **inside its container** only so it can start every agent command (bash_sandboxed, and git/npm the dev tools run for agents) as `AGENT_UID`/`AGENT_GID` (1001, `dev/agentUser.ts`), with the jail owned by that uid. `/proc/<worker pid>/environ` is then unreadable: the kernel's ptrace access check (`PTRACE_MODE_READ_FSCREDS`) requires the same uid/gid or `CAP_SYS_PTRACE`, which the agent uid never has. Git calls that carry a GitHub token run as the worker (so the token is never in an agent-uid process) and hand the files to the agent uid. The worker's own file access inside jails is race-safe (`dev/safefs.ts`: no symlink following, `/proc/self/fd` verified). Compose drops all capabilities except `CHOWN DAC_OVERRIDE FOWNER SETUID SETGID KILL` + `no-new-privileges`. **Production gate:** if `NODE_ENV=production` and neither the privilege drop (uid 0 + `AGENT_UID`) nor `DEV_SANDBOX_PREFIX` is active, `bash_sandboxed` refuses every command and the worker logs a `SECURITY` warning at startup |
| Env scrubbing | Child processes get a minimal env — no API tokens. At startup the worker also removes secret names from its own `process.env` (kept in a frozen `workerEnv()` snapshot; `VAULT_*` stay until the vault module reads the snapshot), so helpers such as Chromium, Lighthouse and ffmpeg never inherit them. `/proc/<pid>/environ` always shows a process's ORIGINAL environment, so this is hygiene; the uid split above is the real control |
| Destructive ops blocked | No delete of products/pages/repos; no force-push; no theme publish without approval |
| Prompt-injection defense | Content fetched from web/client sites is wrapped as data; agents are instructed never to follow instructions found in content; risky tools still need approval regardless |
| Budgets | Per task (role `budget_usd_per_task`, stops the run), per agent/day (`agents.daily_budget_usd`, Asia/Manila day: checked before a claimed task starts; over budget → the task goes back to the queue with an activity note and waits for the next Manila day or a higher budget), per month for paid providers (`MONTHLY_BUDGET_USD`, Manila month, refreshed from the DB) → hard stop |
| QA browser | Every page request **and every WebSocket** (`page.routeWebSocket`) passes the SSRF guard; blocked sockets are closed with 1008 |
| Audit | `activity_log` row per tool call (args redacted of secrets) |

## Dashboard security
- Supabase Auth, single CEO account, RLS (see 03), TOTP 2FA (below).
- Service-role key only on the server (worker, bot, Next.js server actions) — never `NEXT_PUBLIC_*`.
- HTTPS only in production (Caddy/Nginx + Let's Encrypt).
- The browser can't write `approvals` (or the auto-approve rules) directly: every decision goes through `decide_approval()`.

### Two-factor (TOTP)
Supabase Auth MFA with an authenticator app (migration `20260929000000_totp_auto_approve.sql`, dashboard `src/lib/auth/`).

| | What happens |
|---|---|
| **Enroll** | Admin → Security → *Two-factor sign-in* → *Set up 2FA*: `mfa.enroll({ factorType: 'totp' })` shows the QR code and setup key **once** (never stored or logged by HQ), then a code from the app verifies it (`mfa.challengeAndVerify`). Half-finished enrollments are removed when you start again. |
| **Sign in** | Password → `/login?step=totp` → 6-digit code → session is `aal2`. The middleware keeps an `aal1` session on that step, and the database agrees: `is_ceo()` is false for an `aal1` session once the CEO has a verified factor, so RLS shows nothing and every workflow RPC refuses. |
| **Step-up** | A TOTP code verified in the **last 5 minutes** (JWT `amr` entry `totp`, `ceo_totp_fresh(300)`) is required to: approve a **high-risk** approval, turn on (or save an enabled) auto-approve rule, and reveal a Client Vault secret (every reveal asks for a code). The dashboard asks for the code in a dialog and verifies it right before the RPC; `decide_approval()` / `save_auto_approve_rule()` check the JWT themselves (`ceo_step_up_guard()`). |
| **Telegram** | The bot uses the service role and can't do a TOTP step-up, so once 2FA is on it can no longer **approve** high-risk actions ("Needs your 2FA code: approve this one in the dashboard"). Reject / request changes, plans, deliverables and questions still work there. |
| **Not enrolled** | Nothing changes (password only, Telegram approves everything). Set 2FA up right after deploying. |
| **Turn off / new phone** | Admin → Security → *Turn off 2FA*: current password + a code from the current app → `mfa.unenroll`, every other session signed out, `activity_log` `security.2fa_disabled`. Then *Set up 2FA* on the new phone. Without the old phone: recovery below. |

**High-risk** = `approvals.kind = 'external_action'` with `payload.type = 'external_action'`: every agent/tool/sales proposal that changes the outside world (publish, merge, deploy, send, spend, `rizehub.*` actions, outreach email batches and single emails). Not high-risk: plans, deliverables, agent questions (`question`), failures (`task_failed`, `qa_stuck`, `qa_escalation`, `planning_failed`, `vault_problem`) and Vault 2FA code relays. The agent-written `risk` label is shown but never lowers this. Mirrors: `approval_is_high_risk()` (SQL) and `approvalRisk()` (dashboard). Rejecting or requesting changes never needs a step-up.

**Recovery (lost phone).** Delete the CEO's TOTP factor with the service role; the next sign-in is password-only and Admin → Security offers *Set up 2FA* again.
```ts
// server-side script with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (never in the browser)
const admin = createClient(url, serviceRoleKey, { auth: { persistSession: false } }).auth.admin;
const { data } = await admin.mfa.listFactors({ userId: ceoUserId });
for (const f of data?.factors ?? []) await admin.mfa.deleteFactor({ userId: ceoUserId, id: f.id });
```
or in the Supabase SQL editor: `delete from auth.mfa_factors where user_id = (select id from auth.users where email = 'you@example.com');`
(Supabase signs the user out of sessions that used the factor.) The SQL editor / migrations run without a JWT and are never step-up-checked.

### CEO password
Admin → Security (`apps/dashboard/src/app/security-actions.ts`, rules in `src/lib/auth/password.ts`).

| | What happens |
|---|---|
| **Change** | Current password (checked on a throwaway client, 5 tries / 10 min) + a fresh 2FA code when 2FA is on → `auth.updateUser({ password })` → every other session is signed out (`signOut({ scope: 'others' })`) → `activity_log` `security.password_changed`. Rules: 12+ characters, at most 72 bytes (bcrypt), not the current one, not repetitive, no email name. |
| **Forgot** | *Forgot password?* on the sign-in page → `resetPasswordForEmail` (same answer whether or not the address exists; 3 / 15 min per IP) → the email link lands on `/auth/confirm` (PKCE `?code=`, or `?token_hash=&type=recovery` from a custom template) → a `recovery` session → **the 2FA step first when on** → `/reset-password` sets the new password. That page only accepts a session whose JWT `amr` has `recovery` from the last 15 minutes, so an ordinary signed-in session can't change the password without the current one. Other sessions are signed out; `activity_log` `security.password_reset`. |

**Email delivery:** Supabase's built-in mailer only sends to members of the Supabase organisation and a few emails an hour. If the CEO address is not an org member, set a custom SMTP sender (Authentication → Emails → SMTP) or the reset email never arrives. The redirect allow-list must include `https://hq.rizehub.ph/**` (deploy/supabase-setup.md step 4).

**Setup:** TOTP must be enabled in the Supabase project (Dashboard → Authentication → Multi-Factor → TOTP: enroll + verify; locally `[auth.mfa.totp]` in `supabase/config.toml` is already on).

## Client trust
- Tell clients you use AI-assisted workflows with scoped, revocable access, and that a human (you) approves every change that goes live.
- When a project ends: revoke tokens at the platform, mark `connections.status='revoked'`, remove env vars.
