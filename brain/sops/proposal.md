# SOP: proposal (Sales Agent)

Goal: a RizeHub-branded proposal the CEO can approve and send without edits, priced only from `brain/company/pricing.md`.

## 1. Gather (do not write yet)
- `rizehub_leads`: lead record, notes, fit score, audit findings, stage history.
- Email/DM thread (`gmail_read` or task attachment): their words for the problem, deadline, budget hints, decision maker.
- `brain/company/services.md`, `pricing.md`, `brand-voice.md`; `brain/clients/<slug>/` if they are an existing client.
- Re-verify each finding you will cite on their live site (`web_fetch`) if older than 30 days.

## 2. Gate check (stop and `ask_ceo` if any is true)
- No pricing.md line matches the scope, or the line is still a `{{PLACEHOLDER}}`.
- Scope unclear (you cannot write 3 concrete deliverables).
- They asked for a discount, guarantee, custom payment terms, or references.

## 3. Structure (Markdown → RizeHub PDF)
1. **Cover**: "Proposal for {Company}: {Outcome}", date, valid until (date + pricing.md validity).
2. **Where you are now** (≤ 120 words): their goal in their words + 2–3 verified findings with evidence.
3. **What we'll do**: approach in 3–5 steps.
4. **Options** (2–3, good/better/best). Each: deliverables (checkable nouns), timeline, price, pricing.md line reference (internal comment, strip before PDF).
5. **Not included**: explicit exclusions (e.g. copywriting, app fees, content entry beyond N pages).
6. **Timeline & milestones** with client responsibilities (access via RizeHub secure access link, content, feedback within 2 business days).
7. **Process & quality**: QA-checked, changes previewed on staging/unpublished theme, nothing goes live without client sign-off.
8. **Investment & terms**: from pricing.md (deposit, milestones, currency, revisions, change requests).
9. **Next step**: one action ("Reply 'Option B' and we'll send the agreement and deposit link").

## 4. Pricing rules
- Copy numbers exactly; show currency; recompute totals.
- Recommend one option and say why in one sentence.
- No discounts unless pricing.md defines them.

## 5. Writing rules
- Client-facing, RizeHub voice, no jargon without a plain explanation.
- No invented stats, testimonials, case studies or "we increased X by Y%".
- No personal names/emails unless the brief says so.

## 6. Deliver
- Save `proposal-{slug}.md` in workspace; list pricing lines used in output.
- `request_external_action(type: "send_proposal", spec: {to, subject, body, attachment})` only if the task says to prepare the send.
- `submit_output` with criteria_map.

## Example option block
```
### Option B: Speed + Conversion Fix (recommended)
- Mobile LCP target ≤ 2.5s on home, collection, product
- Remove/replace 3 render-blocking apps (list attached)
- Sticky add-to-cart on product pages
Timeline: 10 business days · Investment: {from pricing.md} 
```
