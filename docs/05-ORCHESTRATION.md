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
  - Input: the developer's prompt gets the upstream outputs (`apps/worker/src/handoff.ts` `taskHandoffContext` → `upstreamContext`): the designer's `design-spec.md` first (colours, fonts, spacing, layout notes, asset list), then other dependencies' deliverables. The spec and the files listed in the design task's `output.files` are copied into the dev workspace at `upstream/<design-task-id>/` (jail rules, size caps). The Content Writer's prompt gets the samples in `brain/style/writing-samples/` the same way. Both runtimes use it: `buildRunPrompt` in `apps/worker/src/runner.ts` = `buildTaskPrompt` + `taskHandoffContext` (built-in runner and Hermes; on Hermes the prompt adds that the copied files are opened with the HQ `workspace_fs` tool, because they live in the worker's task workspace). A task without dependencies gets exactly `buildTaskPrompt`.

## [3] Plan approval · auto-approve rules (M12)

By default every plan waits for the CEO. The CEO can add **auto-approve rules** (Settings → Auto-approve rules; table
`plan_auto_approve_rules`, migration `20260929000000_totp_auto_approve.sql`). They are applied **server-side by
`submit_plan()` itself** (the SQL function that owns plan approval), in the same transaction the COO submits the plan:

1. `auto_approve_plan(approval)` runs only for a *pending* approval of kind **`plan`**. With no enabled rule nothing happens.
2. **Hard guards** (`plan_auto_approve_blocker`), which no rule can override; any hit → the plan waits for the CEO and
   activity `plan.auto_approve_skipped` records why:
   - every task's `work_type` is **internal-only** work (`auto_approve_internal_work_types()`: writer drafts, designer
     wireframes/mockups/ads/brand assets, lead reports/qualification, DM reply drafts, job search/application drafts,
     COO summaries/reports/inbox/meeting prep). Never: any Web Developer work, `client-report`, `client-onboarding`,
     `workspace-setup`, `access-checklist`, `lead-finder-search`, `outreach-draft`, `follow-up-email`, `proposal`;
   - no `questions_for_ceo`, and `estimated_cost_usd` is present;
   - no outside-world wording in the plan title/summary or any task title/instructions/criteria (whole words:
     publish, deploy, merge, send/sent, go live, spend, buy, pay, payment, invoice, refund, delete, "email … to",
     "post … on/to"; `auto_approve_external_wording()`).
3. Rules, oldest first; the first that covers the plan wins: `estimated_cost_usd ≤ max_cost_usd`, task count
   ≤ `max_tasks` (optional), every work type in `work_types` (empty = any internal type), client scope `none`
   (request without a client) / `any` / `listed` (`client_slugs`).
4. On a match: `payload.auto_approved = {rule_id, rule_name, max_cost_usd, at}`, then `decide_approval(…, 'approve', 'Auto-approved by rule "<name>"', 'auto')`
   (tasks created and queued exactly like a CEO approval; `decided_via = 'auto'`, logged with actor `system`) and
   activity `plan.auto_approved` with the rule. The dashboard's approval history and Telegram show "Auto-approved by rule …".

**Never auto-approved:** anything that is not a plan. External actions (publish/send/merge/deploy/spend) created
while an auto-approved plan runs are ordinary `external_action` approvals and always wait for the CEO;
`decide_approval(…, 'auto')` refuses every approval except the plan `auto_approve_plan()` is deciding. Sales emails
(first touches, follow-ups, replies, proposals) are never auto-approved either (migration `20260929010000`).

Editing rules: `save_auto_approve_rule(jsonb)` / `delete_auto_approve_rule(uuid)` (validated, logged as
`auto_approve.rule_saved` / `auto_approve.rule_deleted`); turning a rule on needs a fresh 2FA step-up once 2FA is set
up (docs/09). The shared mirror `packages/shared/src/autoApprove.ts` (`evaluateAutoApprove`) is used by the dashboard
form and tests; the db tests check its constants match the SQL.

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
   as system prompt and the same task prompt as above (instructions, criteria, QA/CEO feedback, SOP/checklist/brain paths,
   upstream design spec + assets via `buildRunPrompt`)
   plus a short "Running on Hermes" note. `X-Hermes-Session-Id` = task id (the transcript continues across revisions),
   `X-Hermes-Session-Key` = agent id (long-term memory per employee).
