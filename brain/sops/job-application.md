# SOP: job-application (Job Scout)

Goal: a tailored, honest application draft per shortlisted job that the CEO can paste and submit in under a minute.

## 1. Prep
- Re-`web_fetch` the post (still live?). Read it fully twice.
- Extract: their stack/platform, the actual problem, screening questions (numbered), required keyword/subject code/opening word, word limits, apply method, timezone.
- Read `brain/career/application-style.md`, `portfolio.md`, `job-filters.md`; check `job_tracker` for prior quotes/disclosures to this employer.

## 2. Pick proof
- 3–5 portfolio links of the **same platform** as the job (from portfolio.md, copied exactly). Prefer the closest niche/feature match.
- The matching resume link for that role type.
- One real technical detail from portfolio.md that maps to their problem.

## 3. Write (structure)
1. **Subject** (if a field exists): specific, uses their required code; e.g. "Shopify OS 2.0 dev: sections without app bloat". Never "Job Application".
2. **Hook** (1–2 sentences): a specific technical insight about their stack/problem, or the direct answer to their first screening question. Required opening word goes first if demanded.
3. **Proof** (2–3 sentences): relevant experience + the one real detail, no invented numbers.
4. **Screening answers**: numbered, answered in order, directly.
5. **Links**: 3–5 portfolio links + resume.
6. **Logistics**: availability, hours (Davao, PH; can cover their timezone if filters say so), rate only per job-filters.md or their posted rate.
7. **Close**: a low-friction offer (e.g. free mini-audit of their current site/theme) + simple next step.
8. **Signature** exactly as in portfolio.md.

## 4. Length and tone
- OnlineJobs.ph 200–250 words, warmer; Indeed 150–200; LinkedIn/email ≤ 150.
- Confident, peer-to-peer. Banned: "kindly consider me", "sir/ma'am", "I am writing to apply", "hardworking and dedicated", "I hope this finds you well".
- Honest gaps: if they need something not in portfolio.md, say so in one line and show the nearest real equivalent.

## 5. Save & deliver
- `job_tracker` update: `draft`, status `drafted`.
- Output per job: link, score, apply method, subject, message, word count, links used, manual steps (Loom, form, email).
- `submit_output` with criteria_map. The CEO submits; never set `applied`.

## Mini example (OnlineJobs.ph, opening)
"Your collection pages are rendering filters client-side, which is why Google shows them as 'Duplicate, Google chose a different canonical'. The fix is in the theme's canonical tag, not an app. …" (Only use insights you can verify on their site or that follow directly from their post.)
