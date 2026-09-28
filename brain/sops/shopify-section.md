# SOP: shopify-section

Owner: web-dev. Output: one reusable, merchant-editable OS 2.0 section (or theme block set) pushed to an UNPUBLISHED theme, with PR + preview link.

## Inputs to confirm
Store, target theme (unpublished ID), design (Figma frame or reference screenshot), content source (copy task output or client), where it will be used (templates), dynamic data (metafields/metaobjects/collections). Missing design states (mobile, empty, hover) or copy → placeholders in schema defaults + note; missing access → `ask_ceo`.

## Steps
1. `vault_list` → confirm store access. `shopify_theme` list themes; pick the unpublished working theme. Pull into `workspaces/<task-id>`, branch `agent/<task-id>`.
2. Identify architecture: Dawn-style (`{% schema %}` blocks inside the section) or Horizon-style (theme blocks in `blocks/`, `{% content_for 'blocks' %}`). Follow it.
3. Reuse theme primitives first: existing snippets (`card-product`, buttons, `image` helpers), CSS variables, colour schemes, spacing settings. Do not import a new framework.
4. Create `sections/<prefix>-<name>.liquid` (prefix `rh-` only if the theme has no convention). Structure:
   - Markup: semantic wrapper `<section id="Section-{{ section.id }}" class="rh-name color-{{ section.settings.color_scheme }}">`, headings with a `heading_tag` setting where SEO matters.
   - CSS scoped with `#Section-{{ section.id }}` or a unique class; put shared CSS in `assets/rh-name.css` loaded via `stylesheet_tag` (or `{% stylesheet %}` if no Liquid needed).
   - JS only if required: `assets/rh-name.js` with `defer`, custom element (`class RhName extends HTMLElement`) so it re-initialises in the theme editor (`shopify:section:load`).
5. Schema checklist: `name` via `t:` keys if the theme is translated; settings for every text, image, link, colour scheme, padding top/bottom; blocks with `limit` where needed; `presets` so it appears in "Add section"; sensible `default`s; `info` for tricky settings; `enabled_on`/`disabled_on` if template-specific.
6. Images: `{{ image | image_url: width: 1500 | image_tag: widths: '375, 750, 1100, 1500', sizes: '(min-width: 990px) 50vw, 100vw', loading: 'lazy', alt: image.alt | escape }}`; drop `lazy` and add `fetchpriority: 'high'` only if the section can be the first on the page. Placeholder: `{{ 'image' | placeholder_svg_tag }}` when blank.
7. Edge cases: 0 blocks, 1 block, max blocks, long text, missing image, RTL-safe spacing, sold-out product.
8. Add strings to `locales/en.default.json` (and schema locales) if the theme uses them.
9. `shopify theme check` → fix all errors. Push `--theme <id>` with `--only sections/... assets/... locales/...` to avoid overwriting customizer JSON.
10. In the customizer preview, add the section to the target template on the unpublished theme; fill with approved or placeholder content.
11. Test with `playwright` at 375/768/1440, keyboard, console; Lighthouse mobile vs baseline.
12. Commit, PR, `submit_output` with preview URL, customizer link, screenshots, settings list, and criteria map.

## Output template (submit_output summary)
```
Section: sections/rh-feature-grid.liquid (+ assets/rh-feature-grid.css)
Theme: #1234567890 "RizeHub WIP" (unpublished) · PR: <link> · Preview: <url>
Settings: heading, heading_tag, text, color_scheme, padding_top/bottom; block "feature" (icon, title, text, link) limit 8
Tested: 375/768/1440, 0/1/8 blocks, missing image, keyboard; theme check 0 errors; LH mobile 71 → 72
Criteria: 1) … met by … 2) …
```
