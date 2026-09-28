# QA checklist: ad-creative
Pass = every check true.

1. **Exact dimensions** for every requested placement. Verify: `identify` each file.
2. **Safe zones**: all text/logo/CTA inside safe zones (9:16 top 270/bottom 380/sides 65 px; TikTok right 140 px). Verify: overlay safe-zone guide on each file.
3. **Variant count** matches brief; each variant differs in the stated test variable. Verify: concept table.
4. **Copy matches approved copy** word for word; 0 typos. Verify: diff against copy task.
5. **Hook ≤ 7 words, readable at 375 px wide**. Verify: contact sheet at phone size.
6. **Text contrast ≥ 4.5:1** over image. Verify: sample colours, compute ratio.
7. **0 AI artefacts**: hands, faces, text, logo, product shape/colour correct. Verify: inspect at 200%.
8. **Real product and logo**, not AI-rendered labels. Verify: compare with client assets.
9. **Brand**: only brand fonts/colours; logo min size and clear space respected. Verify: `brand.md`.
10. **No invented claims**: every price, offer, stat, testimonial traceable to brief/client files. Verify: source check.
11. **Ad policy**: no before/after health/beauty claims, personal-attribute language, fake buttons, fake scarcity. Verify: read.
12. **Licences** listed for every font/photo; prompt log present. Verify: output.
13. **File size/format**: GDN ≤ 150 KB; PNG/JPG sRGB; naming convention. Verify: `ls -l`, `identify`.
14. **criteria_map** complete.
