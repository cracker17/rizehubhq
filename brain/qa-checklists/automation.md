# QA checklist: automation

Pass = every check is Yes. Grade each with evidence.

1. **Spec present.** Trigger, steps, schedule with time zone, idempotency key and failure policy documented. Verify: PR/doc.
2. **Exported and versioned.** n8n JSON or code committed in the PR. Verify: `github` diff.
3. **No embedded secrets.** Credentials referenced by name only; no keys in nodes, code or JSON. Verify: grep export.
4. **Idempotent.** Re-running with the same input causes no duplicate side effects. Verify: test execution evidence.
5. **Error path.** An error workflow/handler logs and alerts RizeHub HQ (not the client). Verify: forced-failure test evidence.
6. **Rate limits respected.** Batching/waits/retries configured for the APIs used. Verify: node settings or code.
7. **Dry-run default.** Delivered with dry-run on; dry-run log attached. Verify: config + log.
8. **Edge cases tested.** Empty input and duplicate input runs recorded. Verify: execution screenshots/logs.
9. **Compliance.** Any outbound messaging honours opt-out/suppression and needs CEO approval; no automated DMs/applications. Verify: flow + doc.
10. **Runbook.** Pause, replay and owner documented. Verify: `automations/<name>.md`.
11. **Not activated.** Workflow inactive / cron not enabled on production; activation proposed as external action. Verify: output + status.
12. **Checks green** (code). `typecheck`, `lint`, `test` pass. Verify: run them.
