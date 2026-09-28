# QA checklist: wordpress-fix

Pass = every check is Yes. Grade each with evidence.

1. **Reproduced.** Output shows the bug on live/staging with URL, steps and before evidence. Verify: evidence files.
2. **Root cause specific.** Names the cause with evidence (log line, plugin + version, file:line). Verify: report.
3. **Fixed on staging.** Repro steps on staging no longer show the symptom. Verify: `playwright`.
4. **Live untouched.** No changes made on live; live-apply plan proposed as an external action. Verify: logs + output.
5. **No third-party edits.** Core, parent theme and third-party plugin files unmodified; patches in child theme/mu-plugin/settings. Verify: diff.
6. **Clean logs.** No new PHP notices/errors in `debug.log`; no console errors. Verify: logs.
7. **Regression sweep.** Home, post, page, form, search, cart (if Woo), wp-admin/editor all work. Verify: screenshots.
8. **Performance** (speed tasks or if touched). Lighthouse mobile median of 3 not worse than before; improvement shown for speed tasks. Verify: `lighthouse`.
9. **Rollback defined.** Live plan includes backup and rollback steps. Verify: report.
10. **Compromise handled correctly** (if applicable). Escalated to CEO with evidence; no live cleanup done by agent. Verify: ask_ceo record.
11. **Delivery.** PR on `agent/<task-id>` for code, staging URL, before/after evidence, criteria map. Verify: output.
