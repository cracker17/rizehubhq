# SOP: api-integration

Owner: web-dev. Output: a reliable integration between a client system and a third-party API (e.g. Shopify, Halaxy, HubSpot, Stripe in test mode, Google APIs, RizeHub Agent API), delivered as a tested PR using sandbox credentials. Nothing runs against production data until the CEO approves.

## Inputs to confirm
Both systems, direction of data flow, trigger (webhook, schedule, user action), fields and mapping, volume, auth method, sandbox/test account availability, personal data involved and where it's stored. No sandbox → `ask_ceo` (don't test on production). Unclear API behaviour → read official docs (`web_fetch`), never guess.

## Steps
1. **Read the docs** (current version): auth, rate limits, pagination, webhooks + signature scheme, idempotency support, error codes, API versioning/deprecation dates. Save notes + doc URLs in `docs/integration-<name>.md` in the PR.
2. **Credentials:** `vault_list`; use `vault_api` with sandbox tokens. Env var names in `.env.example`; values set by CEO. Never log tokens or full payloads with PII.
3. **Design** (in PR description): sequence diagram (text), data mapping table, failure modes, retry policy, idempotency key, storage of sync state (`external_id`, `synced_at`, `last_error`).
4. **Client module** (`lib/integrations/<name>/`):
   - Typed request/response with zod parsing of responses (fail loudly on shape changes).
   - Timeouts (e.g. 10 s), retries with exponential backoff + jitter on 429/5xx only, honour `Retry-After`.
   - Pagination helper; rate limiter if volume is high.
   - Errors mapped to typed domain errors.
5. **Webhooks (inbound):**
   - Read the raw body; verify HMAC/signature with timing-safe compare; reject stale timestamps (replay protection).
   - Respond 2xx fast; enqueue work (DB job table/queue); process asynchronously.
   - Idempotency: store the event ID; ignore duplicates.
6. **Outbound writes:** idempotency keys where supported; upsert by external ID; never delete remote records unless specified and approved.
7. **Observability:** structured logs (event, external_id, status, duration), no secrets/PII; failed jobs visible with a retry path.
8. **Tests:** unit tests for mapping and signature verification (valid, invalid, replayed); mocked HTTP tests for retry/backoff and pagination; one sandbox end-to-end run recorded in the PR.
9. `typecheck`, `lint`, `test` green. PR + `submit_output`: flow summary, mapping table, test results, sandbox run evidence, env var names, go-live checklist (production keys, webhook registration URL, backfill plan, monitoring) as `request_external_action`.

## Mapping table template
| Source field | Target field | Transform | Required | Notes |
|---|---|---|---|---|
| order.id | external_id | string | yes | idempotency key |
| customer.email | contact.email | lowercase, trim | yes | PII — not logged |
