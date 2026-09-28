# QA checklist: api-integration

Pass = every check is Yes. Grade each with evidence.

1. **Green checks.** `typecheck`, `lint`, `test` pass. Verify: run them.
2. **Docs cited.** Integration notes link official API docs and the API version used. Verify: `docs/integration-*.md`.
3. **Mapping table.** Every synced field listed with transform and required flag. Verify: PR/doc.
4. **Signature verification.** Inbound webhooks verify signatures on the raw body with timing-safe compare; tests cover valid, invalid and replayed events. Verify: code + tests.
5. **Idempotent.** Duplicate events/requests don't create duplicate records (event ID or idempotency key stored). Verify: test or sandbox rerun.
6. **Retries correct.** Backoff with jitter on 429/5xx only; timeouts set; `Retry-After` honoured. Verify: code + mocked tests.
7. **Responses validated.** External responses parsed with zod (or equivalent). Verify: code.
8. **Sandbox only.** Evidence of a sandbox/test-mode run; no production calls. Verify: logs/output.
9. **No secrets or PII in logs/code.** Verify: grep + sample log output.
10. **Failures visible.** Failed jobs recorded with error and retry path. Verify: code + test.
11. **Go-live checklist.** Production steps listed as a proposed external action (keys, webhook URL, backfill, monitoring). Verify: output.
12. **Not merged/deployed.** Verify: `github`.
