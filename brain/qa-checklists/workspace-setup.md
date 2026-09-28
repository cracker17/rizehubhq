# QA checklist: workspace-setup

1. **Template correct**: template matches the package per `brain/company/services.md`. Verify: lookup.
2. **Dry run done**: output includes a clean dry-run response before the real call. Verify: output + activity log.
3. **Approved first**: real writes happened only after an approved external action. Verify: approval ID/timestamps.
4. **Account fields**: company, primary contact (business email), plan, country, time zone equal intake. Verify: `rizehub_readonly` GET account.
5. **Workspace fields**: name, template, site URL, platform, services enabled equal intake. Verify: GET workspace.
6. **Report schedule**: type and day set as agreed, client time zone. Verify: GET workspace config.
7. **Branding**: set to RizeHub. Verify: config.
8. **Starter projects**: only package-defined projects created. Verify: list projects.
9. **Single workspace**: no duplicate account/workspace for this client. Verify: search by domain.
10. **Idempotency used**: writes carry `<task-id>-<step>` keys (no duplicates on retry). Verify: activity log.
11. **IDs recorded**: account_id and workspace_id in profile.md and submit_output. Verify: `brain_read`.
12. **Readback table**: every field row shows OK. Verify: re-check two rows independently.
