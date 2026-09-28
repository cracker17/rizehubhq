# QA checklist: wireframe
Pass = every check true. Each check: PASS/FAIL + evidence.

1. **Goal block present**: `wireframe-spec.md` starts with User, Job, Primary action, Success. Verify: read file.
2. **One primary action per screen**: only one primary-styled CTA per screen. Verify: screenshots.
3. **Three breakpoints**: screenshots at 375, 768, 1440 exist and match `wireframe.html`. Verify: `playwright` render at each width.
4. **No horizontal scroll at 375**. Verify: `playwright` `document.documentElement.scrollWidth <= 375`.
5. **Greyscale/low-fi**: no brand colours or final imagery. Verify: screenshots.
6. **Blocks numbered and annotated**: every `[Bn]` in HTML has a spec entry and vice versa. Verify: compare lists.
7. **States listed** for every interactive block (default, focus, disabled, error, empty/loading where relevant). Verify: spec.
8. **Flow complete**: error and empty paths shown for flows. Verify: step list.
9. **Real content lengths**: headings/copy from approved copy or marked `[PLACEHOLDER: …]`. Verify: compare with copy task output.
10. **No invented facts**: no made-up prices, ratings, reviews, stats. Verify: search for numbers, check source.
11. **Accessibility basics**: labels on inputs, heading order H1→H2→H3, logical tab order. Verify: `playwright` tab-through + DOM headings.
12. **Platform notes** for platform-dependent blocks (Shopify/Webflow/WP). Verify: spec.
13. **No client-facing personal names/emails; RizeHub branding only**. Verify: search files.
14. **Acceptance criteria** each mapped with evidence in criteria_map. Verify: output.
