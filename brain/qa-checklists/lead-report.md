# QA checklist: lead-report

1. **Findings reproducible**: spot-check 5 leads (or all if < 10); each top finding is visible at the given URL today. Verify: `web_fetch`.
2. **PageSpeed plausible**: spot-check 3 leads; mobile score within ±10 of reported. Verify: `pagespeed`.
3. **Platform fingerprinted**: every lead has a platform plus fingerprint; spot-checks match. Verify: `web_fetch` HTML.
4. **Evidence present**: every finding has URL + metric/quote + date. Verify: read.
5. **Score breakdown**: each fit score shows N/P/S/R and sums correctly. Verify: arithmetic.
6. **Threshold applied**: no kept lead below 50. Verify: read.
7. **No invented data**: no revenue/traffic numbers unless labelled Semrush estimate. Verify: search text.
8. **Angle per lead**: one sentence linking finding → cost → service. Verify: read.
9. **Notes saved**: lead notes exist in RizeHub for each kept lead. Verify: `rizehub_readonly`.
10. **Names/URLs correct**: company names and URLs match lead records. Verify: compare.
11. **Business data only; no contact made**. Verify: read + activity log.
