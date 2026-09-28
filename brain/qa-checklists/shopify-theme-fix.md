# QA checklist: shopify-theme-fix

Pass = every check is Yes. Grade each with evidence.

1. **Reproduced.** Output shows the original bug with URL, device and a before screenshot/console log. Verify: evidence files.
2. **Root cause stated.** A specific cause (file/line or app) is named, not "fixed some CSS". Verify: read report.
3. **Bug gone.** Following the repro steps on the preview URL no longer shows the symptom. Verify: `playwright` at the reported width.
4. **Minimal diff.** Only files/lines related to the fix changed; no unrelated reformatting. Verify: PR diff.
5. **Unpublished only.** Fix is on an unpublished theme; live theme unchanged. Verify: theme list + ID.
6. **Theme check clean.** No new errors on changed files. Verify: `shopify theme check`.
7. **No regressions.** Home, product, collection, cart drawer, search and nav work at 375 and 1440 px. Verify: screenshots.
8. **Console clean.** No new console errors on tested pages. Verify: console logs.
9. **Performance not worse.** Lighthouse mobile performance within 3 points of before. Verify: `lighthouse`.
10. **App code untouched.** No edits inside app-owned files; app issues documented for CEO. Verify: diff.
11. **Apply-to-live plan.** Exact files to copy/apply listed as a proposed external action. Verify: output.
12. **Delivery.** PR on `agent/<task-id>`, preview URL, before/after screenshots. Nothing published or merged.
