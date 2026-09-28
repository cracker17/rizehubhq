# SOP: daily-report (EA & Report Desk)

Two scheduled reports, both Asia/Manila time: **Morning brief 08:00** (what needs attention today) and **CEO digest 18:00** (what happened today). Target: readable in 60 seconds on Telegram.

## 1. Gather (read only)
- HQ: tasks due today/overdue, tasks done today, QA verdicts, failed/blocked agents, approvals waiting (with age), spend today vs daily budget.
- RizeHub (`rizehub_readonly`): new leads, lead stage moves, reports due in next 3 days, new sign-ups/payments.
- `gmail_read`: P1/P2 client threads without a reply; job matches from Job Scout.
- `calendar_read`: today's meetings with times in Manila + client time zone.
- 18:00 digest also collects each active agent's standup (done / next / blocked).

## 2. Morning brief template (≤ 250 words)
```
Morning brief · <Day dd Mon>
Top 3 today: 1) … 2) … 3) …
Meetings: 09:30 PHT (21:30 ET prev day) · <client> · prep: <link>
Approvals waiting: <n> (oldest <h> h) · <top 3 with links>
Due today / overdue: <task · client · owner · status>
Inbox: <n> P1, <n> P2 needing reply
Pipeline: <n> new leads · <n> replies · <n> job matches
Reports due (3 days): <client · date>
Risks: <blocked agent / missing access / budget>
```

## 3. CEO digest template (≤ 300 words)
```
CEO digest · <Day dd Mon>
Done today: <n> tasks · highlights (≤ 5, client + deliverable)
QA: <passed>/<reviewed> first pass · failed: <task + reason>
Pipeline: leads <n> → contacted <n> → replied <n> → proposals <n> → won <n>
Jobs: shortlisted <n> · applied <n>
Spend: $<today> of $<daily budget> (<%>)
Blocked: <agent · why · what unblocks it>
Waiting on you: <approvals, oldest first>
Tomorrow: <top 3>
```

## 4. Rules
- Most urgent first; every item has an owner and a next action.
- Numbers only from data; if a source is unavailable write "no data: <source>".
- Times always with time zone; client meetings show both PHT and client TZ.
- No client-confidential details beyond names and task titles (digest goes to Telegram).
- Omit empty sections rather than writing "none", except "Waiting on you" (write "0").

## 5. Submit
Self-check `brain/qa-checklists/daily-report.md`; `submit_output` with the text. Delivery to Telegram is done by the worker.