2. Hermes runs its own tool loop. HQ tools come from the worker's MCP endpoint `POST /mcp` (Streamable HTTP, JSON-RPC:
   initialize, tools/list, tools/call). Bearer `HQ_MCP_TOKEN_<AGENT>` → agent → only that role's tools (`buildTools`) plus
   the connected MCP apps granted to that agent (`loadMcpTools`, docs/15; "Ask me" tools still queue an `mcp.call` approval).
   Calls act on the agent's current `working` task (resolved server-side from `agents.current_task_id`, or the
   `task_id` argument); gated tools create approvals exactly as in the built-in runner. Each call → activity
   `mcp.tool_call` (tool, ok, ms, run_id; never arguments). Every call must also carry the attempt's `run_id` (see
   "Run lease" below); refused calls execute nothing and log `mcp.tool_refused`.
3. Output: if Hermes called `submit_output`/`ask_ceo` over MCP, that stands. Otherwise its final answer is parsed (a
   fenced ```json block with the `submit_output` fields, or `{"ask_ceo": …}`; plain text → `fallback: true` output) and
   saved with `submit_task_output`. Usage is recorded as `usage.task` with `detail.runtime = 'hermes'`, priced with the
   Hermes model (`HERMES_MODEL[_<AGENT>]`). The per-task caps above are enforced only on the built-in runner; a Hermes run
   that costs more than the effective task budget (stricter of the role budget and `MAX_COST_PER_TASK_USD`) is flagged
   `over_task_budget` in the usage detail. At startup the worker logs which `runtime: hermes` agents run on Hermes and warns
   about half-configured ones (URL without key, missing/short `HQ_MCP_TOKEN_<AGENT>`, no `HERMES_MODEL`).
4. Fallback (`HERMES_FALLBACK=on`, default): not configured, `/health` failing, or the run failing with down/timeout
   (`HERMES_TIMEOUT_MS`, default 30 min) → the task runs on the built-in runner and activity `hermes.fallback` says
   "Hermes unavailable for <agent>, ran on the built-in runner (<reason>)". `off` → re-queued (failed if not configured).
   401 or a malformed response fails the task (configuration error, no fallback).
5. Run lease (`apps/worker/src/hermes/mcpState.ts`): each Hermes attempt gets a run id, sent in the prompt ("Pass
   task_id … and run_id …"); HQ MCP calls are accepted only for the task's active run of that agent. When the chat call
   returns, times out or fails, the worker first cancels its request (best effort: Hermes' non-streaming
   `/v1/chat/completions` returns no run id, so `POST /v1/runs/{id}/stop` cannot reach it and the container may keep
   working), then revokes the lease and waits up to 30 s for calls already executing under it, then re-reads the task,
   and only then starts the built-in runner. Late calls from the old run get "HQ ended this Hermes run (<reason>) … stop
   working on this task" and change nothing, so they cannot double a submit, CEO question or approval. If a call is
   still executing after the drain window the task is re-queued instead of falling back. Leases live in worker memory
   (no DB column): `/mcp` is served by the same process that runs the task, and a worker restart drops every lease,
   which refuses stale calls rather than accepting them.

Hermes holds no publish/send/platform credentials: vault logins, RizeHub keys and platform tokens stay in the worker
and are only used by HQ tools.

### Claude runtime (Claude Agent SDK; opt-in, no agent uses it by default)
Agents with `runtime: claude` (role file + roster) run on the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`,
`apps/worker/src/claude/`) inside the worker: `query()` spawns the bundled Claude Code binary for one task. The worker
still claims the task, heartbeats and reports progress.
1. **When**: only if `CLAUDE_RUNTIME_ENABLED=true`, `ANTHROPIC_API_KEY` is set (Console API key; the Agent SDK must not use
   a claude.ai login), `MONTHLY_BUDGET_USD > 0` with at least $0.05 left this month and today (daily AI budget), and an
   Anthropic model resolves (docs/14 "Claude runtime"). Otherwise the task runs on the built-in runner and activity
   `claude.fallback` says "Claude unavailable for <agent>, ran on the built-in runner (<reason>)".
2. **SDK options**: system prompt = the role file body; prompt = `buildRunPrompt` (same as the other runtimes) + a short
   "Running on Claude" note; `cwd` = the task workspace `WORKSPACES_DIR/<task-id>` (never the repo); `permissionMode:
   'dontAsk'` + an explicit `allowedTools` list (never `bypassPermissions`) and `permissionPrompts: 'none'`;
   `settingSources: []`, `strictMcpConfig`, `persistSession: false` (no user/project settings, CLAUDE.md, skills or other
   MCP servers are loaded); `maxTurns` = the stricter of `max_turns` / `MAX_STEPS_PER_TASK`; `maxBudgetUsd` = the stricter
   of the task budget and what is left of the monthly and daily budgets. The Claude Code process gets a replaced env: only
   PATH/locale/proxy basics, a throwaway HOME / `CLAUDE_CONFIG_DIR` (deleted after the run) and `ANTHROPIC_API_KEY`; no
   other worker secret. It runs as the worker uid (not the agent uid, which could otherwise read its API key).
