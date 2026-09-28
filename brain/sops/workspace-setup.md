# SOP: workspace-setup (COO)

Goal: a RizeHub account + workspace created from the right template and configured exactly to intake, with a dry-run preview the CEO approves first.

## 1. Pick the template
Map package → template from `brain/company/services.md` (e.g. Shopify growth → `shopify-growth`; SEO retainer → `seo-retainer`; Webflow build → `webflow-build`). No clear match → `ask_ceo` with the two closest options.

## 2. Build payloads
Account (`POST /accounts`):
```json
{ "company": "<legal or trading name>", "primary_contact": {"name":"…","email":"<business email>","role":"…"},
  "plan": "<package>", "country": "AU", "time_zone": "Australia/Brisbane", "test": false }
```
Workspace (`POST /accounts/{id}/workspaces`): `{ "template": "seo-retainer", "name": "<Trading name>" }`
Config (`PUT /workspaces/{id}/config`):
```json
{ "site_url": "https://…", "platform": "shopify", "services_enabled": ["seo","reports"],
  "report_schedule": {"type":"seo-monthly","day_of_month":1,"time_zone":"<client TZ>"},
  "branding": "rizehub" }
```
Starter projects (`POST /workspaces/{id}/projects`): only those the template/package defines (e.g. "Baseline audit", "Month 1 plan").

Use `Idempotency-Key = <task-id>-<step>` on every write. In staging/local runs set `"test": true`.

## 3. Dry run
Call each write with `dry_run=true`. Check the response: validation errors, template contents, derived IDs. Fix and repeat until clean. `report_progress(40, "Dry run clean")`.

## 4. Approval
`request_external_action("rizehub_onboarding", {account, workspace, config, projects, dry_run_preview})` with a one-line human summary: "Create account + workspace for <Client> (<template>), site <url>, monthly report on day 1."
Wait. The worker executes after approval.

## 5. Read back and verify
`rizehub_readonly` GET account and workspace. Compare every field to intake in a table:
```
| Field | Intake | RizeHub | OK |
```
Mismatch → fix with a config update (external action again if required), never by creating a second workspace. Error `workspace_exists` → read it back, don't retry create.

## 6. Record
- Write RizeHub IDs into `brain/clients/<slug>/profile.md` (`brain_write`).
- Include IDs in `submit_output` so HQ's client row gets `rizehub_account_id` and `rizehub_workspace_id`.

## 7. Submit
Self-check `brain/qa-checklists/workspace-setup.md`; `submit_output` with payloads, dry-run result, approval ID, readback table, criteria map.
