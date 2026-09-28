# SOP: wordpress-page

Owner: web-dev. Output: a page or template built on STAGING (block editor/FSE or Elementor Pro, matching the site), saved as draft, tested, with a push-to-live plan for CEO approval.

## Inputs to confirm
Site + staging URL, builder in use, page purpose/slug, design (Figma/reference), approved copy, licensed assets, CTA/form destinations, SEO plugin in use (Yoast/Rank Math) and meta values. No staging → `ask_ceo`. Missing copy/CTA URL → `ask_ceo`.

## Steps
1. `vault_list` → staging credentials; `vault_login` (wp-admin) and/or `wp_rest` (Application Password). Record WP, PHP, theme and builder versions.
2. **Audit the design system:** block theme `theme.json` palette/typography/spacing presets and existing patterns; or Elementor Site Settings (global colours, fonts, button styles), existing templates/Theme Builder parts, container vs legacy sections. Reuse; don't add one-off styles.
3. **Baseline:** Lighthouse mobile of a comparable page on staging; screenshots.
4. **Build — block editor/FSE:**
   - Compose from core blocks + theme patterns; new repeated layouts become registered patterns (`/patterns/*.php` in the child theme via PR) or synced patterns.
   - Use presets (`var:preset|color|primary`, spacing scale); no custom inline hex/px unless the design demands and theme.json lacks it (then add a preset in a PR).
   - New page template → `templates/page-<slug>.html` in the child/block theme (PR), not a Site Editor-only change, unless the client edits in the Site Editor.
5. **Build — Elementor Pro:**
   - Flexbox/Grid Containers; global colours/fonts only; native widgets (Heading, Text Editor, Image, Button, Icon List, Form, Loop Grid) over HTML widgets.
   - Responsive values for tablet/mobile breakpoints; hide/show sparingly (duplicated content hurts SEO).
   - Repeated blocks → Saved Templates/Global Widgets. Export the page template JSON into the workspace.
   - After saving: Elementor → Tools → Regenerate CSS & Data; purge staging cache.
6. **Content:** approved copy exact; placeholders `[PLACEHOLDER: …]`; one H1; logical H2/H3; alt text; internal links relative to site; images in WebP/AVIF, sized via WP image sizes (no 4000 px uploads).
7. **Forms:** labelled fields, required validation, spam protection (honeypot/Turnstile/reCAPTCHA), test submission to a test address; do not change live notification recipients.
8. **SEO:** SEO plugin title ≤ 60, description ≤ 155, canonical default, index setting per brief, OG image.
9. **Save as draft** (`status: "draft"` via `wp_rest`, or Save Draft). Preview link with `preview=true`.
10. **Test:** `playwright` 375/768/1440, keyboard, console, `link_checker`, form test, Lighthouse mobile vs baseline, `debug.log` clean.
11. **Deliver:** PR for any code (child theme patterns/templates/CSS), Elementor JSON export, staging draft URL, screenshots, SEO fields, placeholders list, criteria map, and push-to-live plan (method: migration plugin/manual import/content copy, steps, rollback) as `request_external_action`.

## Push-to-live plan template
```
Method: Export Elementor template + import on live (or deploy child theme PR tag vX)
Steps: 1) backup live 2) import 3) set page to draft, check 4) publish on approval
Rollback: restore backup / revert page revision #
```
