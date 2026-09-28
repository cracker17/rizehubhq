# SOP: automation

Owner: fullstack-dev. Output: an automation (n8n workflow, scheduled script, Supabase edge function/cron, or Vercel cron) that is idempotent, observable and tested with sandbox data, delivered as exported JSON/code in a PR. Activation against real data = CEO approval.

## Inputs to confirm
Trigger (event, schedule with time zone, manual), steps, systems and credentials, expected volume, what "done" looks like, who is notified on failure, any outbound messages (emails, SMS, DMs). Outbound messaging to people → confirm consent/opt-out handling and anti-spam rules (CAN-SPAM, Spam Act 2003 AU, PECR UK, PH Data Privacy Act) and that messages go out only after CEO approval. No automated social DMs, job applications or platform actions that break ToS.

## Choose the runtime
- **n8n**: multi-app glue, low code, editable by the CEO. Default for business workflows.
- **Code (edge function / worker / Vercel cron)**: heavy logic, high volume, needs tests and version control.

## Steps
1. **Spec** in the PR: trigger, flow diagram (text), inputs/outputs per step, idempotency key, failure policy, schedule in the client's time zone (store UTC), expected runtime, cost per run if a paid API is used.
2. **Build (n8n):**
   - Credentials only in n8n's credential store (reference by name); never paste keys into nodes or Code nodes.
   - Name every node descriptively ("Fetch new Shopify orders"), add sticky notes for non-obvious logic.
   - Idempotency: a lookup/upsert step or dedupe on a stored key before side effects.
   - Error workflow attached (Error Trigger → log + notify the RizeHub HQ channel as a draft/alert, not the client).
   - Batch with `Split in Batches`/`Loop` and wait nodes to respect rate limits; set retries on HTTP nodes (e.g. 3, backoff).
   - Validate incoming webhook payloads (secret header/signature).
   - Export workflow JSON to `automations/<name>.json` (credentials are references only).
3. **Build (code):** same rules as `brain/sops/api-integration.md`; locks to prevent overlapping runs; resumable from a cursor/checkpoint.
4. **Dry-run mode:** a `DRY_RUN`/`CONFIG.dryRun` flag that logs intended side effects without executing them. Default ON in the delivered version.
5. **Test** with sandbox data: normal run, empty input, duplicate input (no double side effects), one failing step (error path fires), rate-limit simulation where possible. Record executions/screenshots.
6. **Docs:** `automations/<name>.md` with purpose, trigger, schedule, owner, credentials used (names), how to pause, how to replay failures, and data retention.
7. `typecheck`/`lint`/`test` for code. PR + `submit_output`: files, test evidence, dry-run log, criteria map, and the activation request as `request_external_action` ("Activate workflow X on production credentials, schedule every weekday 08:00 Australia/Brisbane").

## Runbook snippet template
```
Pause: n8n → workflow → toggle Active off
Replay failed item: Executions → filter Error → Retry
Change schedule: Cron node (stored in UTC; client TZ noted)
Owner: RizeHub · Alerts: HQ channel
```
