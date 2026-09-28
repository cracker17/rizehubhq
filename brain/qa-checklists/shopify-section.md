# QA checklist: shopify-section

Pass = every check is Yes. Grade each with evidence.

1. **Unpublished only.** Push target theme has role `unpublished`; live theme unchanged. Verify: `shopify_theme` list + theme ID in output.
2. **Theme check clean.** `shopify theme check` shows 0 errors on changed files. Verify: run it on the branch.
3. **Addable.** Section appears in "Add section" (has `presets`) or is placed on the stated template. Verify: customizer screenshot.
4. **Merchant-editable.** All visible text, images, links and colours come from settings/blocks; no hardcoded client copy. Verify: read markup vs schema.
5. **Matches design.** Layout, spacing and type match the Figma/reference at 375 and 1440 px within reasonable tolerance. Verify: side-by-side screenshots.
6. **Responsive.** No horizontal scroll or overlap at 375, 768, 1440 px. Verify: `playwright` screenshots.
7. **Edge cases.** Renders correctly with 0 blocks, max blocks, missing image, long heading. Verify: preview each state.
8. **Images optimised.** Uses `image_url` + `image_tag` with widths/sizes; lazy below the fold; alt text present. Verify: inspect HTML.
9. **Scoped CSS/JS.** Styles scoped to the section; JS deferred and re-initialises on `shopify:section:load`. Verify: code read + editor test.
10. **Accessible.** Heading order logical, controls keyboard-operable with visible focus, contrast ≥ 4.5:1. Verify: keyboard pass + Lighthouse a11y.
11. **No console errors.** Verify: `playwright` console log on preview.
12. **Performance.** Lighthouse mobile performance not below baseline by more than 3 points. Verify: `lighthouse` before/after.
13. **Delivery complete.** PR on `agent/<task-id>`, preview URL, screenshots, criteria map. Nothing published or merged.
