# SOP: access-checklist (COO)

Goal: a per-client list of exactly the access RizeHub needs for the agreed scope, the least-privilege way to grant each, and a secure way for the client to provide it. Secrets never pass through email, chat or the brain.

## 1. Derive needs from scope
Read `brain/clients/<slug>/profile.md` (services in scope). Map services → access:
| Service | Access | Least-privilege method |
|---|---|---|
| Shopify dev/CRO | Store | Collaborator request (themes, products, pages); custom app token with only needed scopes (e.g. read/write_themes, read_products, read/write_content) |
| Webflow | Site | Site API token (CMS, pages) or Workspace guest/collaborator |
| WordPress | Site | Dedicated `rizehub-agent` user, Editor role, Application Password, staging first |
| Custom app | Repo/hosting | GitHub fine-grained token on selected repos; hosting sub-user, no billing |
| SEO / reports | GA4, Search Console | GA4 Viewer (Analyst if we build reports); GSC Restricted user (Full if we submit sitemaps) |
| Local SEO | Google Business Profile | Manager, not Owner |
| Social / ads | Meta Business | Partner access to Page/Ad account, specific assets only |
| DNS/domain | Registrar | Only if in scope; prefer client makes changes from our instructions |

## 2. Check what exists
`vault_list(client)`: credentials present, status (ok / check needed / expired), grants. Never request something already valid.

## 3. Write the checklist
Per item:
```
[ ] <Platform> · <Access type + role/scope> · Why we need it (one line)
    Client steps (≤ 6, plain language, current UI names)
    Method: collaborator invite to <RizeHub team email from brain/company> | secure access link
    Grant to agents: <e.g. web-dev, qa-lead>
    Status: missing | requested | received | verified
```
Order by what blocks the first-month work.

## 4. Secure access link
Only for platforms without a collaborator/role option. Prepare via `request_external_action("send_access_link", {client, items, expires_hours:72})`. The client enters logins straight into the Client Vault. Include the consent line: "You authorize RizeHub to use this access only for the agreed work; you can revoke it at any time." (PH Data Privacy Act + client contract).

## 5. Client-facing instructions draft
`gmail_draft` (≤ 250 words + checklist): friendly, numbered, each item says why. Never ask for passwords by email; say "please don't send passwords by email."

## 6. Submit
Self-check `brain/qa-checklists/access-checklist.md`; `submit_output` with the checklist, vault status summary (labels only), draft ID, approval request ID. Grants are set by the CEO when access arrives.
