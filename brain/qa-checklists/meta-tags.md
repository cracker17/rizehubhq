# QA checklist: meta-tags

Severity: C = critical (auto-fail), M = major, m = minor.

1. **Coverage (C).** Every URL in scope has a row; non-200 URLs listed separately. Verify: compare to brief list or sitemap.
2. **Title length (M).** Every new title ≤ 60 characters. Verify: recount characters; the Chars column must be correct.
3. **Meta length (M).** Every new meta 120–155 characters. Verify: recount.
4. **Unique titles (C).** No duplicate titles across rows. Verify: sort and compare.
5. **Unique metas (M).** No duplicate meta descriptions.
6. **Keyword placement (M).** Primary keyword (or close variant) in each title, in the first half where possible, and once in the meta.
7. **One keyword per URL (M).** No primary keyword assigned to two URLs.
8. **Brand format (m).** Brand appears once, at the end of titles, in the briefed format.
9. **Claims true (C).** "Free", "same-day", prices, ratings, licences in titles/metas trace to the brief or site.
10. **Intent fit (M).** Spot-check 3 rows: title matches what the page actually offers. Verify: `web_fetch`.
11. **No stuffing (m).** No keyword repeated in a title; no ALL CAPS.
12. **Scope extras (M when in scope).** H1, OG and alt text columns filled if the brief asked for them.
