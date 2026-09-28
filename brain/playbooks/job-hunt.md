# Playbook: job-hunt (find jobs + draft applications; CEO applies)

**Trigger:** "Find remote Shopify developer jobs posted this week and draft applications", or a scheduled daily/weekly job scan.

**Owner of the plan:** COO. **Main agent:** sales (Sales Agent). **Work types:** job-search, job-application.

## Steps
| # | Owner | Step | Output |
|---|---|---|---|
| 1 | coo | Plan: roles, platforms (Shopify/Webflow/WordPress/custom), date window, number of drafts (default top 5). Often auto-approved as low risk once enabled | Plan |
| 2 | sales (`job-search`) | Collect listings from allowed sources only: job-alert emails in Gmail (OnlineJobs.ph, Indeed, LinkedIn, Upwork alerts), public RSS/APIs of remote boards, links the CEO pastes. Never log in to job sites | Raw listings |
| 3 | sales (`job-search`) | Screen each against `brain/career/job-filters.md` (role, rate, hours, time zone, platform, red flags: unpaid test project, recruiter posing as client, requests for ID/payment, off-platform payment) → score 0–100, dedupe, track in `job_tracker` | Scored shortlist |
| 4 | sales (`job-application`) | For top matches: tailored draft (hook on their exact problem, 3–5 portfolio links for that platform from `brain/career/portfolio.md`, correct resume link, every screening question answered), style from `brain/career/application-style.md` | Drafts |
| 5 | qa-lead | Checks below | Verdict |
| 6 | CEO | Review shortlist: score, why it fits, draft | ✅ |
| 7 | CEO | Opens the job link, pastes, submits (manual) | Applied |
| 8 | sales | CEO marks "Applied" → tracked in `job_opportunities`; follow-up draft after 5 days (approval needed) | Follow-up |

## Approvals
Shortlist + drafts; any follow-up message. The CEO submits every application personally.

## QA focus
Every screening question answered; portfolio links match the job's platform and return 200; word count fits the site (e.g. 200–250 for OnlineJobs.ph); no invented experience, clients, years or results beyond `brain/career/`; red-flag jobs excluded; job still open (link works).

## Rules
- No automated applications, logins or scraping behind logins (platform ToS; protects the CEO's accounts).
- Personal name and contact details are allowed here only from `brain/career/` (this is the CEO's own job hunt, not client-facing RizeHub work).
- Never share ID documents or payment details with a job poster.

## Output
Shortlist table (job, company, platform, rate, score, fit reasons, link) + one application draft per top match.
