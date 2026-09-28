# SOP: outreach-draft (Sales Agent)

Goal: one personalised first message per lead, built on ONE verified finding, ready for the CEO to approve (email) or send himself (DM).

## Inputs
Lead notes from lead-report (finding, evidence, angle), `brand-voice.md`, `services.md`, suppression status. If a lead has no verified finding, do not draft; flag it.

## Email template (≤ 90 words)
```
Subject: {company} {specific thing}   ← ≤ 45 chars, e.g. "Glow Co mobile product page"

Hi {first name or "{Company} team"},

{Observation: the verified finding, concrete. e.g. "Your product pages take ~6s to show the main image on mobile (PageSpeed, 3 Oct)."}
{Why it matters in one line, no invented stats. e.g. "That's the moment most mobile shoppers decide to stay or bounce."}
{Offer, low friction: "Happy to send a free 3-point fix list for that page, no call needed."}
{Question CTA: "Want it?"}
```
Do NOT write a sign-off, address or opt-out line yourself: when you save the email with `draft_first_email`, the worker
appends the fixed sender block ("Julev Ajeto, RizeHub"), the postal address and the opt-out line to every email (the
tool refuses drafts that contain their own). The tool's `preview` shows the exact email.

## DM template (≤ 60 words; Instagram/Threads/LinkedIn/FB)
Compliment or observation about something real → the finding in plain words → offer → question. No links, no pitch deck, no pricing.

## Rules
- One finding per message. It must be in the lead notes with evidence.
- First line is about them, not RizeHub.
- No stats about "most stores", no case studies or results unless from the brain with approval to use.
- No attachments, no tracking links, no more than one link (their own URL) in email 1.
- Spam-trigger check: no ALL CAPS, "free!!!", "guaranteed", "act now", excessive emoji.
- Compliance: opt-out on every email (added by the worker; check the preview); CAN-SPAM / AU Spam Act / UK PECR; PH Data Privacy Act; business contacts only; suppression list checked.
- DMs are drafted only; the CEO sends them by hand (platform ToS forbids automation).
- Sign as RizeHub; no personal names/emails unless the brief says so.

## Output
Per lead: lead ID, channel, subject, body, word count, finding + evidence link. Emails → save each with `draft_first_email` (lead added with `lead_create` / `lead_update_research` first): it joins the daily batch approval and the worker sends it only after the CEO approves. Never `request_external_action` for these emails. `submit_output` with criteria_map.
