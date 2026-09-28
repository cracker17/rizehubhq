# RizeHub Agent API: what the RizeHub app needs to build

RizeHub HQ (the AI employee team) talks to RizeHub only through a private **Agent API**. HQ's side is done: a typed
client, the tools the agents use, the webhook receiver and a mock of your API that implements this exact contract.
This folder is everything the RizeHub app team needs to build its side, in any language.

| File | What it is |
|---|---|
| `openapi.yaml` | OpenAPI 3.1: all 22 operations, auth, headers, scopes (`x-scope`), errors, dry runs, jobs and the signed webhook. **The contract.** |
| `src/auth.ts` | Reference auth middleware: hashed keys, revocation, `last_used_at`, scope per route, `X-HQ-*` headers to the audit log, per-key rate limit, `Idempotency-Key` required on writes. Framework-agnostic, zero dependencies. |
| `src/scopes.ts` | Route → scope table and the default scopes of the four HQ keys. |
| `src/idempotency.ts` | Replay / conflict logic for `Idempotency-Key` + an interface for your storage. |
| `src/webhookSigner.ts` | Signs and delivers webhooks to HQ (retries, backoff, fresh timestamp per attempt). |
| `test/*.test.ts` | Tests, including a **shared signature test vector** that HQ's own tests also check. |

Run the tests with Node 22.18+ (TypeScript runs natively): `npm test` (9 tests). Port the files to PHP/Laravel or whatever
RizeHub uses; the logic is small on purpose. PHP equivalents of the two crypto bits are at the bottom.

## See it working first

HQ ships a mock RizeHub that implements the whole contract in memory. From the HQ repo:

```bash
pnpm --filter worker mock:rizehub                  # Agent API on http://localhost:8080/agent-api/v1, prints the test keys
curl -s localhost:8080/agent-api/v1/leads/ld_1001 \
  -H 'authorization: Bearer rzh_mock_leads' -H 'x-hq-task-id: t1' -H 'x-hq-agent-id: sales'
curl -s -XPOST localhost:8080/_mock/events -H 'content-type: application/json' \
  -d '{"event":"client.signed_up","data":{"company":"Kinfolk Candle Studio","package":"shopify-growth"}}'
```

With `RIZEHUB_WEBHOOK_SECRET` and `HQ_WEBHOOK_URL` set, the mock sends signed webhooks to HQ exactly as you should.
`GET /_mock/audit` shows what an audit log with the HQ headers looks like.

## Build order

Each step is useful on its own; HQ degrades gracefully until the next one exists. "Done" for every step = HQ's contract
check passes against your staging:

```bash
RIZEHUB_API_URL=http://<staging>:8080/agent-api/v1 RIZEHUB_KEY_LEADS=… RIZEHUB_KEY_ONBOARDING=… RIZEHUB_KEY_REPORTS=… \
RIZEHUB_KEY_READONLY=… RIZEHUB_CHECK_WORKSPACE=ws_… pnpm --filter worker contract:rizehub
```
(Reads for real, writes only with `dry_run=true`. Never run it with production keys.)

### 0. Foundation (before any endpoint)
- [ ] `agent_api_keys` table: `id, label, key_hash (sha256 hex, unique), scopes text[]/json, revoked_at, last_used_at, created_at`. Show the key once, store only the hash (`src/auth.ts` `generateApiKey`).
- [ ] Create four keys with the scopes in `src/scopes.ts` `KEY_GROUP_SCOPES`: `hq-leads`, `hq-onboarding`, `hq-reports`, `hq-readonly`. Give them to the CEO for HQ's `.env`; never one master key.
- [ ] Middleware on every `/agent-api/v1` route, in this order (`authenticateAgentRequest`): Bearer key → hash lookup → not revoked → touch `last_used_at` → `X-HQ-Task-Id` + `X-HQ-Agent-Id` present → rate limit (send `X-RateLimit-Limit/Remaining/Reset`, 429 + `Retry-After`) → route exists → scope → writes need `Idempotency-Key`.
- [ ] Audit log row per request: key label, method, path, HQ task id, HQ agent id, dry_run, outcome. This is how you see *which AI employee did what, for which task*.
- [ ] Errors always `{"error":{"code","message","retryable"}}` (codes below). Mark 429/5xx `retryable: true`.
- [ ] Only reachable on the Docker network `rizehub-internal` (`http://rizehub-app:8080`). Nginx must not route `/agent-api` publicly.

