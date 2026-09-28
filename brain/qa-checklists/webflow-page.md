# QA checklist: webflow-page

Pass = every check is Yes. Grade each with evidence.

1. **Not live.** Page is not published to the custom domain; only staging (if approved). Verify: fetch custom-domain URL (404 or old version).
2. **Matches design.** Layout, spacing, typography match Figma/reference at 1440 and 375 px. Verify: side-by-side screenshots.
3. **Responsive.** No horizontal scroll or overlap at 375, 768, 992, 1440 px. Verify: `playwright` on staging.
4. **Client-First classes.** No default class names (`div-block-*`); new classes follow `section_`, `[component]_[element]`, `is-` patterns. Verify: inspect DOM class list.
5. **System reused.** Uses site variables/existing styles; no duplicate near-identical classes. Verify: DOM + output class list.
6. **Copy exact.** Text matches approved copy; placeholders marked and listed. Verify: diff text.
7. **Headings.** One H1, logical order. Verify: extract headings.
8. **Images.** All meaningful images have alt; hero not lazy; images modern format and not oversized (> 2× display). Verify: inspect HTML/network.
9. **SEO settings.** Title ≤ 60, description ≤ 155, OG image set, slug as specified. Verify: page `<head>`.
10. **Links.** No broken links; CTAs go to specified URLs. Verify: `link_checker`.
11. **Form** (if any). Labels present, success/error states work, spam protection on. Verify: test submission on staging.
12. **Accessible + clean.** Lighthouse mobile accessibility ≥ 90; keyboard reachable nav/CTAs; no console errors. Verify: `lighthouse`, console.
13. **Performance.** Lighthouse mobile performance not below the comparable existing page by > 5 points. Verify: `lighthouse`.
