# QA checklist: ui-mockup
Pass = every check true.

1. **Matches wireframe**: every block present or deviation justified. Verify: compare to wireframe task output.
2. **Brand tokens used**: colours/fonts from `brand.md` via `tokens.css`, no stray hex values. Verify: grep CSS for hex outside tokens.
3. **Breakpoints**: 375/768/1440 screenshots exist and render correctly. Verify: `playwright`.
4. **No horizontal scroll at 375**. Verify: `scrollWidth <= 375`.
5. **Contrast**: body text ≥ 4.5:1, large text/UI ≥ 3:1. Verify: Lighthouse + manual check of brand pairs.
6. **Lighthouse accessibility ≥ 95**, 0 console errors. Verify: `lighthouse` on `mockup.html`.
7. **Focus visible** on every interactive element; tab order logical. Verify: `playwright` tab-through screenshots.
8. **Target size** ≥ 24×24 px (primary mobile actions ≥ 44×44). Verify: element bounding boxes.
9. **All states styled** (hover, focus, disabled, loading, error, empty, success as relevant). Verify: state sheet.
10. **Images**: `alt` present, fixed aspect ratio (no CLS). Verify: DOM + Lighthouse CLS.
11. **Licensed assets only**: licence list covers every font/icon/photo. Verify: output list vs files.
12. **No invented content**: no fake reviews, ratings, stock counts, prices, urgency. Verify: read copy.
13. **Handoff spec** covers every component: variants, states, spacing, breakpoints, platform mapping. Verify: `handoff.md`.
14. **RizeHub branding only**; no personal names/emails. Verify: search.
15. **criteria_map** addresses each acceptance criterion with evidence.
