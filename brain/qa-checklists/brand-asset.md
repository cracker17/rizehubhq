# QA checklist: brand-asset
Pass = every check true.

1. **All requested assets delivered** in the package tree. Verify: compare brief list to files.
2. **Logo formats**: SVG, transparent PNG (512/1024/2048), PDF vector; colour, black, white versions. Verify: file list + open SVG (vector, no embedded raster).
3. **Colour values** match `brand.md` (HEX/RGB/CMYK). Verify: compare.
4. **Brand sheet**: clear space, minimum size, palette, type scale, misuse examples. Verify: read.
5. **Legibility**: logo readable at minimum size and on light/dark/photo backgrounds. Verify: preview sheet.
6. **Digital sizes exact** (hero, email header, covers). Verify: `identify`.
7. **Print specs**: CMYK, 300 dpi images, 3 mm bleed, 5 mm safe margin, crop marks, fonts embedded/outlined, PDF/X. Verify: `pdfinfo`/`pdffonts`, `identify -verbose`.
8. **Text accuracy**: copy and contact details match approved copy/`profile.md`; 0 typos; nothing invented. Verify: diff.
9. **Licences** for all fonts/images listed. Verify: output.
10. **New logo concepts** (if any): 3 distinct directions with rationale; similarity check noted; trademark decision flagged to CEO. Verify: read.
11. **Naming** `<client>_<asset>_<variant>.<ext>`. Verify: file list.
12. **No personal names/emails** unless brief requires; RizeHub branding on RizeHub docs. Verify: search.
13. **criteria_map** complete.
