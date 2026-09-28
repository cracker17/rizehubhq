# brain/sales — the only facts the Sales Agent may use about RizeHub

The Sales Agent writes outreach, replies and proposals from **these files only** (plus the lead's own verified research).
If a fact, price, result, client name or case study is not written here, the agent does not say it: it calls
`ask_ceo` instead. QA checks every claim against these files.

| File | What it holds | Who edits |
|---|---|---|
| `services.md` | What RizeHub does (and does not do) | Julev |
| `packages.md` | Packages with scope, timeline and **price ranges**. Rows marked `EDIT ME — Julev to confirm` are placeholders: the agent may describe the scope but must never quote a price from them | Julev |
| `portfolio.md` | Public portfolio links and what each shows | Julev |
| `case-studies.md` | Results the agent may cite (only with client permission) | Julev |
| `ideal-client-profile.md` | Who we target, who we don't | Julev |

## Rules the tools enforce (apps/worker/src/tools/sales.ts)
- `draft_proposal` refuses any price that is not copied exactly from a `packages.md` row, and refuses every price while that row still says `EDIT ME`.
- `draft_proposal` refuses results / case-study language while `case-studies.md` has no confirmed entry.
- Any draft that mentions prices, discounts, contract terms or dates / deliverable commitments is **flagged** and needs Julev's explicit per-email approval (never "approve all", never auto-approve).
- Outreach is signed **Julev Ajeto, RizeHub** (the sender block, postal address and opt-out line are added automatically; do not write them).
- Leads come from public business sources only. Never LinkedIn scraping, never bought or scraped lists, never personal data.
- If someone asks whether they are talking to a person or a bot, the reply says plainly that the Sales Agent is RizeHub's AI assistant drafting for Julev, who reviews and sends every email.

`brain/company/pricing.md` stays the internal price book for client work; when a price there is filled in and confirmed, copy the same number into `packages.md` so both agree.
