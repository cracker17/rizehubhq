# QA checklist: access-checklist

1. **Scope coverage**: every in-scope service has at least one access item; no item for out-of-scope services. Verify: compare to profile.md scope.
2. **Least privilege**: no Owner/Admin requested where a collaborator, Editor, Manager, Viewer or scoped token works. Verify: compare to SOP table.
3. **Vault checked**: items already valid in `vault_list` are not re-requested. Verify: `vault_list`.
4. **Item complete**: each item has platform, access type/role, why, client steps (≤ 6), method, proposed agent grants, status. Verify: read.
5. **Steps accurate**: client steps use current platform menu names. Verify: spot-check 2 items against official help docs (`web_fetch`).
6. **Ordered by blocker**: items blocking first-month work come first. Verify: compare to plan.
7. **No secret requests by email**: drafts never ask for passwords/codes; include "don't send passwords by email". Verify: read draft.
8. **No secrets anywhere**: output, brain and drafts contain no credentials. Verify: text scan.
9. **Secure link gated**: access link prepared as external action, 72 h expiry, not sent. Verify: approval record.
10. **Consent line present**: authorization + revocation wording in link request and email. Verify: read.
11. **Grants minimal**: proposed agent grants only include agents whose work needs the access (+ qa-lead). Verify: read.
12. **Branding**: RizeHub only, team email from brain/company. Verify: read draft.
