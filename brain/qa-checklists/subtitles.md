# QA checklist: subtitles
Pass = every check true.

1. **Formats** requested (SRT/VTT/burned-in) delivered, UTF-8. Verify: `file` command.
2. **Parses cleanly**: sequential numbers, valid timestamps (SRT `,`, VTT `.` + `WEBVTT` header). Verify: `ffmpeg -i file -f null -`.
3. **No overlaps / negative durations**; last cue ≤ video duration. Verify: script over cues.
4. **Line length ≤ 42 chars, ≤ 2 lines** per cue. Verify: script.
5. **Reading speed ≤ 17 CPS** (≤ 20 social). Verify: script (chars ÷ duration).
6. **Cue duration 1–7 s**. Verify: script.
7. **Accuracy**: 5 random cues match audio word for word (per verbatim/clean verbatim style). Verify: listen/transcript at timestamps.
8. **Sync**: those 5 cues start within ±100 ms of speech. Verify: waveform/transcript timing.
9. **Names** spelled as in `brand.md`/`profile.md`. Verify: search.
10. **Line breaks** at phrase boundaries. Verify: read 10 cues.
11. **Burned-in (if requested)**: inside safe zones, ≥ 56 px on 1080 width, readable contrast. Verify: frames.
12. **Stats reported** (cue count, max CPS, max line length) and criteria_map complete.
