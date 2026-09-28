# QA checklist: daily-report

1. **Right template**: 08:00 run uses Morning brief, 18:00 run uses CEO digest, with correct date. Verify: header vs run time (Asia/Manila).
2. **Length**: morning ≤ 250 words, digest ≤ 300 words. Verify: word count.
3. **Approvals complete**: count and oldest age match the approvals queue. Verify: query approvals.
4. **Tasks accurate**: due/overdue (morning) or done (digest) lists match HQ task data. Verify: query tasks.
5. **Pipeline numbers match**: lead stage counts equal RizeHub data for the day. Verify: `rizehub_readonly`.
6. **Spend correct**: today's spend and % of budget match cost log within $0.01. Verify: sum.
7. **Meetings correct**: all calendar events today listed with PHT and client time zone converted correctly. Verify: `calendar_read`, convert.
8. **Owners and actions**: every item has an owner and next action. Verify: read.
9. **Priority order**: most urgent items first (P1 inbox, overdue, blocked). Verify: read.
10. **No estimates as data**: missing sources labelled "no data". Verify: read.
11. **No confidential leakage**: no credentials, personal contact details or financial client data. Verify: text scan.
