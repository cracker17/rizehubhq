# SOP: shopify-speed

Owner: shopify-dev. Output: measurable speed improvements on an UNPUBLISHED copy of the live theme, a before/after report, and a list of app/content changes for CEO approval.

## Inputs to confirm
Target pages (default: home, top collection, top product, cart drawer), target metric (Lighthouse mobile score and/or Core Web Vitals), any apps the client refuses to remove. Store access. We never promise a specific score to the client.

## Steps
1. **Baseline (live, read only).** For each target URL: `pagespeed` (field CrUX data if available: LCP, INP, CLS at p75) + `lighthouse` mobile, median of 3 runs. Record LCP element, TBT, total JS/CSS bytes, request count, third-party origins. Save to `report/baseline.md`.
2. **Copy.** Work on a fresh unpublished duplicate of live (request duplication via `request_external_action` if needed). Branch `agent/<task-id>`. Re-measure the duplicate via `?preview_theme_id=` to get the comparable baseline (preview adds a bar; always compare preview vs preview).
3. **Diagnose** in this order (biggest wins first):
   - **LCP image:** served via `image_url`/`image_tag` with `widths` + correct `sizes`; not lazy; `fetchpriority="high"`; not a CSS background; no slider hiding it behind JS.
   - **Render-blocking:** fonts (`font_url` + `font-display: swap`, preload one critical font max), large CSS files, sync scripts in `<head>`.
   - **JavaScript:** add `defer`, remove duplicate libraries (jQuery twice, multiple slider libs), load section JS only where the section exists, move non-critical widgets to interaction/idle loading.
   - **Apps:** list app embeds and injected scripts with their weight (coverage/network). Leftover code from uninstalled apps. Disable-test embeds on the duplicate to measure impact.
   - **CLS:** width/height on images, reserved space for announcement bars/app widgets/reviews stars, font swap shifts.
   - **INP:** long tasks on variant change, filters, cart; heavy event handlers; third-party chat widgets.
   - **Liquid:** nested loops over `collections`/`all_products`, excessive `{% render %}` in loops, unpaginated large collections.
4. **Fix** in small commits, one change type per commit, re-measure after each significant change (median of 3). Keep visual output identical: compare screenshots at 375/1440.
5. **Don't** remove apps, change app settings, compress/replace client images in Files, or edit live. Put these in the recommendations list with measured or estimated impact.
6. `shopify theme check`, regression sweep (home, PLP, PDP, cart drawer, search, nav), console clean.
7. PR + `submit_output` with the report.

## Report template
| Page | Metric | Before (median) | After (median) | Change |
|---|---|---|---|---|
| Home | LH mobile perf | 38 | 61 | +23 |
| Home | LCP (lab) | 6.8 s | 3.4 s | −3.4 s |

Then: changes made (commit → effect), recommendations needing approval (app removal, image replacement, app settings) with impact, what we did not touch and why, and a note that field CWV data takes ~28 days to reflect changes.
