# QA checklist: shopify-page

Pass = every check is Yes. Grade each with evidence.

1. **Unpublished theme.** Template and sections exist only on the stated unpublished theme; live theme untouched. Verify: `shopify_theme` list/diff.
2. **Theme check clean.** 0 errors on changed files. Verify: run `shopify theme check`.
3. **Preview works.** Preview URL loads the new template (HTTP 200, correct sections). Verify: `playwright`.
4. **Matches wireframe/mockup.** Section order and layout match at 375 and 1440 px. Verify: side-by-side screenshots.
5. **Copy exact.** On-page text matches the approved copy; placeholders clearly marked and listed. Verify: diff page text vs copy source.
6. **One H1, logical headings.** Verify: extract headings.
7. **SEO fields.** Meta title ≤ 60 chars and description ≤ 155 chars provided; all images have alt. Verify: output + HTML.
8. **Links and CTAs.** Every link/CTA resolves (no 404) and points to the specified destination. Verify: `link_checker`.
9. **LCP image.** Hero image not lazy-loaded, has `sizes`/`srcset`. Verify: inspect HTML.
10. **Responsive.** No overflow at 375/768/1440. Verify: screenshots.
11. **Accessible + clean.** Lighthouse mobile accessibility ≥ 90; no console errors. Verify: `lighthouse`, console log.
12. **Performance.** Lighthouse mobile performance within 5 points of the comparable baseline page or better; CLS ≤ 0.1. Verify: `lighthouse`.
13. **Cart flow** (if applicable). Add to cart works; checkout not modified. Verify: `playwright` to cart.
14. **No external action taken.** Page not published/created live; required actions listed for CEO approval.
