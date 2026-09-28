# SOP: brand-asset

Owner: designer. Output: logo files, brand kit, banners, email headers, one-pagers, print-ready collateral.

## 1. Inputs (missing → `ask_ceo`)
- Asset list and use (web, social, print, signage), sizes, quantities, deadline.
- Existing brand files: vector logo (SVG/AI/EPS/PDF), palette, fonts and their licences. If only a low-res logo exists, flag it; do not trace-and-alter a logo without CEO approval.
- For new logos/identities: the creative brief, competitors, words to convey, words to avoid.

## 2. Logo and brand kit
- Deliver: primary, secondary/stacked, icon mark; full colour, mono black, mono white (reversed).
- Formats: SVG (web), PNG transparent at 512/1024/2048 px, PDF vector (print); favicon 32/180/512.
- Brand sheet: clear space (e.g. height of the logo's x), minimum size (e.g. 24 px / 15 mm), palette in HEX, RGB, CMYK (+ Pantone if supplied), type scale, 4–6 misuse examples, imagery style.
- Check logo legibility at minimum size and on light, dark and photo backgrounds.
- New logo concepts: 3 distinct directions with rationale; check for obvious similarity to existing marks (reverse image search via `web_fetch` results where possible); flag trademark clearance as the CEO's decision.

## 3. Digital banners and headers
Common sizes: website hero 1920×1080 (safe centre 1200×600), email header 600×200 @2x, Facebook cover 851×315 (mobile safe 640×360), LinkedIn banner 1584×396, YouTube banner 2560×1440 (safe 1546×423).

## 4. Print-ready
- CMYK colour, 300 dpi images, 3 mm (0.125 in) bleed, 5 mm safe margin, crop marks.
- Fonts embedded or outlined; rich black (C60 M40 Y40 K100) for large areas only; body text 100% K.
- Export PDF/X-1a (or PDF/X-4 if the printer asks). Include a low-res proof PNG.
- Common sizes: US Letter 8.5×11 in, A4 210×297 mm, business card 3.5×2 in (US) / 90×55 mm (AU) / 85×55 mm (UK/EU).

## 5. Checks
Spell-check all text against approved copy; verify contact details only from `profile.md` (never invent); verify colour values against `brand.md`; file naming `<client>_<asset>_<variant>.<ext>`; package in a folder tree `/logo /brand-kit /print /digital`.

## 6. Submit
`submit_output` with the package, a preview sheet, font/image licence list, printer notes, criteria_map. Sending files to a client or printer is a `request_external_action`.
