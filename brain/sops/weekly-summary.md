# SOP: weekly-summary (COO, Monday 08:00 Asia/Manila)

Goal: a one-screen, honest operating report for the CEO covering the previous Monday 00:00 to Sunday 23:59 (Asia/Manila).

## 1. Gather (read only)
- HQ data (via `rizehub_readonly` / provided context): requests opened/closed, tasks done, revisions, QA verdicts and scores, approvals waiting and their age, spend by agent and workflow, failed/blocked tasks.
- Pipeline: leads found, researched, contacted, replied, proposals sent, won/lost (RizeHub lead stages).
- Client health per active client: last report date vs schedule, missing access (checklist items open), overdue tasks, days since last client touch.
- Jobs: shortlisted, applied (CEO-marked), follow-ups due.

## 2. Compute (show formulas in your head, not in the report)
- QA first-pass rate = tasks passed on first QA ÷ tasks QA'd.
- Avg revisions = total revisions ÷ tasks done.
- Cycle time = median(done_at − created_at) in hours.
- Cost per workflow = spend ÷ requests done, per playbook.
- Week-over-week change for each: (this − last) ÷ last × 100, 1 decimal. If last = 0, write "new".

## 3. Write (≤ 400 words, this structure)
```
Week <dd Mon> – <dd Mon yyyy>

Headline: <one sentence: the most important thing>

Done: <n> requests, <n> tasks. Highlights: <3 bullets, client + deliverable>
Quality: QA first-pass <x%> (<±y> pts WoW), avg revisions <n>, failed tasks <n>
Cost: $<total> (<±%> WoW); top 3 agents by spend; cost per workflow
Pipeline: leads <n> → contacted <n> → replied <n> → proposals <n> → won <n>
Client health: GREEN/AMBER/RED per client with the one reason
Bottlenecks: <top 3, each with cause and proposed fix + owner>
Waiting on you: <approvals > 24 h, oldest first, with link>
Next week: <3 priorities>
```

## 4. Rules
- Every number comes from data; if a source is missing write "no data (reason)", never estimate silently.
- Name agents by role, not model. Recommend, don't execute: changes to roster, budgets or agents are proposals for the CEO.
- Bad news first when it matters (late client report, blocked agent, budget spike > 30%).

## 5. Submit
Self-check `brain/qa-checklists/weekly-summary.md`, then `submit_output` with the summary text and the data sources used.
