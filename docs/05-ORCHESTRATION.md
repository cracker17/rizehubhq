# 05 · Orchestration — one command to finished work

## Lifecycle

```
 YOU: "/assign Madam Muse bundle landing page + SEO copy + 3 ad graphics, due Fri"
  │
  ▼  (bot/dashboard)                                   request.status
 [1] INTAKE ── insert requests row ─────────────────── staged
  │
  ▼  (worker: COO planner)
 [2] PLAN ── COO reads request + brain/clients + roster ─ planning
  │         writes plan JSON (schema below)
  │         creates approval(kind=plan) ──────────────── plan_review
  ▼  (you: Approve / Edit / Reject in dashboard or Telegram)
 [3] APPROVE PLAN ── tasks inserted (pending) ────────── in_progress
  │                  release_ready_tasks() → queued
  ▼  (worker loop)
 [4] DISPATCH ── claim_next_task() → run specialist agent
  │             agent: working → report_progress… → submit_output
  │             task: qa_pending
  ▼
 [5] QA ── QA agent tests against acceptance_criteria + checklist
  │        pass → approval(kind=deliverable), task awaiting_ceo
  │        fail → task revision (qa_feedback attached) → queued again
  │               after max_revisions → failed + escalate to you
  ▼  (you)
 [6] CEO REVIEW ── approve → task done → release_ready_tasks() (unblocks dependents)
  │               request changes → task revision with your note
  │               approve includes external action? → worker executes it (rizehub.* types only), logs it;
  │                                                     any other type is a MANUAL step: you do it (dashboard says so)
  ▼
 [7] CLOSE ── all tasks done → request done ─────────── done
             COO includes it in the 6pm daily digest
```

## [1] Intake

Both the bot and dashboard insert:
```json
{ "source": "telegram", "raw_text": "Madam Muse bundle landing page …", "priority": "normal" }
```
RizeHub can also create requests: a signed webhook (`client.signed_up`, `payment.received`) received by the worker on its internal port becomes a request with `source='rizehub'` (e.g. "Onboard Brisbane Coffee Co on shopify-growth"). The COO matches every request to a playbook in `brain/playbooks/` (see 13) before planning.

Optional quick syntax (parsed by bot, else COO infers):
`/assign !urgent @madam-muse due:fri <text>`

## [2] COO plan — output schema (validate with zod)

```json
{
  "title": "Madam Muse — Bundle landing page launch",
  "client_slug": "madam-muse",
  "summary": "Build a bundle landing page on the unpublished theme with SEO copy and 3 launch ads.",
  "assumptions": ["Uses existing product bundle app", "Brand fonts from brand.md"],
  "questions_for_ceo": [],
  "due_date": "2026-10-02",
  "priority": "normal",
  "estimated_cost_usd": 4.20,
  "tasks": [
    { "key": "copy",   "agent_id": "writer",      "work_type": "landing-copy",
      "title": "Write bundle landing page copy",
      "instructions": "…", "acceptance_criteria": ["Primary keyword in H1", "≤ 600 words", "3 CTAs to /bundle"],
      "depends_on": [] },
    { "key": "layout", "agent_id": "designer",    "work_type": "wireframe",
      "title": "Wireframe the landing page", "depends_on": ["copy"], "acceptance_criteria": ["…"] },
    { "key": "build",  "agent_id": "web-dev",     "work_type": "shopify-page",
      "title": "Build page on unpublished theme", "depends_on": ["layout"], "acceptance_criteria": ["…"] },
    { "key": "ads",    "agent_id": "designer",    "work_type": "ad-creative",
      "title": "3 launch ad graphics (1:1, 4:5, 9:16)", "depends_on": ["copy"], "acceptance_criteria": ["…"] }
  ]
}
```
The worker converts `key`/`depends_on` keys into task UUIDs on approval.

If `questions_for_ceo` is not empty, the plan approval shows the questions first; your answers are appended to the request and the COO re-plans.

