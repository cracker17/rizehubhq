# QA checklist: weekly-summary

1. **Period correct**: header states the previous Mon–Sun (Asia/Manila) with exact dates. Verify: compare to run date.
2. **Structure complete**: Headline, Done, Quality, Cost, Pipeline, Client health, Bottlenecks, Waiting on you, Next week all present. Verify: read.
3. **Length**: ≤ 400 words. Verify: word count.
4. **Counts match data**: requests/tasks done, revisions, failed tasks equal HQ data. Verify: query/recount via `rizehub_readonly` or data export.
5. **Rates recomputed**: QA first-pass rate, avg revisions, WoW % match recalculation to 1 decimal. Verify: recompute in `bash_sandboxed`.
6. **Spend correct**: total and top-3 agents match cost log within $0.01. Verify: sum.
7. **Pipeline stages match**: each stage count equals RizeHub lead stage counts for the period. Verify: `rizehub_readonly`.
8. **Client health justified**: every client has a status and a concrete reason (e.g. "report due 1 Oct not generated"). Verify: read.
9. **Bottlenecks actionable**: each has cause, proposed fix and owner. Verify: read.
10. **Approvals listed**: all approvals pending > 24 h appear, oldest first. Verify: approvals list.
11. **No estimates presented as data**: missing data labelled "no data (reason)". Verify: read.
12. **No actions executed**: recommendations only; no roster/budget changes made. Verify: activity log.