### 1. Lead Finder (read-mostly, lowest risk)
- [ ] `POST /leads/search` → `202 {job_id}`; run the search in your job queue.
- [ ] `GET /jobs/{id}` → `{status: queued|running|completed|failed, progress, result: {lead_ids, total}}`.
- [ ] `GET /leads/{id}`: company, website, platform, location, **business contact only**, `signals[]` (key, label, value such as `"LCP 6.2 s"`, optional metric), Lead Finder `score`, `stage`, `fit_score`, `angle`, `notes[]`, `app_url` (deep link HQ shows as "Open in Lead Finder").
- [ ] `POST /leads/{id}/notes` (body, fit_score 0–100, angle, findings[]); first note moves `new → researched`.
- [ ] `POST /lists` (create or reuse by name, add lead_ids) and `POST /lists/{id}/leads`.
- [ ] `PATCH /leads/{id}` `{stage}` with stages `new, researched, drafted, contacted, replied, proposal, won, lost`; never back to `new` (409 `invalid_stage`). HQ only sets `contacted`/`proposal` after the CEO approved and the message was sent.
- [ ] Webhook `job.completed` / `job.failed` when a search finishes (HQ also polls, so this can come right after).

### 2. Reports
- [ ] `GET /workspaces/{id}/metrics?from&to` → `metrics` and `previous` (same-length period right before) + `currency`.
- [ ] `POST /workspaces/{id}/reports` `{type: seo-monthly|site-audit|ads-performance|lead-report, period:{from,to}}` → `202 {job_id}`; the job result has `report_id`.
- [ ] `GET /reports/{id}`: data, `preview_url` (private, token in the URL), `pdf_url`, `status`, `notes`.
- [ ] `POST /reports/{id}/notes` (summary, insights[], next_steps[]); 409 `report_published` once published.
- [ ] `POST /reports/{id}/publish` `{notify_client}`: requires notes (422 otherwise), 409 if already published. **HQ calls this only after the CEO approved it.**
- [ ] Webhook `report.viewed` `{report_id, workspace_id}` when the client opens it.

### 3. Onboarding writes (highest risk: real accounts)
- [ ] `GET /accounts?q=&domain=` (duplicate check: case-insensitive name contains, exact domain ignoring scheme/`www.`/path).
- [ ] `POST /accounts` (company, domain, primary_contact, plan, country, time_zone, `test`): 409 `account_exists` on same company or domain. Emit `account.created`.
- [ ] `GET /workspace-templates` + workspace templates as data (`shopify-growth`, `seo-retainer`, `webflow-build`, …: services, starter projects, report type).
- [ ] `POST /accounts/{id}/workspaces` `{template, name}`: one per template per account (409 `workspace_exists`). Emit `workspace.ready`.
- [ ] `PUT /workspaces/{id}/config` (site_url, platform, services_enabled, report_schedule `{type, day_of_month 1–28, time_zone}`, branding `rizehub`), merged into the current config.
- [ ] `POST /workspaces/{id}/projects` `{projects:[{name}]}` (same name twice is a no-op).
- [ ] `POST /accounts/{id}/invites?send=false` prepares the invite (with a subject/body preview); `POST /invites/{id}/send` sends it (409 `invite_already_sent`). HQ sends only after a separate CEO approval.
- [ ] `test: true` accounts hidden from real dashboards and deleted after 7 days by a cleanup job.
- [ ] Webhooks `client.signed_up` and `payment.received` `{account_id?, company, package, website?, contact?}`: HQ auto-creates "Onboard {company} on {package}" (deduped while one is open).
- [ ] Optional: `lead.replied` `{lead_id, company?, website?, channel}` if RizeHub tracks the inbox (never include the message body).

### 4. Staging
- [ ] A staging copy with its own database; HQ's local setup points there, never at production.

## Conventions HQ relies on

**Headers on every request:** `Authorization: Bearer <key>`, `X-HQ-Task-Id`, `X-HQ-Agent-Id` (both `[A-Za-z0-9_.:-]{1,100}`).

