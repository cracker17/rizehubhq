# QA checklist: voiceover
Pass = every check true.

1. **Script accuracy 100%**: transcript of audio matches approved script word for word. Verify: transcribe and diff.
2. **Pronunciation**: every name in the pronunciation table said correctly. Verify: listen at those timestamps.
3. **Accent/tone** match brief. Verify: listen to 3 sections.
4. **Duration** within ±0.5 s of target/picture. Verify: `ffprobe`.
5. **Loudness** on target ±1 LU (social −14, podcast −16, broadcast −23/−24) or −16 to −18 for VO stems. Verify: `ebur128`.
6. **True peak ≤ −1 dBTP; 0 clipping**. Verify: `ebur128`, `astats`.
7. **No artefacts**: clicks at edits, robotic words, clipped line endings, digital silence mid-read. Verify: listen + `silencedetect`.
8. **Sibilance/plosives controlled**. Verify: listen to S/P-heavy lines.
9. **Formats**: WAV 48 kHz/24-bit + MP3 320 kbps. Verify: `ffprobe`.
10. **Voice ID/settings recorded** for reuse. Verify: output.
11. **Consent**: no real person's voice used without CEO-confirmed written consent. Verify: output notes/voice source.
12. **Script meaning unchanged, no added claims**. Verify: diff.
13. **Naming + criteria_map** complete.
