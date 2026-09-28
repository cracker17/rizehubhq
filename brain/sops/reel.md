# SOP: reel

Owner: video-editor. Output: vertical short-form (Instagram Reels, TikTok, YouTube Shorts, Facebook Reels), usually 7–45 s, 1080×1920.

## 1. Inputs (missing → `ask_ceo`)
Script/hook from Social Marketing (`short-video-script` output), footage or approved generated B-roll, brand fonts/colours, music plan (licensed library or generated; platform trending audio is added by the CEO at posting time, never baked into client ads), target length.

## 2. Structure
```
0.0–1.5 s  HOOK: strongest visual + ≤ 7-word on-screen text (question, bold claim the script supports, or result)
1.5–N s    VALUE: one idea per beat, cut every 1.5–3 s
last 2–3 s PAYOFF/CTA: "Follow for part 2", "Shop link in bio", loop back to the first frame when possible
```
Rules: no logo intro, no black lead-in, first frame is a real frame (it becomes the default cover).

## 3. Edit
- Jump cuts on breaths and filler; keep speech pace natural (do not speed voice above 1.1×).
- Pattern interrupts every 3–5 s: punch-in 110–120%, B-roll, text pop, SFX whoosh/hit.
- Reframe 16:9 footage with `video_tools` crop, tracking the subject; never stretch.
- Colour: match clips, brand grade, clean skin tones.

## 4. Captions (burned-in)
- 1–2 lines, ≤ 32 characters per line, 1–4 words per caption chunk, highlight key word in brand accent.
- Font ≥ 56 px, white/brand text with 4–6 px stroke or box.
- Position: centre third of frame; keep top 250 px, bottom 400 px and right 140 px clear (platform UI).
- Sync ±100 ms; spelling matches script; brand names correct.

## 5. Audio
Voice at −14 LUFS integrated overall mix, true peak ≤ −1 dBTP; music ducked under speech; no audio gap at the loop point.

## 6. Export and verify
MP4 H.264 High, 1080×1920, 30 fps (or source), 10–16 Mbps, AAC 48 kHz 320 kbps, `+faststart`. Verify with `ffprobe`; confirm length ≤ target (TikTok/Reels best 15–45 s unless brief says otherwise). Extract a cover frame candidate at 1080×1920 and a 4:5 centre-crop check (IG grid shows 3:4 center).

## 7. Submit
`submit_output`: MP4, cover frame, caption text (for the post, from Social), specs table, licences, criteria_map. Posting = `request_external_action`.
