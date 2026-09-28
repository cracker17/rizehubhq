# SOP: video-edit

Owner: video-editor. Output: finished edits of long or mid-form video (ads 15–60 s, brand videos, testimonials, YouTube) in every requested format.

## 1. Inputs (missing → `ask_ceo`)
- Footage, approved script or outline, VO (from sound-engineer) or on-camera audio, music (licensed), brand `brand.md` (fonts, colours, logo, end card).
- Deliverable list: platforms, ratios, max durations, caption style, due date.
- Consent: people on camera have signed releases (confirmed in brief) for ads and testimonials.

## 2. Log and plan
- `ffprobe` every clip: resolution, fps, codec, duration, audio channels. Note mismatched fps (conform to project fps, usually 30 or 25 for AU/UK sources).
- Transcribe/skim; list best takes with timecodes. Build an edit plan:
```
00:00–00:02 Hook: <visual + text>
00:02–00:20 Problem/demo: <shots>
00:20–00:27 Proof: <real testimonial/footage only>
00:27–00:30 CTA + end card
```

## 3. Assemble
- Rough cut with `video_tools` cut/concatenate or ffmpeg; remove dead air, false starts, filler (keep meaning intact).
- Hook in the first 1–2 s; pattern interrupt every 3–5 s (punch-in, B-roll, text, angle).
- Reframe per ratio (`video_tools` crop) keeping faces/product centred and away from caption zones.

## 4. Polish
- Colour: correct exposure/white balance, match shots, then brand grade (`video_tools` colour grade). Skin tones natural.
- Graphics: brand fonts, lower thirds, end card with logo + CTA; text inside safe zones.
- Captions: see `subtitles` SOP; burned-in for social, sidecar SRT for YouTube/web.
- Audio: dialogue first; music ducked 12–18 dB under speech; 10 ms fades at cuts; SFX subtle.
- Loudness: `ffmpeg -af loudnorm=I=-14:TP=-1:LRA=11` two-pass for social (−16 for YouTube long-form OK); verify with `ebur128`.

## 5. Export
```
ffmpeg -i in -c:v libx264 -profile:v high -pix_fmt yuv420p -b:v 12M -maxrate 16M -bufsize 24M \
 -c:a aac -b:a 320k -ar 48000 -movflags +faststart <client>_<project>_<ratio>_v1.mp4
```
9:16 1080×1920, 4:5 1080×1350, 1:1 1080×1080, 16:9 1920×1080. Verify each with `ffprobe`.

## 6. Self-QA
Watch through extracted frames every 2 s; check 0 black/frozen frames, captions correct, logo/end card correct, duration ≤ max, loudness within ±1 LU. Pull 3 thumbnail candidate frames.

## 7. Submit
`submit_output`: exports, specs table, contact sheet, thumbnail frames, asset/licence list, edit notes, criteria_map. Uploading or sending = `request_external_action`.
