# SOP: voice-design

Owner: sound-engineer. Output: a reusable brand voice (selected/designed TTS voice or consented voice change) with a locked spec so every future voiceover sounds the same.

## 1. Brief and consent gate
- Inputs: brand personality (3–5 adjectives from `brand.md`), audience, markets/accents, use cases (ads, explainers, IVR, podcasts), voices to avoid.
- Designing a new synthetic voice from a text description or choosing a stock voice: allowed.
- Cloning, voice-changing into, or imitating a real person (founder, staff, talent): only with that person's **written consent on file, confirmed by the CEO via `ask_ceo`**, stating scope (which projects, how long). No celebrities, public figures, or "sound-alike" requests; refuse and escalate.

## 2. Define the target (`voice-spec.md`)
```
Personality: warm, confident, playful (not salesy)
Gender presentation / age range: <as briefed>
Accent: General Australian   Pace: 150 wpm   Pitch: mid   Energy: 6/10
Use: 15–30 s social ads, product explainers
Avoid: announcer voice, vocal fry, over-smiling
```

## 3. Audition
- Shortlist 3–5 candidates with `audio_tools` (stock voices or voice design from description).
- Test script (write once, reuse): a hook line, a price/number line, a brand name line, a question, and a calm CTA. Include the hardest brand/place names.
- Render each candidate with identical settings; label A/B/C files.

## 4. Tune
- For the best 2: adjust stability/consistency, style/expressiveness, speed; generate each test line 3 times to check consistency (the same voice must not drift across takes).
- Check each for artefacts: metallic tone, breath noise, mispronounced names, odd emphasis on numbers.

## 5. Lock
Write the final spec: provider voice ID, all settings, pronunciation dictionary (brand, product, place names in phonetic respelling), direction tags that work, WPM range, processing chain and loudness targets, and "do not use for" notes. Save sample renders (`voice-sample-hook.wav`, etc.).

## 6. Deliver
`submit_output` with the audition pack (A/B/C), recommended voice with reasons, `voice-spec.md`, pronunciation dictionary, consent reference if a real person was involved, criteria_map. The CEO approves the voice before any client use; sharing samples with the client is a `request_external_action`.
