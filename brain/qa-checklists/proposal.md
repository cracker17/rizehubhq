# QA checklist: proposal

1. **Prices traceable**: every price matches a line in `brain/company/pricing.md` exactly (currency included); no placeholders quoted. Verify: compare each figure.
2. **Math correct**: totals, deposits and milestone splits add up. Verify: recompute.
3. **Findings verified**: each cited finding appears in the lead notes or is visible on the live site today. Verify: `web_fetch`/lead notes.
4. **Client facts correct**: company name, URL, platform, contact name spelled as in the lead record. Verify: `rizehub_readonly`.
5. **Options**: 2–3 options, each with deliverables, timeline and price. Verify: read.
6. **Exclusions present**: a "Not included" section with at least 2 items. Verify: read.
7. **Terms present**: payment terms, revisions, change requests and a valid-until date. Verify: read.
8. **One next step**: exactly one clear CTA. Verify: read.
9. **No invented proof**: no stats, testimonials, case studies or guarantees not in the brain. Verify: search brain for each claim.
10. **Branding**: RizeHub only; no personal names/emails unless the brief allows. Verify: read.
11. **Internal notes stripped**: no pricing-line references or agent comments in client text. Verify: search for `{{`, `TODO`, `pricing.md`.
12. **Not sent**: nothing sent; any send is a pending `request_external_action`. Verify: task log.
