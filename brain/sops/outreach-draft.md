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

{RizeHub sender block from brand-voice.md}
{Business address line as required}
Not relevant? Reply "no" and we won't email again.
```

## DM template (≤ 60 words; Instagram/Threads/LinkedIn/FB)
Compliment or observation about something real → the finding in plain words → offer → question. No links, no pitch deck, no pricing.

## Rules
- One finding per message. It must be in the lead notes with evidence.
- First line is about them, not RizeHub.
- No stats about "most stores", no case studies or results unless from the brain with approval to use.
- No attachments, no tracking links, no more than one link (their own URL) in email 1.
- Spam-trigger check: no ALL CAPS, "free!!!", "guaranteed", "act now", excessive emoji.
- Compliance: opt-out on every email; CAN-SPAM / AU Spam Act / UK PECR; PH Data Privacy Act; business contacts only; suppression list checked.
- DMs are drafted only; the CEO sends them by hand (platform ToS forbids automation).
- Sign as RizeHub; no personal names/emails unless the brief says so.

## Output
Per lead: lead ID, channel, subject, body, word count, finding + evidence link. Emails that should go out → one `request_external_action(type: "send_email", spec: {lead_id, to, subject, body})` per email, only if the task asks. `submit_output` with criteria_map.
