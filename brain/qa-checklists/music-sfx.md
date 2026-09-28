# QA checklist: music-sfx
Pass = every check true.

1. **Licence/source recorded** for every music and SFX asset (generation, client-owned, or library licence). Verify: cue sheet.
2. **No commercial songs, trending sounds in ads, or sound-alikes**. Verify: cue sheet + listen.
3. **Duration** matches picture/brief within ±0.1 s; clean ending (button or loop). Verify: `ffprobe` + listen to end.
4. **Mood/tempo** match brief. Verify: listen vs brief.
5. **Music ducked 12–18 dB under VO**; VO always intelligible. Verify: segment loudness under speech vs gaps.
6. **Phone-speaker check**: VO clear with 200 Hz high-pass. Verify: filtered render.
7. **SFX sync** within one frame of cue list. Verify: cue timecodes vs frames.
8. **Loudness** on target ±1 LU; **TP ≤ −1 dBTP**; 0 clipping. Verify: `ebur128`, `astats`.
9. **No vocals under VO** unless brief allows. Verify: listen.
10. **Deliverables**: mix WAV 48k/24-bit + MP3/AAC, stems if requested. Verify: `ffprobe`.
11. **Cue sheet** with timecode, asset, source, licence. Verify: read.
12. **criteria_map** complete.
