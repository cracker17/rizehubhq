# Playbook: monthly-report (RizeHub client report)

**Trigger:** schedule (per workspace report day, e.g. the 1st, source `schedule`) or "Make the September report for Vinyl Icons".

**Owner of the plan:** COO. **Main agents:** ea (EA & Report Desk), seo-1/seo-2 or social-1/social-2 for commentary. **Work type:** client-report.

## Steps
| # | Owner | Step | Output |
|---|---|---|---|
| 1 | coo | Plan: client, report type (seo-monthly, ads-performance, site-audit, lead-report), period, commentary writer (SEO for SEO reports, Social for social) | Plan (can be auto-approved for scheduled reports) |
| 2 | ea (`client-report`) | `report_generate` for the workspace and previous month; wait for `job.completed`; pull metrics for this and previous period (+ last year if available); sanity-check anomalies (0 values, > ±60% swings → verify source, else `ask_ceo`) | Draft report + numbers table |
| 3 | seo-x / social-x | Read metrics; write Summary, Wins, Drops & why, What we did, Next month; `report_add_notes` (≤ 350 words, client's English variant) | Notes in report |
| 4 | qa-lead | Checks below | Verdict |
| 5 | CEO | Preview link + QA score → approve | ✅ |
| 6 | worker | `report_publish` (client sees it in RizeHub); ea drafts cover email (≤ 120 words, 3 highlights + link) | Published report + draft |
| 7 | CEO | Approve cover email (or per-client setting "auto-send report emails after QA pass") | ✅ |

## Approvals
Plan (unless auto-approved schedule) · publishing · cover email.

## QA focus
Every number in the text matches report data; period exact; MoM/YoY re-computed to 1 decimal with correct direction (avg position lower = better); explanations backed by data or logged work; next-month actions within package; client name/logo right; RizeHub branding only; charts render at 375/1440; links work; report still draft before approval.

## Rules
- No invented causes, forecasts or guarantees ("you will rank #1").
- Late data or broken connection (GA4/GSC) → escalate on day 1, don't publish partial data silently.
- Report due dates are tracked in the morning brief; a missed date turns the client AMBER in the weekly summary.

## Output
Published RizeHub report with human commentary + cover email sent after approval; report ID and QA score logged in HQ.
