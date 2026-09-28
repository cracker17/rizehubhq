# SOP: voiceover

Owner: sound-engineer. Output: finished voiceover audio from an approved script, timed to picture or target length, to loudness spec.

## 1. Inputs (missing → `ask_ceo`)
Approved final script, market/accent (US/AU/UK), tone, target length or picture to sync, platform (sets loudness), pronunciation of names, brand voice spec if one exists (`brand.md` or a previous `voice-design` output). Never change the script's meaning or add claims.

## 2. Prepare the script (`script-tts.txt`)
- Numbers, prices, dates, units and URLs spelled as spoken: "$29.99" → "twenty-nine ninety-nine", "10/12" → per market ("October twelfth" US, "the tenth of December" AU/UK), "rizehub.ph" → "rize hub dot p h".
- Brand/place names: phonetic respelling in a pronunciation table, e.g. `Davao = dah-VOW`, `Quido = KEE-doh`. Confirm uncertain ones with the CEO.
- One line per sentence, ≤ 20 words. Pacing marks: comma = short pause, `<break time="400ms"/>` = beat, blank line = paragraph pause. Direction tags per line: `[warm]`, `[upbeat]`, `[slower, confident]`.
- Estimate duration: words ÷ WPM (ads 150–170, explainers 140–155, calm/luxury 110–130). If over target length, `ask_ceo` for cuts; do not speed voice beyond 1.1×.

## 3. Voice
- Use the locked brand voice if one exists. Else audition 2–3 `audio_tools` voices on the same two lines; pick by accent, age range, energy, clarity; record voice ID and settings.
- Stock/TTS voices only. Any real person's voice (clone or changer) needs written consent confirmed by the CEO.

## 4. Generate and fix
- Generate line by line or paragraph by paragraph. Regenerate any line with mispronunciation, wrong emphasis, robotic cadence, clipped endings or artefacts.
- Compare generated transcript to script: 100% word match.

## 5. Process
Chain (ffmpeg/sox): high-pass 80 Hz → light EQ (cut mud 250–400 Hz if boxy, +1–2 dB 3–5 kHz presence) → de-ess 5–8 kHz → compression ~3:1, 3–6 dB GR → edit breaths down 6–10 dB → 10 ms fades at edits → room tone gaps (no digital silence mid-read).
Loudness: social −14 LUFS, podcast −16 LUFS, broadcast −23 LUFS (EBU R128) or −24 LKFS (US); true peak ≤ −1 dBTP. VO stem for video: deliver unmixed at −16 to −18 LUFS if the Video Editor mixes music.

## 6. Sync
If picture exists, place lines at the script's timecodes (`video_tools` to lay back) and confirm start/end within ±0.5 s.

## 7. Deliver
`<client>_<project>_vo_v1.wav` (48 kHz/24-bit) + `.mp3` 320 kbps; line-split files if requested. `submit_output` with files, spec table (LUFS, dBTP, duration), pronunciation table, voice ID/settings, criteria_map. Sending = `request_external_action`.
