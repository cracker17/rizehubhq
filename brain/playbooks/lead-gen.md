# Playbook: lead-gen (find leads + draft outreach)

**Trigger:** CEO request like "Find 30 Shopify stores in Australia with slow sites and draft outreach", or a scheduled prospecting request.

**Owner of the plan:** COO. **Main agent:** sales (Sales Agent). **Work types:** lead-finder-search, lead-report, outreach-draft, follow-up-email.

## Steps
| # | Owner | Step | Output |
|---|---|---|---|
| 1 | coo | Plan: industry, location, platform, signal (slow site, no SSL, hiring), lead count, list name, channel (email or DM) | Plan for approval |
| 2 | CEO | Approve plan | ✅ |
| 3 | sales (`lead-finder-search`) | `leads_search` in RizeHub Lead Finder, wait for `job.completed` | Raw lead IDs |
| 4 | sales (`lead-report`) | Per lead: visit site (`web_fetch`), confirm the signal with a real measurement (`pagespeed` mobile score), check fit (platform, size, market), `lead_add_notes` with fit score 0–100 and recommended angle; drop fits < 60 | Lead report table |
| 5 | sales (`outreach-draft`) | Save top leads to a RizeHub list; draft one personalized first message per lead using one verified finding from their site | Drafts |
| 6 | qa-lead | Checks below | Verdict |
| 7 | CEO | One approval: lead report + drafts (approve all / edit / drop) | ✅ |
| 8 | CEO / worker | CEO sends DMs personally; approved emails sent by worker from the warmed RizeHub sending domain, volume-capped | Sent |
| 9 | sales (`follow-up-email`) | Stage → "contacted" (only after send); day-3 and day-7 follow-up drafts, each needs approval | Follow-ups |

## Approvals
Plan · lead report + drafts · every send · every follow-up. No agent sends anything.

## QA focus
Every claim in each message matches the lead's live site; names and URLs correct; PageSpeed numbers re-measured; no fake stats or case results; tone per `brain/company/brand-voice.md`; each email has sender identity, RizeHub address and one-click opt-out; no lead on the suppression list.

## Rules
- Business contact info only; no personal data scraping.
- Anti-spam law of the lead's country (CAN-SPAM, AU Spam Act, UK PECR) + PH Data Privacy Act; honor opt-outs permanently.
- Max 30–50 cold emails/day per warmed domain; never from the main domain. DMs are always sent by the CEO (no automated DMs).

## Output
Lead report (company, site, platform, signal found, fit score, recommended angle) + message drafts, in one approval.
