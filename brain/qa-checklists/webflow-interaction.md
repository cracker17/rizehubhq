# QA checklist: webflow-interaction

Pass = every check is Yes. Grade each with evidence.

1. **Matches reference.** Trigger, direction, timing and easing match the brief/reference. Verify: staging recording vs reference.
2. **Drop-in block.** Code is a complete `<script>` block (not a diff) with a named `CONFIG` object and a paste-location comment. Verify: read file.
3. **Safe init.** Runs inside `Webflow.push`, no global variables, no errors when target elements are absent. Verify: test on a page without the elements.
4. **Stable hooks.** Targets `data-rh` attributes (or documented IDs), not styling classes. Verify: code read.
5. **Single library copy.** GSAP/Lenis/Finsweet loaded once site-wide. Verify: network tab on staging.
6. **Reduced motion.** With `prefers-reduced-motion: reduce`, motion is removed or minimal and content fully visible. Verify: `playwright` emulation.
7. **Breakpoints.** Behaves as specified at 375, 768, 1440 px; disabled where brief says. Verify: screenshots/recording.
8. **Content visible without JS.** Disabling JS leaves content visible (no permanent hidden states from CSS). Verify: `playwright` JS off.
9. **Smooth.** Animates transform/opacity only; no long tasks > 50 ms from the script. Verify: code + performance trace.
10. **No CLS/overlap.** Pinned/scrolling sections don't overlap or jump; CLS ≤ 0.1. Verify: `lighthouse`.
11. **Cross-browser.** Works in Chromium and WebKit. Verify: `playwright` both engines.
12. **Clean console + not live.** No console errors; not published to the custom domain. Verify: console + custom-domain fetch.
