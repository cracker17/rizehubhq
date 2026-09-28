# QA checklist: audio-cleanup
Pass = every check true.

1. **Before/after measurements** table present (LUFS, dBTP, noise floor, clip count). Verify: output; re-measure after file.
2. **Noise floor ≤ −60 dBFS** in room-tone sections. Verify: `astats` on quiet segment.
3. **No processing artefacts** (underwater/warbling, gating chop). Verify: listen to before/after clip + 3 random segments.
4. **Hum removed** (50/60 Hz). Verify: spectrum (`showspectrumpic`).
5. **Loudness** on target ±1 LU; **true peak ≤ −1 dBTP**. Verify: `ebur128`.
6. **Speakers level-matched** within 1 LU. Verify: measure a segment per speaker.
7. **0 clipping** in output. Verify: `astats`.
8. **Sibilance and plosives** controlled. Verify: listen.
9. **Duration/content**: nothing removed except requested sections; edits crossfaded with room tone. Verify: duration compare + edit log.
10. **Formats**: WAV 48 kHz/24-bit master + MP3/AAC. Verify: `ffprobe`.
11. **Issue log** lists anything unfixable with timecodes. Verify: output.
12. **criteria_map** complete.
