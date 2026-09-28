# QA checklist: client-onboarding

1. **Intake complete**: all required intake fields filled or explicitly escalated. Verify: compare profile.md to SOP field list.
2. **Fields sourced**: each profile fact traces to proposal, form, thread or site. Verify: sources line + spot-check 5 facts.
3. **No duplicate**: exactly one RizeHub account for this domain. Verify: `rizehub_readonly` search.
4. **Account/workspace match intake**: company, contact, plan, template, site URL, report schedule, services read back from RizeHub equal intake. Verify: `rizehub_readonly` GET account/workspace.
5. **Approval before creation**: account/workspace created only after an approved external action. Verify: approval ID + timestamps.
6. **Slug consistent**: same kebab-case slug in brain path, HQ client row and output. Verify: compare.
7. **Brain files exist**: `brain/clients/<slug>/profile.md` and `brand.md` present with required sections. Verify: `brain_read`.
8. **No invented brand data**: unknown colors/fonts marked TBD. Verify: compare to brand files provided.
9. **No secrets**: no passwords, tokens, codes or personal IDs in brain files or drafts. Verify: text scan.
10. **Access checklist done**: separate checklist output exists per access-checklist QA. Verify: file/link.
11. **Welcome email**: ≤ 200 words, correct recipient, next steps with dates, RizeHub branding, not sent. Verify: open draft.
12. **Invite prepared, not sent**: invite exists with send=false. Verify: `rizehub_readonly`.
13. **Kickoff agenda**: included with timed items. Verify: read.
