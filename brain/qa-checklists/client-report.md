# QA checklist: client-report

1. **Correct client**: client name, logo and workspace match the task. Verify: preview_url + `rizehub_readonly`.
2. **Period exact**: report and notes state the correct start/end dates. Verify: report data.
3. **Every number matches**: each figure in notes equals report/metrics data (after rounding). Verify: list all numbers, compare.
4. **MoM/YoY recomputed**: every % change recalculated to 1 decimal and correct direction (avg position lower = better). Verify: `bash_sandboxed`.
5. **Summary + sections**: Summary, Wins, Drops & why, What we did, Next month present. Verify: read.
6. **Word count**: notes ≤ 350 words. Verify: count.
7. **No invented causes**: every explanation of a change is backed by data or a logged task; otherwise marked as under investigation. Verify: cross-check HQ tasks.
8. **Next month in scope**: actions are within the client's package. Verify: workspace services.
9. **Branding**: RizeHub only; no personal names/emails. Verify: read.
10. **Renders**: charts load, PDF link opens, no empty widgets at 375 and 1440 px. Verify: `playwright` screenshots.
11. **Links work**: all links in report and cover email return 200. Verify: `link_checker`.
12. **Not published**: report status is draft until approval. Verify: `rizehub_readonly`.
13. **Cover email**: ≤ 120 words, correct recipient, preview/report link. Verify: open draft.