3. **Tools**: HQ tools come only from the worker's own `/mcp` endpoint (`mcpServers.hq`, http, `CLAUDE_HQ_MCP_URL`, default
   `http://127.0.0.1:<WORKER_HTTP_PORT>/mcp`) with a random per-run bearer token bound to the run lease
   (`hermes/mcpState.ts issueRunToken`): the token names agent, task and run, so no `task_id`/`run_id` is passed and it is
   worthless once the run ends. That endpoint serves exactly the agent's `buildTools` + connected MCP apps, so
   `submit_output`, `ask_ceo`, `request_external_action`, `gmail_*`, `bash_sandboxed` and app tools keep every approval gate.
   `allowedTools` = those `mcp__hq__<tool>` names. Claude Code's Bash, BashOutput, KillShell, WebFetch, WebSearch,
   Task/Agent, NotebookEdit and Skill are always disallowed: HQ's `bash_sandboxed` (agent uid, allowlist) is the only shell.
   Files: `CLAUDE_FILE_TOOLS=hq` (default) = no Claude Code built-ins, files through HQ `workspace_fs` (race-safe jail);
   `native` = Claude Code's Read/Edit/Write/Glob/Grep for roles with `workspace_fs`, each call checked by a PreToolUse hook
   (`claude/guard.ts`: inside the workspace, no `..`, no symlink out, no secret-looking files, no `.git` writes, Grep refuses
   folders holding secret files); written files are chowned to the agent uid. Caveat: those tools open files as the worker
   uid after the check, so unlike `dev/safefs.ts` they are not race-safe against a symlink swapped in by an agent-uid process
   between check and open; keep `hq` unless the task needs Claude Code's editing tools. A PreToolUse hook also denies any
   tool not on the allowed list (a hook deny is final).
4. **Output**: `submit_output` / `ask_ceo` over MCP stand; otherwise the final `result` text is parsed like a Hermes
   answer (fenced json → output or `ask_ceo`; plain text → `fallback: true` output). `error_max_turns` / `error_max_budget_usd`
   fail the task with the built-in runner's reasons (no fallback). Usage → `usage.task` with `detail.runtime = 'claude'`,
   priced with `PRICES` from the SDK's per-model token totals, and added to the picker's month/day spend.
5. **Fallback + lease** (same model as Hermes): SDK error, API error result, `error_during_execution` or timeout
   (`CLAUDE_TIMEOUT_MS`, default 30 min; the SDK's AbortController kills Claude Code) → the lease is revoked first (waiting up
   to 30 s for HQ calls still running), the Claude Code process is closed, the task is re-read (a submit/ask over MCP
   stands), then the built-in runner takes over (`claude.fallback`), or the task is re-queued if a call was still running.
   Worker shutdown → re-queued. No SDK message is read after that, and late MCP calls get "HQ ended this Claude run".
   Errors, stderr and reasons are redacted of the API key and run token before they are logged or stored.

**Turning it on for one agent** (e.g. web-dev), once the CEO has an Anthropic Console API key and a budget:
1. `.env.worker`: `ANTHROPIC_API_KEY=…`, `MONTHLY_BUDGET_USD=<cap>` (and `DAILY_AI_BUDGET_USD`), `CLAUDE_RUNTIME_ENABLED=true`;
   optionally `CLAUDE_MODEL_WEB_DEV=claude-sonnet-5`.
2. `agents/web-dev.md` front-matter `runtime: claude`, and `agents/roster.yaml` `web-dev: { …, runtime: claude }` (they
   must match: `pnpm check:roles`); optionally raise `budget_usd_per_task` and `MAX_COST_PER_TASK_USD` / `MAX_STEPS_PER_TASK`.
3. Dashboard label: `update agents set runtime = 'claude' where id = 'web-dev';` (migration `20260929070000_claude_runtime.sql`
   allows the value).
4. Restart the worker; its startup log says `runtime:claude agents on Claude: web-dev`. Undo: set `runtime` back (or
   `CLAUDE_RUNTIME_ENABLED=false`, which sends every `runtime: claude` agent to the built-in runner).

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

Approving a **high-risk** `external_action` (an outside-world proposal, `payload.type = 'external_action'`) needs a fresh
TOTP code once the CEO has 2FA; Telegram can then only reject/request changes on those (docs/09 "Two-factor (TOTP)").

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