**COO planning rules (put in `agents/coo.md`):**
- Route with `roster.yaml`; use the client's platform to pick the dev.
- Every task gets 3–7 concrete, testable acceptance criteria.
- Split anything over ~2 hours of human work into smaller tasks.
- Parallelize where there's no dependency.
- Never plan an external action without marking it as needing CEO approval.
- If the request is unclear or the client is unknown, ask — don't guess.
- **Design → dev handoff.** When a request needs design (designer: `wireframe`, `ui-mockup`, `brand-asset`, `ux-audit`) and building (`web-dev`), every web-dev task depends on the design task. The planner enforces it after validation (`enforceDesignHandoff` in `apps/worker/src/planner.ts` adds a missing dependency, never a cycle, and notes it in the plan's assumptions).
  - Release: `release_ready_tasks()` queues a pending task only when every dependency is `done`, and a task is `done` only after QA passed it **and** the CEO approved the deliverable. A QA pass alone never releases the developer.
  - Input: the developer's prompt gets the upstream outputs (`apps/worker/src/handoff.ts` `taskHandoffContext` → `upstreamContext`): the designer's `design-spec.md` first (colours, fonts, spacing, layout notes, asset list), then other dependencies' deliverables. The spec and the files listed in the design task's `output.files` are copied into the dev workspace at `upstream/<design-task-id>/` (jail rules, size caps). The Content Writer's prompt gets the samples in `brain/style/writing-samples/` the same way.

## [4] Worker loop (pseudocode)

```ts
// apps/worker/src/index.ts
setInterval(tick, POLL_INTERVAL_MS);
setInterval(() => db.rpc('requeue_stale_tasks'), 60_000);
setInterval(idleActivityShuffler, 90_000);          // see 07
cron('0 18 * * *', runDailyDigest, { tz: 'Asia/Manila' });

async function tick() {
  if (overGlobalBudget()) return pauseAll();
  await planStagedRequests();                        // [2]
  while (running.size < MAX_PARALLEL_TASKS) {
    const { data: task } = await db.rpc('claim_next_task');
    if (!task) break;
    running.add(runTask(task).finally(() => running.delete(task.id)));
  }
  await reviewQaPending();                           // [5]
  await executeApprovedActions();                    // [6]
  await processWebhookEvents();                      // RizeHub webhooks → resume waiting tasks / new requests
}
```

### Running one agent task

```ts
import { generateText, stepCountIs } from 'ai';      // Vercel AI SDK; verify names in current docs
import { pickModel } from './models/router';          // role → model from config/models.yaml (see 14)

async function runTask(task) {
  const role = loadRole(task.agent_id);               // agents/<id>.md front-matter + body
  const ws = await prepareWorkspace(task);            // workspaces/<task-id>/ (+ git clone if needed)
  const heartbeat = setInterval(() => touchHeartbeat(task.id), 30_000);

  const prompt = buildTaskPrompt(task);               // instructions + criteria + qa_feedback + client context paths

  try {
    const { model, provider } = await pickModel(role.model_role, task);   // respects quotas, budget, fallbacks
    await generateText({
      model,
      system: role.body,
      prompt,
      tools: buildTools(role.tools, task, ws),        // only this role's tools: brain, workspace, rizehub_*, hq (report_progress, submit_output, ask_ceo…)
      stopWhen: stepCountIs(role.max_turns),          // max agent steps
      providerOptions: cachingOptions(provider),      // prompt caching where the provider supports it
      onStepFinish: async (step) => {
        await logStep(task, provider, step);          // activity_log + tokens + cost; feeds the POV screen (see 07)
        if (await costExceeded(task, role)) throw new BudgetError();
      },
    });
  } catch (e) {
    if (isQuotaError(e)) return requeueWithFallback(task);   // free-tier limit hit → next provider or tomorrow
    await failTask(task, e);                           // agent → blocked, Telegram alert
  } finally {
    clearInterval(heartbeat);
    await setAgentIdleIfNoWork(task.agent_id);
  }
}
```
`submit_output` (a tool inside `hqToolServer`) writes `tasks.output`, sets `status='qa_pending'`.

### Workspaces & safety
- Each task gets its own folder `workspaces/<task-id>`; agents cannot read outside it except `brain/` (read-only).
- Shell access (`bash_sandboxed`) runs inside the task folder with a command allowlist (git, npm/pnpm, node, shopify CLI, lighthouse). No `rm -rf /`, no `curl | sh`, no reading `.env`.
- Tokens are injected by the tool layer only when a tool call is made — never placed in the prompt or workspace files.

### Per-task caps (built-in runner)
Every run stops at the stricter of the role file (`max_turns`, `budget_usd_per_task`) and the global env caps
`MAX_STEPS_PER_TASK` (default 25) and `MAX_COST_PER_TASK_USD` (default 1.50; priced per step via `models/usage.ts`).
Over a cap the loop stops and the task is failed through `fail_task` with the reason shown to the CEO:
`stopped: exceeded max steps 25` or `stopped: exceeded $1.50 task budget ($1.5123 spent)`.

### Hermes runtime (Web Developer, Graphic Designer, Content Writer, Sales Agent)
Agents with `runtime: hermes` (roster + role file) run on their own Hermes Agent instance (`apps/worker/src/hermes/`,
deploy: `deploy/hermes/README.md`). The worker still claims the task, heartbeats and reports progress:
1. `GET /health` on `HERMES_URL_<AGENT>`, then `POST /v1/chat/completions` (Bearer `HERMES_KEY_<AGENT>`) with the role body
   as system prompt and the same task prompt as above (instructions, criteria, QA/CEO feedback, SOP/checklist/brain paths)
   plus a short "Running on Hermes" note. `X-Hermes-Session-Id` = task id (the transcript continues across revisions),
   `X-Hermes-Session-Key` = agent id (long-term memory per employee).
2. Hermes runs its own tool loop. HQ tools come from the worker's MCP endpoint `POST /mcp` (Streamable HTTP, JSON-RPC:
   initialize, tools/list, tools/call). Bearer `HQ_MCP_TOKEN_<AGENT>` → agent → only that role's tools (`buildTools`).
   Calls act on the agent's current `working` task (resolved server-side from `agents.current_task_id`, or the
   `task_id` argument); gated tools create approvals exactly as in the built-in runner. Each call → activity
   `mcp.tool_call` (tool, ok, ms; never arguments).
