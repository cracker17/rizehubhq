# QA checklist: shopify-speed

Pass = every check is Yes. Grade each with evidence.

1. **Baseline recorded.** Before metrics for every target page, median of ≥3 Lighthouse mobile runs. Verify: report/baseline.
2. **Like-for-like comparison.** Before and after both measured on preview URLs of unpublished themes (or both live), same device profile. Verify: URLs in report.
3. **Improvement real.** Lighthouse mobile performance improved on each target page, or the report explains why not. Verify: re-run `lighthouse` 3× on the preview.
4. **CLS.** CLS ≤ 0.1 on every target page after changes. Verify: `lighthouse`.
5. **LCP image correct.** LCP image not lazy, has `srcset`/`sizes`, `fetchpriority="high"`. Verify: inspect HTML.
6. **Visual parity.** No visual change at 375 and 1440 px vs before, unless requested. Verify: screenshot compare.
7. **Functionality intact.** Variant picker, add to cart, cart drawer, search, filters, menus work. Verify: `playwright`.
8. **Console clean.** No new console errors. Verify: console logs.
9. **Theme check clean.** No new errors. Verify: `shopify theme check`.
10. **No app/live changes.** Apps, app settings, live theme and store files untouched; those items are recommendations only. Verify: diff + report.
11. **Recommendations quantified.** Each app/content recommendation has measured or clearly labelled estimated impact. Verify: report.
12. **No promises.** Report doesn't guarantee scores or rankings and notes field-data delay. Verify: read report.
