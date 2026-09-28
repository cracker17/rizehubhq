# SOP: ad-creative

Owner: designer. Output: static ad creatives per platform spec, ready for the CEO to approve and run.

## 1. Inputs (missing → `ask_ceo`)
- Offer, audience, platform(s), ratios, number of variants, CTA.
- Approved copy (hook line, supporting line, CTA) from the copy task. Do not write claims yourself.
- Client `brand.md`: logo files, palette, fonts, imagery do/don't. Real product images.

## 2. Specs
| Placement | Size | Safe zone |
|---|---|---|
| Meta feed 1:1 | 1080×1080 | 60 px margin |
| Meta feed 4:5 | 1080×1350 | 60 px margin |
| Stories/Reels 9:16 | 1080×1920 | top 270 px, bottom 380 px, sides 65 px free of text/logo |
| TikTok 9:16 | 1080×1920 | as above + right 140 px rail |
| Google Display | 300×250, 336×280, 728×90, 300×600, 320×50, 160×600 | 10 px; ≤ 150 KB |
| PMax | 1200×628, 1200×1200, 960×1200 | logo 1200×1200 and 1200×300 |

## 3. Concepts
Write one line per variant and change one variable at a time:
```
V1  Audience: busy mums AU | Hook: "Dinner sorted in 10 min" | Visual: product on table, hands | CTA: Shop now
V2  same audience | Hook: problem-first "Still cooking at 8pm?" | same visual | same CTA
```

## 4. Visuals
- Prefer real client product photos. For scenes, `image_gen` with: subject, setting, lighting, lens, composition, "empty negative space top third for headline", brand colours, reference images. Log every prompt.
- Composite the real product and real logo over AI backgrounds; never let AI render the label, text or logo.
- Inspect at 200%: hands, faces, eyes, teeth, text, product shape/colour, edges, shadows. Regenerate or retouch any artefact.

## 5. Layout
- One focal point, hook ≤ 7 words, headline ≥ 60 px on 1080 canvases, body ≥ 32 px, max 2 fonts.
- Text contrast ≥ 4.5:1 (use scrim/gradient). Logo at consistent position and minimum size.
- CTA looks like a label, not a fake clickable UI button on Meta.
- Build in HTML/SVG and render to exact pixels (`bash_sandboxed`), then `identify` to confirm size.

## 6. Policy and claims check
No before/after for health/beauty/weight claims, no personal-attribute phrasing ("Are you depressed?"), no fake scarcity or countdowns, no income or result claims without substantiation in the brief, disclose paid partnerships if a creator appears. Licences recorded for fonts/photos.

## 7. Export and name
PNG (text-heavy) or JPG sRGB q85–90. `<client>_<campaign>_V1_4x5_v1.png`. Build a contact sheet of all variants at phone size (375 px wide).

## 8. Submit
`submit_output`: files, contact sheet, concept table, prompt log, licence list, criteria_map. Launching ads = `request_external_action` after CEO approval.
