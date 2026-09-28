# SOP: ui-mockup

Owner: uiux-1 / uiux-2. Output: high-fidelity, responsive HTML/CSS mockup (optionally mirrored in Figma by the CEO) plus a handoff spec.

## 1. Inputs
- Approved wireframe (dependency task) or brief with layout decided.
- Final or approved copy; client `brand.md` (colours, fonts, logo, imagery rules). Missing fonts/logo/copy → `ask_ceo`.
- Licensed assets only: client photos, open-licence fonts (OFL) and icons (MIT/ISC), approved stock.

## 2. Tokens first (`tokens.css`)
```css
:root{
  --color-bg:#FFFFFF; --color-text:#1A1A1A; --color-primary:<brand>; --color-primary-contrast:#FFFFFF;
  --font-head:<brand font>, system-ui; --font-body:<brand font>, system-ui;
  --fs-1:clamp(2rem,4vw+1rem,3.5rem); --fs-body:1rem; --lh-body:1.5;
  --space-1:4px; --space-2:8px; --space-3:16px; --space-4:24px; --space-5:40px; --space-6:64px;
  --radius:8px; --focus:0 0 0 3px <brand focus colour>;
}
```
Check every text/background pair for contrast (≥ 4.5:1 body, ≥ 3:1 large text and UI borders). If the brand colour fails, propose an accessible shade and flag it.

## 3. Build (`mockup.html`)
- Semantic HTML (`header`, `nav`, `main`, `section`, `button`, `label`), mobile-first CSS, no frameworks unless the dev stack uses them.
- Layout at 375 / 768 / 1440, fluid in between; max content width ~1200–1280 px; line length 45–80 characters.
- All states styled: hover, focus-visible, active, disabled, loading, error, empty, success.
- Targets ≥ 24×24 px (44×44 on touch primary actions); focus ring always visible; `prefers-reduced-motion` respected.
- Images with `alt`, correct aspect ratio boxes (no layout shift), `loading="lazy"` below the fold.
- E-commerce specifics: price, variant, stock and shipping info next to the CTA; sticky add-to-cart on mobile PDP; no fake urgency or invented reviews.
- App specifics: tables with sort/filter/empty state, forms with inline validation and clear errors.

## 4. Handoff spec (`handoff.md`)
Per component: name, purpose, variants, states, spacing tokens, breakpoints behaviour, content rules (max characters), platform mapping (Shopify section settings / Webflow class / WP block), accessibility notes.

## 5. Verify
- `playwright` screenshots at 375, 768, 1440 (+ one state sheet).
- `lighthouse` accessibility ≥ 95; 0 console errors; no horizontal scroll at 375.
- Compare to wireframe: every block present or change justified.

## 6. Submit
`submit_output` with mockup files, tokens, handoff, screenshots, asset licence list, placeholder list, criteria_map. Client presentation only via `request_external_action` after CEO approval.
