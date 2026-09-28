# SOP: shopify-page

Owner: shopify-dev. Output: a new page, landing page, product or collection template (JSON template + sections) on an UNPUBLISHED theme, ready for CEO review.

## Inputs to confirm
Page purpose and target URL, template type (page/product/collection/custom), approved copy (from `landing-copy` task or client), wireframe/mockup, assets, primary CTA and its destination, SEO title/description, tracking needs. Missing copy/CTA URL → `ask_ceo`; do not write marketing copy yourself.

## Steps
1. Pull the unpublished working theme into `workspaces/<task-id>`, branch `agent/<task-id>`. Record baseline Lighthouse of a comparable existing page.
2. Plan the section stack from the wireframe. For each band decide: existing theme section (preferred), existing section with new settings, or new section (follow `brain/sops/shopify-section.md`).
3. Create the template: `templates/page.<handle>.json` (or `product.<name>.json`, `collection.<name>.json`). Keep ≤25 sections. Give sections readable keys (`hero`, `benefits`, `faq`) not random IDs.
4. Content: enter approved copy into section settings on the unpublished theme. Placeholders must be obvious: `[PLACEHOLDER: testimonial — awaiting client]`.
5. Page object: creating the Shopify Page resource (admin content) is client-visible on the live store's page list. Draft it hidden (`published: false`) via `vault_api` only if the scope note allows content writes; otherwise include it in `request_external_action` with the exact title, handle, template suffix and SEO fields.
6. SEO: one H1, logical H2/H3, meta title ≤ 60 chars, description ≤ 155 chars, image alts, internal links using `routes` objects (`{{ routes.cart_url }}`) not hardcoded paths. Add JSON-LD only if the theme lacks it and data is real (e.g. FAQPage from real FAQs).
7. Conversion basics: CTA visible above the fold on mobile, CTA buttons are links/forms with clear labels, product add-to-cart uses the theme's product form or AJAX Cart API, trust elements only from real data.
8. Performance: the hero image is the LCP element → no lazy, `fetchpriority: 'high'`, correct `sizes`. Video: poster image, `preload="none"`, muted autoplay only if brand wants it. No new third-party scripts without approval.
9. `shopify theme check`; push with `--only templates/... sections/... assets/...` so settings_data isn't overwritten.
10. Test at 375/768/1440: layout, CTA links resolve (`link_checker`), forms, keyboard, console, Lighthouse mobile. Test cart flow if the page adds to cart (stop before checkout).
11. PR, `submit_output`: preview URL (`/pages/<handle>?preview_theme_id=<id>`), template file, section list, placeholders list, SEO fields, Lighthouse before/after, criteria map, and the exact external actions the CEO must approve (create page, assign template, publish).

## Section plan template
| # | Band | Section file | New/Existing | Settings used | Content source |
|---|---|---|---|---|---|
| 1 | Hero | image-banner | Existing | heading, text, button, image | landing-copy task |
| 2 | Benefits | rh-feature-grid | New | 4 blocks | landing-copy task |
