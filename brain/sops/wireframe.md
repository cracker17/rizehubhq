# SOP: wireframe

Owner: designer. Output: annotated low-fidelity wireframes that a developer can build without asking questions.

## 1. Inputs (stop and `ask_ceo` if any is missing)
- Goal of the page/flow and primary action (e.g. "add bundle to cart").
- Approved copy or copy task output (real headings, real product names).
- Client `profile.md` + `brand.md`, platform (Shopify/Webflow/WordPress/custom) and any platform limits.
- Existing page URL or Figma, if this is a redesign.

## 2. Define before drawing
Write this block at the top of `wireframe-spec.md`:
```
User: <who, context, device split if known>
Job: <what they are trying to get done>
Primary action: <one>   Secondary: <max two>
Success: <measurable, e.g. clicks "Build bundle">
Entry points: <ad, nav, email…>   Exit/success state: <…>
```

## 3. Structure
1. Content inventory: list every block the page needs, ordered by decision priority (what the user needs to know before acting).
2. For flows, draw a step list: screen → action → next screen, including error and empty paths.
3. Above the fold at 375 px: value proposition, proof (only real proof), primary CTA.
4. Keep nav depth ≤ 3, one primary CTA style per screen.

## 4. Build
- HTML wireframe in the workspace (`wireframe.html`), greyscale, system font, 8 px spacing grid, boxes labelled with real content lengths. No brand colours, no imagery beyond grey placeholders with alt text descriptions.
- Three widths: 375, 768, 1440. Show how blocks reflow (stack, hide, collapse to accordion).
- Number every block (`[B1]`, `[B2]`…) and annotate in `wireframe-spec.md`:
```
[B3] Variant picker: swatches (colour), buttons (size). Out-of-stock = struck + disabled, still focusable with tooltip "Sold out".
States: default, selected, disabled, error "Choose a size". Mobile: full width, 44 px targets.
Platform: Shopify product.variants; no app needed.
```
- Mark unknowns as `[PLACEHOLDER: reason]`, never invent numbers, reviews or prices.

## 5. Check
- Screenshots at 3 widths via `playwright` (`wireframe-375.png` etc.).
- Tab order logical; every input has a label; headings H1→H2→H3 in order.
- Every interactive block has states listed; every platform-dependent block has a note.

## 6. Submit
`submit_output` with `wireframe.html`, `wireframe-spec.md`, 3 screenshots, open questions list, and criteria_map. Never send to the client; the CEO decides via approval.
