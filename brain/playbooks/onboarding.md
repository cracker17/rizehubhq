# Playbook: onboarding (new client)

**Trigger:** CEO types "Onboard <client> on <package>", **or** RizeHub webhook `client.signed_up` / `payment.received` creates the request automatically (source `rizehub`).

**Owner of the plan:** COO. **Main agent:** coo (runs onboarding itself). **Work types:** client-onboarding, workspace-setup, access-checklist.

## Steps
| # | Owner | Step | Output |
|---|---|---|---|
| 1 | coo | Plan from this playbook + the service package in `brain/company/services.md` | Plan |
| 2 | CEO | Approve plan | ✅ |
| 3 | coo (`client-onboarding`) | Intake from signed proposal, intake form, email thread; duplicate check in RizeHub | Intake sheet |
| 4 | coo (`workspace-setup`) | `account_create` + `workspace_create` from the right template in dry run | Preview |
| 5 | CEO | Approve "Create account + workspace for <client> (<template>)" | ✅ |
| 6 | worker | Executes real calls; configures site URL, services, report schedule, starter projects | RizeHub IDs |
| 7 | coo | Writes `brain/clients/<slug>/profile.md` + `brand.md`; HQ client row with RizeHub IDs | Brain files |
| 8 | coo (`access-checklist`) | Least-privilege access list with client steps; prepares secure access link (72 h, one-time) | Checklist |
| 8b | CEO | Approve sending the access link; later sets agent grants per login in the Client Vault | ✅ |
| 9 | coo | Drafts welcome email, RizeHub invite (send=false), kickoff agenda | Drafts |
| 10 | qa-lead | Reads account/workspace back from RizeHub, checks every field against intake; checks brain files, checklist, welcome email | Verdict |
| 11 | CEO | Approve sending invite + welcome email | ✅ |
| 12 | coo | Creates first-month work plan (baseline audit, first report date) as a new request | Plan for approval |

## Approvals
Plan · account/workspace creation · access link · invite + welcome email · first-month plan.

## QA focus
Every RizeHub field equals intake; no duplicate account; slug consistent; no secrets in brain or drafts; least-privilege access; welcome email correct recipient, RizeHub branding, not sent before approval.

## Rules
- Logins only via secure access link / collaborator invites into the Client Vault; never by email.
- Client's written OK to store and use access (contract or onboarding form); PH Data Privacy Act.
- Missing intake → `ask_ceo`, never guess.

## Output
Live RizeHub account + configured workspace, client brain files, access checklist, welcome email sent (after approval), first-month plan awaiting approval.