**Idempotency** (`src/idempotency.ts`). Every write has `Idempotency-Key: <taskId>:<step>` (e.g. `7d1c…:onboarding:account`);
dry runs use `<taskId>:<step>:dry_run` so a dry run is never replayed as the real call.
- Scope stored keys per API key. Fingerprint = method + path + dry_run + canonical JSON body.
- Same key + same fingerprint → return the stored status + body again, header `Idempotent-Replayed: true`.
- Same key + different fingerprint → `409 idempotency_conflict`.
- Store 2xx and 4xx; never 5xx (HQ retries those with the same key). Keep keys ≥ 24 h. Insert atomically.

**Dry run** (`?dry_run=true` on every write): run all validation, return the same errors the real call would, and on
success `200 {"dry_run": true, "valid": true, "would": {…}, "warnings": [...]}` without changing anything. In a dry run the
id `new` means "the account/workspace this onboarding would create": `/accounts/new/workspaces`, `/workspaces/new/config`,
`/workspaces/new/projects`. HQ builds the CEO's approval preview from these responses.

**Long jobs:** `202 {"job_id","status"}` → `GET /jobs/{id}` + webhook. HQ waits up to ~45 s, then parks the agent's task and
resumes it on `job.completed` (or its own polling every 30 s).

**Error codes HQ understands:** `unauthorized` (401), `forbidden` (403), `missing_hq_headers`, `missing_idempotency_key`,
`invalid_json` (400), `not_found` (404), `validation_failed` (422, message lists every bad field), `account_exists`,
`workspace_exists`, `invalid_stage`, `invite_already_sent`, `report_published`, `idempotency_conflict` (409),
`rate_limited` (429, retryable), `internal` / `unavailable` (5xx, retryable).

## Webhooks (RizeHub → HQ)

`POST http://hq-worker:4000/hooks/rizehub` with body `{"id":"evt_…","event":"job.completed","created_at":"…","data":{…}}`.

- `X-RizeHub-Signature`: hex HMAC-SHA256 of the **exact raw body** with `RIZEHUB_WEBHOOK_SECRET` (a `sha256=` prefix is accepted).
- `X-RizeHub-Timestamp`: unix seconds of this attempt; HQ rejects more than 5 minutes off (keep NTP on).
- Reuse the same `id` on retries: HQ stores each event id once (idempotent). Retry 5xx/network with backoff for up to 24 h; 4xx means fix the secret or clock.
- Deliver from your job queue, not inside the user's request (`src/webhookSigner.ts` `deliverWebhook`).

Test vector (both sides test it): secret `whsec_test_123`, body
`{"id":"evt_1","event":"job.completed","created_at":"2026-09-28T02:00:00Z","data":{"job_id":"job_1","type":"lead_search","status":"completed","result":{"lead_ids":["ld_1001"],"total":1}}}`
→ signature `e14135d083b36c0dcc829e245cf55b94bab8aee1113f7adff3f8e1d3d17ec77f`.

| Event | `data` | What HQ does |
|---|---|---|
| `job.completed` / `job.failed` | `job_id, type, status, result, error` | Resumes the agent task that waited on the job |
| `account.created` / `workspace.ready` | `account_id, company` / `workspace_id, account_id, template` | Onboarding bookkeeping |
| `client.signed_up` / `payment.received` | `account_id?, company, package, website?, contact?, amount?, currency?` | Creates "Onboard {company} on {package}" (payment for an onboarded client is just logged) |
| `lead.replied` | `lead_id, company?, website?, channel` | Pipeline Desk follow-up request; lead stage → replied |
| `report.viewed` | `report_id, workspace_id` | Logged in the client's activity |

## Data rules
- Leads: business contact data only (published company emails, role inboxes). No personal data scraping.
- Honour your suppression list in every lead response (HQ never contacts suppressed leads, but the data should not be there).
- Agents act on behalf of RizeHub the agency: a key may only touch clients the agency manages.

## PHP / Laravel equivalents

```php
// Store only this; compare with hash_equals.
$keyHash = hash('sha256', $presentedKey);

// Sign a webhook (serialize once, sign those exact bytes).
$body = json_encode($event, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
$headers = [
  'Content-Type' => 'application/json',
  'X-RizeHub-Signature' => hash_hmac('sha256', $body, config('services.hq.webhook_secret')),
  'X-RizeHub-Timestamp' => (string) time(),
];
Http::withHeaders($headers)->withBody($body, 'application/json')->timeout(10)->post($hqWebhookUrl);
```
