# QA checklist: job-search

1. **Allowed sources only**: every post came from an alert email, a public feed, or a pasted link; no logged-in scraping. Verify: source field + tool log.
2. **Live**: spot-check 5 shortlisted posts (all if < 5) load and are open. Verify: `web_fetch`.
3. **Within post-age limit** from job-filters.md. Verify: posted dates.
4. **No duplicates / already applied**: none of the shortlisted URLs are applied/skipped/rejected in `job_tracker`. Verify: job_tracker lookup.
5. **Platform match**: each shortlisted post matches a target role in job-filters.md. Verify: read post.
6. **Score shown with breakdown** and ≥ 70 for shortlist. Verify: read.
7. **Red flags recorded**: known flag types (unpaid test, off-platform pay, Loom, external form, "no AI") are flagged when present. Verify: read post vs record.
8. **Manual items listed** with what the CEO must do. Verify: read.
9. **Tracker updated**: each post has status, fit_score, reasons. Verify: job_tracker.
10. **Nothing submitted or messaged**. Verify: activity log.
