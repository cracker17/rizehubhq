# QA checklist: reel
Pass = every check true.

1. **1080×1920, 9:16**, H.264/AAC MP4, faststart. Verify: `ffprobe`.
2. **Length** within brief (default 7–45 s). Verify: `ffprobe`.
3. **Hook by 1.5 s**: strong visual + ≤ 7-word text; first frame is a real frame. Verify: frames at 0, 0.5, 1.5 s.
4. **Pacing**: no shot longer than ~4 s without a pattern interrupt (unless brief says). Verify: `ffmpeg scdet` scene-change timestamps.
5. **Captions** burned-in, 1–2 lines, ≤ 32 chars/line, synced ±100 ms. Verify: frames vs audio transcript.
6. **Safe zones**: captions/text clear of top 250, bottom 400, right 140 px. Verify: overlay guide on frames.
7. **0 caption typos**; brand names correct. Verify: transcript diff.
8. **Loudness** −14 LUFS ±1, TP ≤ −1 dBTP; no silence gap at loop point. Verify: `ebur128`, last/first 0.5 s.
9. **No stretched/distorted footage**; subject framed after reframe. Verify: contact sheet.
10. **Ending**: CTA or loop in last 2–3 s. Verify: last frames.
11. **Music licensed**; no trending/commercial audio baked into ads. Verify: licence list.
12. **No invented claims**. Verify: compare on-screen text to script.
13. **Cover frame** candidate supplied; criteria_map complete.
