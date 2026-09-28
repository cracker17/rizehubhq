# QA checklist: keyword-research

Severity: C = critical (auto-fail), M = major, m = minor.

1. **Source stated (C).** Tool, Semrush database (us/au/uk) and date are stated and the database matches the client's market. Verify: summary header vs `profile.md`.
2. **Real numbers (C).** Spot-check 5 volumes/KD values with `semrush`; all match within tool rounding, or are marked "no data".
3. **Required columns (M).** Every row has cluster, primary keyword, volume, KD, intent, target URL, page type, priority.
4. **One URL per cluster (C).** No cluster maps to two URLs; no URL is primary for two clusters.
5. **Intent correct (M).** Spot-check 3 clusters against the live SERP; intent label matches what ranks.
6. **Relevance (M).** No keywords for products/services/locations the client does not offer. Verify: compare with `profile.md` and site.
7. **URLs real (M).** Every "existing" URL returns 200. Verify: `link_checker`.
8. **Quick wins listed (M).** Keywords at positions 8–20 identified, or "none found" stated.
9. **Cannibalisation checked (m).** Section present with findings or "none found".
10. **Next tasks (M).** Summary lists concrete next tasks with work_type names.
11. **No competitor brand targeting (m).** Competitor brand terms excluded unless the brief asks for comparison content.
12. **Summary length (m).** Summary ≤ 300 words.
