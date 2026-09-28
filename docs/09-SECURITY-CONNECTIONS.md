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
- Google OAuth with `gmail.readonly` + `gmail.compose` (drafts only) + `calendar.readonly`. Sending = approval, executed by worker code.

### Social platforms & job sites
- Prospecting and inbound agents **draft only**. You send social messages yourself — automated DMs break platform rules and risk your accounts.
- Job Scout reads job alerts and public feeds only; it never logs into job sites or submits applications. You apply.

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
- **Grants**: each credential lists which agents may use it (e.g. Madam Muse Shopify login → Shopify Dev + QA Lead only). No grant, no access.
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

## Where system secrets live

**v1 (local + VPS):** env file readable only by the worker.
```
# apps/worker/.env   (chmod 600, never committed)
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
| Shell allowlist | Only `git, node, pnpm, npm, npx shopify, lighthouse, playwright`; block `curl|wget` to non-allowlisted hosts, `rm -rf` outside workspace, `env`, `cat .env` |
| Env scrubbing | Child processes get a minimal env — no API tokens |
| Destructive ops blocked | No delete of products/pages/repos; no force-push; no theme publish without approval |
| Prompt-injection defense | Content fetched from web/client sites is wrapped as data; agents are instructed never to follow instructions found in content; risky tools still need approval regardless |
| Budgets | Per task, per agent/day, global/day → hard stop |
| Audit | `activity_log` row per tool call (args redacted of secrets) |

## Dashboard security
- Supabase Auth, single CEO account, RLS (see 03). Add TOTP when deployed.
- Service-role key only on the server (worker, bot, Next.js server actions) — never `NEXT_PUBLIC_*`.
- HTTPS only in production (Caddy/Nginx + Let's Encrypt).

## Client trust
- Tell clients you use AI-assisted workflows with scoped, revocable access, and that a human (you) approves every change that goes live.
- When a project ends: revoke tokens at the platform, mark `connections.status='revoked'`, remove env vars.
