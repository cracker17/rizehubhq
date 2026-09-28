# QA checklist: ux-audit
Pass = every check true.

1. **Scope covered**: every page/flow in the brief has findings or an explicit "no issues". Verify: compare brief to report.
2. **Evidence per finding**: each finding cites a screenshot file that exists and shows the issue. Verify: open 5 random screenshots.
3. **Severity 0–4 with rationale** on every finding, consistent with SOP definitions. Verify: read table.
4. **Concrete fix + effort (S/M/L)** on every finding; no "improve UX". Verify: read.
5. **Heuristic/pattern named** per finding. Verify: read.
6. **Sorted** by severity, then effort. Verify: table order.
7. **Mobile and desktop** both evaluated (375 + 1440 screenshots). Verify: files.
8. **Metrics real**: Lighthouse/PageSpeed numbers match attached JSON, with date and device. Verify: compare.
9. **No invented numbers**: no made-up conversion uplift %, benchmarks without source. Verify: search for % and check source.
10. **Accessibility spot checks** included (contrast, focus, labels, targets). Verify: section present.
11. **Findings reproducible**: QA re-checks 3 findings on the live site with `playwright`. Verify: re-run.
12. **Logged-in areas** accessed only via vault tools; no passwords visible in screenshots or text. Verify: `credential_access_log` + screenshots.
13. **RizeHub branding**, no personal names/emails; client name correct. Verify: read.
14. **criteria_map** complete.
