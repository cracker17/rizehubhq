# SOP: client-onboarding (COO)

Goal: signed client → correct brain file, RizeHub account/workspace prepared, access requested, welcome drafted, all gated by CEO approval. Playbook: `brain/playbooks/onboarding.md`. Workspace details: `brain/sops/workspace-setup.md`; access: `brain/sops/access-checklist.md`.

## 1. Intake (sources in priority order)
Signed proposal → intake form → email thread (`gmail_read`) → client website (`web_fetch`, for platform/URLs only). Record the source of each field.

Required fields:
```
company_legal_name, trading_name, slug (kebab-case), website, platform (shopify|webflow|wordpress|custom)
primary_contact (name, role, business email), billing_contact, country, time_zone, English variant (US/AU/UK)
package / workspace template, start date, report schedule, services in scope, out of scope
goals (client's words), KPIs, competitors (if given), brand files location
```
Missing required field → `ask_ceo` with a list; do not guess. `report_progress(20, "Intake complete")`.

## 2. Duplicate check
`rizehub_readonly`: search accounts by domain and company name. Match found → stop, `ask_ceo`.

## 3. Account + workspace (see workspace-setup SOP)
Dry run → `request_external_action` with preview. Wait for approval; the worker executes. `report_progress(45, "Account approved")`.

## 4. Brain files (`brain_write`, under `brain/clients/<slug>/`)
`profile.md`:
```
# <Trading name>
Website · Platform · Country/TZ · English variant
RizeHub: account_id, workspace_id, template
Contacts: role-based (name, role, business email) — no personal phones unless business
Package & scope: in / out
Goals & KPIs (client wording) · Report schedule
Key dates · Sources: <proposal date, form, thread>
```
`brand.md`: logo files, colors (hex), fonts (with license note), voice (3 adjectives + do/don't), imagery rules. Unknown values: `TBD (ask client)`, never invented.

## 5. Access
Run the access-checklist SOP; prepare secure access link request (external action).

## 6. Welcome pack (drafts only, `gmail_draft`)
- Welcome email ≤ 200 words: thank you, what happens next (3 steps with dates), how approvals work, response times, the secure access link mention, kickoff scheduling ask. Signed "RizeHub team".
- RizeHub invite prepared with `send=false`.
- Kickoff agenda (30–45 min): introductions, goals & KPIs, scope confirm, access status, communication and approvals, first-month plan, questions.

## 7. Submit
Self-check `brain/qa-checklists/client-onboarding.md`; `submit_output` with account/workspace IDs (or dry-run preview + approval ID), brain file paths, draft IDs, open questions, criteria map. Sending invite/welcome = separate `request_external_action`. After done, COO creates the first-month plan.
