# SOP: client-report (COO)

Goal: a correct, client-ready monthly report inside RizeHub, with human commentary, previewed and QA'd before the CEO approves publishing. Playbook: `brain/playbooks/monthly-report.md`.

## 1. Set up
- Read `brain/clients/<slug>/profile.md` (services, goals, KPIs, client time zone, English variant) and `brand.md`.
- `rizehub_readonly`: workspace ID, report type (seo-monthly, site-audit, ads-performance, lead-report), schedule.
- Period = previous calendar month unless the brief says otherwise, e.g. 2026-09-01 to 2026-09-30. Comparison: previous month (MoM) and same month last year (YoY) if data exists.

## 2. Generate
- `rizehub_reports.report_generate(workspace_id, type, period)` → `job_id`; wait for `job.completed`. `report_progress(30, "Report generated")`.
- `GET /reports/{id}` and `GET /workspaces/{id}/metrics?from&to` for both periods.
- Sanity checks before writing: any metric at 0 or changed > ±60% → verify source connection; if broken, `ask_ceo` (do not explain it away).

## 3. Numbers table (internal, attach to output)
```
| Metric | This period | Prev | MoM % | Last year | YoY % |
```
MoM % = (this − prev) ÷ prev × 100, 1 decimal; prev = 0 → "new". Keep units (sessions, clicks, %, position). Avg position: lower is better; say "improved from 14.2 to 11.8".

## 4. Commentary (or hand to SEO/Social writer if the plan says so)
Write via `report_add_notes`, ≤ 350 words, client's English variant:
1. **Summary** (3 sentences): the headline result tied to their goal.
2. **Wins** (3 bullets, each with a number).
3. **Drops & why** (only causes supported by data or logged work, e.g. "Oct 12 core update" only if confirmed; otherwise "we're investigating").
4. **What we did** (from HQ tasks done for this client in the period).
5. **Next month** (3 actions with owners/dates, within their package).
No invented causes, forecasts or guarantees. Brand: "RizeHub".

## 5. Preview and submit
- Open `preview_url`; check client name, logo, period, charts render, PDF link works. `report_progress(80, "Preview checked")`.
- Self-check `brain/qa-checklists/client-report.md`.
- `submit_output`: report ID, preview URL, numbers table, notes text, criteria map.
- After CEO approval: `request_external_action("report_publish", {report_id, notify_client:true})` and a cover email draft (`gmail_draft`, ≤ 120 words, 3 highlights + link + "reply with questions").