3. Output: if Hermes called `submit_output`/`ask_ceo` over MCP, that stands. Otherwise its final answer is parsed (a
   fenced ```json block with the `submit_output` fields, or `{"ask_ceo": …}`; plain text → `fallback: true` output) and
   saved with `submit_task_output`. Usage is recorded as `usage.task` with `detail.runtime = 'hermes'`, priced with the
   Hermes model (`HERMES_MODEL[_<AGENT>]`). The per-task caps above are enforced only on the built-in runner; a Hermes run
   that costs more than the role budget is flagged `over_task_budget` in the usage detail.
4. Fallback (`HERMES_FALLBACK=on`, default): not configured, `/health` failing, or the run failing with down/timeout
   (`HERMES_TIMEOUT_MS`, default 30 min) → the task runs on the built-in runner and activity `hermes.fallback` says
   "Hermes unavailable for <agent>, ran on the built-in runner (<reason>)". `off` → re-queued (failed if not configured).
   401 or a malformed response fails the task (configuration error, no fallback).

Hermes holds no publish/send/platform credentials: vault logins, RizeHub keys and platform tokens stay in the worker
and are only used by HQ tools.

## [5] QA

QA runs as its own agent with **only**: the task instructions, acceptance criteria, the QA checklist for that `work_type`, and the output. It does **not** see the specialist's reasoning.

QA verdict schema:
```json
{
  "verdict": "fail",
  "score": 72,
  "checks": [
    { "criterion": "Primary keyword in H1", "result": "pass", "note": "H1: 'Build Your Bundle…'" },
    { "criterion": "Mobile responsive", "result": "fail", "note": "CTA overflows at 375px",
      "evidence": "qa/screens/mobile-375.png" }
  ],
  "summary": "One layout bug on mobile; copy and links OK.",
  "fix_list": ["Wrap CTA text / reduce padding under 400px"]
}
```
- `pass` requires **every** criterion passing and score ≥ threshold (default 85, per work type in settings).
- On fail: `tasks.qa_feedback = fix_list + failed checks`, `revision_count++`, status → `queued` (same agent).
- `revision_count > max_revisions` → task `failed`, approval created asking you to decide (reassign / accept as-is / cancel).

QA toolkit by work type — see `04-AGENTS.md` and `brain/qa-checklists/`.

## [6] Approvals & external actions

| Approval kind | Created by | What you see | On approve |
|---|---|---|---|
| `plan` | COO | Tasks, owners, order, criteria, cost estimate | Tasks created & queued |
| `deliverable` | QA pass | Output preview, QA report (score, evidence), files | Task done, dependents released |
| `external_action` | Any agent via `request_external_action` / `ask_ceo` | Exactly what will happen (e.g. "Publish theme #123 on madammuse.co") | Worker executes the action, logs result |

Buttons: **Approve · Edit · Request changes · Reject**. "Request changes" requires a note → becomes `qa_feedback`-style input for the agent.

External actions are executed by **fixed worker code**, not by the agent, using the exact `payload` you approved. The agent cannot change the action after approval.

## Scheduled work (no command needed)

| When (Manila) | What | Agent |
|---|---|---|
| Every 90s | Re-roll idle activities | worker |
| Every 1 min | Re-queue stale tasks | worker |
| 08:00 daily | Morning brief: today's queue, due dates, pending approvals | COO |
| 18:00 daily | Standups from each active agent → CEO daily digest | COO |
| Monday 08:00 | Weekly summary: done, costs, QA pass rate, bottlenecks | COO |
| Custom | Recurring requests (e.g. "weekly SEO report for Vinyl Icons") | via `source='schedule'` |
| Every 1 min / 2 min | Sales outreach: send CEO-approved emails under the daily cap (not in `OUTREACH_QUIET_HOURS`, not while paused); read IMAP replies, honour opt-outs | worker (`sales/background.ts`) |
| `OUTREACH_BATCH_HOUR` (17:00) | The day's first-touch + follow-up drafts → ONE batch approval | worker |
| Hourly | Due follow-ups (day 3 / 7 / 14) → one request for the Sales Agent; day 21 → lost (no response) | worker → Sales Agent |

All outreach jobs are off unless `OUTREACH_ENABLED=true`; without SMTP keys, sender address and postal address only the
`settings.outreach_status` row (why sending is off) and, if IMAP is set, reply reading run. Nothing is ever sent without an
approved `external_action` (`sales.email_batch` / `sales.email`).

## Failure handling

| Situation | Behavior |
|---|---|
| Worker crash mid-task | Heartbeat stops → task re-queued after 10 min |
| Tool/API error | Agent retries per its judgment; 3 consecutive tool errors → task failed, agent blocked |
| Budget exceeded | Task failed, alert, agent blocked until you unblock |
| Max steps / max cost per task exceeded | Run stopped, task failed with `stopped: exceeded …` (see "Per-task caps") |
| Hermes down / not configured | Task runs on the built-in runner, activity `hermes.fallback` (or re-queued with `HERMES_FALLBACK=off`) |
| Missing access (no token) | Agent calls `ask_ceo`; status `blocked`; Connections page highlights it |
| QA loop exhausted | Escalation approval to you |
| Anthropic API down | Worker pauses claiming, retries with backoff, Telegram notice |
