# SOP: webflow-interaction

Owner: web-dev. Output: an interaction or custom-code feature (Webflow Interactions or GSAP/JS) that is smooth, accessible and delivered as a complete drop-in script block with a CONFIG object, tested on staging.

## Inputs to confirm
Reference (video/Loom, Figma prototype, or example site), trigger (load, scroll, hover, click), elements involved, breakpoints where it runs, reduced-motion expectation, existing scripts on the site (Lenis, GSAP version, Finsweet). Unclear motion spec → `ask_ceo` with 2 options described.

## Choose the tool
- **Webflow Interactions**: simple hover, click toggles, basic scroll-into-view; editor-maintainable.
- **GSAP (+ ScrollTrigger/SplitText)**: scroll-linked timelines, pinning, text splits, sequencing, anything needing precise control. Use the site's GSAP (Webflow's built-in GSAP toggle or one CDN version); never load two copies.
- **Finsweet Attributes**: filters, load more, sorting, tabs on CMS lists; no custom code needed.

## Script standard (every custom-code block)
```html
<!-- RizeHub: <feature> · task <task-id> · paste in: Page settings > Before </body> -->
<script>
(() => {
  const CONFIG = {
    selector: '[data-rh="reveal"]',
    start: 'top 80%',
    duration: 0.8,
    ease: 'power2.out',
    minWidth: 768,          // disable below this width (px)
    debug: false,
  };
  window.Webflow ||= [];
  window.Webflow.push(() => {
    if (!window.gsap || !window.ScrollTrigger) return console.warn('[rh] GSAP missing');
    const els = document.querySelectorAll(CONFIG.selector);
    if (!els.length) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    gsap.registerPlugin(ScrollTrigger);
    const mm = gsap.matchMedia();
    mm.add(`(min-width: ${CONFIG.minWidth}px)`, () => {
      if (reduce) return;
      els.forEach((el) => gsap.from(el, {
        y: 40, autoAlpha: 0, duration: CONFIG.duration, ease: CONFIG.ease,
        scrollTrigger: { trigger: el, start: CONFIG.start, once: true },
      }));
    });
  });
})();
</script>
```
Rules: target `data-rh` attributes (not styling classes, which editors rename); no globals; no-op if elements are missing; `gsap.matchMedia()` for breakpoints so animations revert cleanly; animate `transform`/`opacity`/`autoAlpha` only; clean up on resize via matchMedia; initial hidden states set by JS (not CSS) so content stays visible if JS fails.

## Steps
1. Audit existing scripts (site + page settings, embeds) and versions; note conflicts (IX2 on the same element, duplicate GSAP, Lenis setup).
2. Add `data-rh` attributes to target elements in the Designer (via `vault_login`).
3. Write the block in `workspaces/<task-id>/code/<feature>.html` (branch `agent/<task-id>`). Larger than the custom-code limit → host in client repo via jsDelivr (PR) and embed a `<script defer src>`.
4. Lenis sites: `lenis.on('scroll', ScrollTrigger.update); gsap.ticker.add((t) => lenis.raf(t * 1000)); gsap.ticker.lagSmoothing(0);` once, site-wide. Call `ScrollTrigger.refresh()` after `document.fonts.ready` and image loads in pinned areas.
5. Staging (approval if required), then test: Chrome + Safari (WebKit via `playwright`), 375/768/1440, reduced-motion emulation, keyboard focus not trapped or hidden, no CLS from pinned sections, performance trace (no long tasks > 50 ms from the script), console clean.
6. `submit_output`: code files, exact paste location, attributes added, CONFIG explanation, screen recording or frame screenshots, test matrix, criteria map.
