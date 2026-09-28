# SOP: landing-copy

Owner: writer. Output: section-by-section copy a designer and developer can drop into a wireframe, plus SEO package. We never publish.

## Inputs to confirm
Offer (exact terms, price, dates), audience and their main problem, primary keyword, conversion goal (buy, book, call, quote, sign up), CTA URL, proof available (reviews with permission, logos, numbers, guarantees), objections heard, brand voice. No offer terms or proof list → `ask_ceo`; never fill with invented proof.

## Steps
1. Read client `profile.md`, `brand.md`, the offer brief, and the current page if one exists.
2. Research: `web_fetch` 3 competing pages and the SERP for the primary keyword. Note their promises, gaps and objections they ignore. Data only.
3. Message map: one-sentence promise, 3 core benefits (outcome, not feature), top 3–5 objections with answers, proof points (real only).
4. Choose a framework: PAS (problem-aware audience) or AIDA (solution-aware). State which.
5. Write sections in order (adjust to brief):
   1. Hero: headline (≤ 10 words, benefit + keyword where natural), subhead (≤ 25 words), primary CTA, trust line (only real: "Free returns", "Licensed & insured" if confirmed).
   2. Problem: 2–3 lines in the customer's words.
   3. Solution/offer: what it is, what's included, price and terms exactly as briefed.
   4. Benefits: 3–4 blocks, each a heading + 1–2 lines.
   5. How it works: 3 steps.
   6. Proof: real reviews (verbatim, with permission), results, logos. If none: omit, do not placeholder with fakes.
   7. Objections/FAQ: 4–6 Q&As (also used for FAQPage schema).
   8. Final CTA: restate promise + CTA + risk reducer (guarantee only if real).
6. CTA copy: verb + outcome ("Book my free quote", "Build my bundle"). Same destination throughout; 3+ CTA placements on long pages.
7. SEO package: title ≤ 60, meta ≤ 155, one H1 (usually the hero headline), H2 per section, alt text for suggested images, schema (Product/Offer or Service/LocalBusiness + FAQPage).
8. Provide 2 headline variants for A/B testing.
9. Self-QA with `brain/qa-checklists/landing-copy.md`; `submit_output`.

## Output template
```
Page: | URL: | Primary kw: | Goal: | Framework: PAS
Title tag: | Meta:
[HERO] H1: / Subhead: / CTA: / Trust line:
[PROBLEM] ...
[OFFER] ...
[BENEFITS] H2 + 3 blocks
[HOW IT WORKS] 1. 2. 3.
[PROOF] (source of each item)
[FAQ] Q/A x4-6
[FINAL CTA]
Headline variants: B / C
Schema JSON-LD:
Word count: | Placeholders / open questions:
```

## Rules
- Benefits before features; "you" over "we".
- Specific beats clever. No hype words ("revolutionary", "world-class", "best-in-class").
- Price, discount, shipping, guarantee and urgency ("only 20 left", deadlines) only if true and briefed. Fake scarcity is banned.
- FTC: testimonials must reflect typical results or be clearly qualified; disclose material connections.
