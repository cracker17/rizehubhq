# QA checklist: wordpress-page

Pass = every check is Yes. Grade each with evidence.

1. **Staging draft only.** Page exists on staging as draft/preview; live site unchanged. Verify: `wp_rest` GET status + live URL fetch.
2. **Matches design.** Layout/typography match reference at 1440 and 375 px. Verify: side-by-side screenshots.
3. **Responsive.** No overflow/overlap at 375, 768, 1440 px. Verify: `playwright`.
4. **Global styles.** Uses theme.json presets or Elementor globals; no stray inline hex/font values. Verify: inspect markup/Elementor settings.
5. **Native building blocks.** Core/native Elementor widgets used; no HTML widget where a native one exists. Verify: editor inspection.
6. **Copy exact.** Text matches approved copy; placeholders marked and listed. Verify: diff text.
7. **Headings + alt.** One H1, logical order; meaningful images have alt. Verify: HTML extraction.
8. **SEO fields.** Title ≤ 60, description ≤ 155, index setting as specified. Verify: page `<head>`.
9. **Links + forms.** No broken links; forms validate, submit to test address, spam protection on. Verify: `link_checker` + test submission.
10. **Clean logs.** No PHP notices/errors in `debug.log`; no console errors. Verify: logs.
11. **Performance + a11y.** Lighthouse mobile performance within 5 points of baseline; accessibility ≥ 90. Verify: `lighthouse`.
12. **Deliverables.** PR (if code), Elementor JSON (if Elementor), staging URL, screenshots, push-to-live plan with rollback. Verify: output.
