# QA checklist: video-edit
Pass = every check true.

1. **All requested exports** (ratios/platforms) delivered. Verify: file list vs brief.
2. **Specs**: resolution, fps, H.264, yuv420p, AAC 48 kHz, faststart. Verify: `ffprobe` each file.
3. **Duration ≤ max** in brief. Verify: `ffprobe` duration.
4. **Hook** visible with on-screen text by 1.0 s; no logo intro/black lead-in. Verify: extract frames at 0 s and 1 s.
5. **0 black or frozen frames** (unless intentional). Verify: `ffmpeg blackdetect` + `freezedetect`.
6. **Loudness** −14 LUFS ±1 (or brief target), true peak ≤ −1 dBTP. Verify: `ffmpeg ebur128`.
7. **Dialogue intelligible**; music ducked under speech. Verify: spot-check 3 speech sections (music not louder than VO in `astats` per segment).
8. **Captions** match audio word for word, 0 typos, inside safe zones. Verify: frames every 2 s vs transcript.
9. **Brand**: correct logo, fonts, colours, end card + CTA. Verify: final frames vs `brand.md`.
10. **Colour**: shots matched, skin tones natural, no clipped highlights. Verify: contact sheet.
11. **Reframing**: subject/product not cut off in any ratio. Verify: contact sheet per ratio.
12. **No invented claims**; testimonials not edited to change meaning. Verify: compare to source transcript.
13. **Licences/consents** listed for music, stock, people on camera. Verify: output list.
14. **Naming** `<client>_<project>_<ratio>_v<n>.mp4`; criteria_map complete.
