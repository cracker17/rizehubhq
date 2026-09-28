# SOP: music-sfx

Owner: sound-engineer. Output: music beds, stings/logos, SFX sets, and final music+VO+SFX mixes for video, ads, podcasts.

## 1. Inputs (missing → `ask_ceo`)
Use (paid ad, organic social, YouTube, podcast intro, broadcast), duration or picture to sync, mood/genre/tempo references (described, not "make it sound like <famous song>"), brand `brand.md`, VO stem if mixing, platform loudness target.

## 2. Licensing rules
- Only: `audio_tools` generated music/SFX (record the generation and terms), client-owned tracks with licence, or licensed library tracks with licence reference in the output.
- Never: commercial songs, platform "trending sounds" in paid ads, sound-alikes of specific copyrighted songs, rips from YouTube.
- Record for every asset: source, licence/terms, date, prompt or track ID.

## 3. Music beds
- Brief the generator: genre, BPM, key feel, instrumentation, energy curve, structure with exact length (e.g. "30 s: 2 s intro, build at 12 s, button ending at 29.5 s"), "no vocals" under VO.
- Generate 2–3 options; choose by fit to mood, tempo matching cut pace, space in 1–4 kHz for voice.
- Edit to picture: start/end on phrase or bar, hit key cuts, clean button ending or loopable tail for Reels; no abrupt fade-outs unless intended (≥ 1.5 s fade).

## 4. SFX
- Generate/select per cue list: `00:03.2 whoosh (transition)`, `00:07.0 pop (text)`, `00:12.4 cash-register ding` etc.
- Sync within one frame (33 ms at 30 fps); subtle, −6 to −12 dB below VO peaks; no fatiguing repetition (vary 2–3 versions).

## 5. Mix
- Levels: VO dominant; music ducked 12–18 dB under speech (sidechain or keyframed), rises in gaps.
- EQ music dip 2–4 kHz by 2–3 dB under VO if masking.
- Loudness: social −14 LUFS, podcast −16 LUFS, broadcast −23 LUFS / −24 LKFS; true peak ≤ −1 dBTP. Verify with `ebur128`.
- Check on phone-speaker simulation (high-pass ~200 Hz) that VO stays intelligible.

## 6. Deliver
Mix WAV 48 kHz/24-bit + MP3/AAC; stems (music, SFX, VO) as WAV; cue sheet (timecode, asset, source, licence). `submit_output` with files, measurement table, licence list, criteria_map. Sending or publishing = `request_external_action`.
