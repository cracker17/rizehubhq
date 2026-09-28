# SOP: follow-up-email (Sales Agent)

Goal: short follow-ups that add value and get a reply, drafted for CEO approval.

## 1. Context
- Lead record + stage + last touch date (`rizehub_leads`), full thread (`gmail_read`).
- Check suppression/opt-out status. If opted out or replied "not interested": stop, no draft, note it.
- If they replied with a question, answer it (this is a reply, not a follow-up).

## 2. Cadence (from last send)
| Touch | Day | Angle |
|---|---|---|
| FU1 | +3 | One new verified finding or quick win |
| FU2 | +7 | Relevant example/process (only real work from the brain) or a sharper question |
| FU3 | +14 | Break-up: close the loop politely, leave the door open |
After a proposal: +2 (questions?), +5 (answer likely objection), +10 (break-up).

## 3. Template
```
Subject: {≤ 50 chars, specific, lowercase-friendly, no "Re:" fakery}

Hi {first name or team},

{One line tying back to last message.}
{One new useful thing: finding, tip, or answer.}
{One question or CTA.}

{Sender block from brain/company/brand-voice.md}
{Opt-out line for cold emails: "Not relevant? Reply 'no' and we won't email again."}
```

## 4. Rules
- ≤ 120 words, plain text, one CTA, no attachments on cold follow-ups.
- Never "just checking in" / "bumping this" as the whole message.
- Never fake urgency, discounts or scarcity; no prices unless from pricing.md and already proposed.
- Keep thread (reply in same thread) unless the brief says new thread.
- Business contacts only; honour country anti-spam law (CAN-SPAM, AU Spam Act, UK PECR) and PH Data Privacy Act.

## 5. Deliver
- Save drafts in workspace; optionally `gmail_draft` (draft only).
- Each send → `request_external_action(type: "send_email", spec: {thread_id, to, subject, body, send_after})`.
- Propose the next follow-up date in output; do not change stage until the send executes.
- `submit_output` with criteria_map.
