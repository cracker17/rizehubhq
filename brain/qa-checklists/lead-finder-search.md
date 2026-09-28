# QA checklist: lead-finder-search

1. **Query matches plan**: industry, location, platform, signals and limit equal the approved plan. Verify: compare task instructions to logged params.
2. **Job completed**: search job status is completed (not failed/partial) or the failure was escalated. Verify: `rizehub_readonly` job.
3. **Counts reconcile**: returned = kept + dropped. Verify: arithmetic.
4. **Drop reasons given**: every dropped lead has a reason. Verify: read.
5. **No duplicates**: no two kept leads share a domain. Verify: sort domains.
6. **No existing/contacted leads**: none kept are clients or at stage contacted/replied/won/lost. Verify: `rizehub_readonly` stages + `brain/clients/`.
7. **Platform correct**: spot-check 5 kept leads; platform matches the query. Verify: fingerprint via `web_fetch`.
8. **Sites live**: spot-check 5 kept leads load (HTTP 200). Verify: `web_fetch`.
9. **Business data only**: no personal emails/phones from private profiles. Verify: read contact fields.
10. **List saved with naming convention** `{YYYY-MM} {niche} {country} {platform}`. Verify: `rizehub_readonly` lists.
11. **No outside action**: no stage changes or messages. Verify: activity log.
