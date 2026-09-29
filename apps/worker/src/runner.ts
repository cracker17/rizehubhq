// Specialist task runner (docs/05 [4]): one claimed task → generateText agent loop with the role's
// tools → submit_output / ask_ceo. Heartbeat, usage + cost logging, budget guard, quota requeue.
import { generateText, stepCountIs, tool, type StopCondition, type ToolSet } from 'ai';
import { closeRunSessions } from './vault/browser';
import { TOOL_FACTORIES } from './tools';
import { z } from 'zod';
import type { ClientRow, TaskOutput, TaskRow } from './hqdb';
import type { Role } from './roles';
import { errMsg, log, usageDetail, type WorkerDeps } from './deps';
import { addUsage, isQuotaError, normalizeUsage, type PickedModel, type TokenUsage } from './models/usage';
import { cachedPrompt, withRollingCache } from './models/cache';
import { WORKER_EXECUTED_ACTIONS } from './rizehub/background';
import { loadMcpTools, mcpToolEnv } from './tools/mcp';
import { config } from './config';
import { runHermesTask, type HermesRunOptions } from './hermes/runner';
import { taskHandoffContext, type UpstreamOptions } from './handoff';

/** Where not-yet-built tools arrive (docs/11-ROADMAP.md). */
export const TOOL_MILESTONES: Record<string, string> = {
  // All role-file tools are implemented (tools/*). Planning and QA verdicts run outside task runs.
  create_plan: 'M5 (planning runs in the COO planner, not in tasks)',
  qa_submit_verdict: 'M6 (QA verdicts are recorded by the QA reviewer, not in tasks)',
};

export const BUILTIN_TOOLS = ['report_progress', 'submit_output', 'ask_ceo', 'brain_read', 'brain_search', 'request_external_action'] as const;

export class BudgetExceededError extends Error {}

/**
 * Payload spec for an agent-proposed external action. Types without a worker executor are marked
 * executor: 'manual' so the dashboard/bot show "you do this after approving" instead of implying automation.
 */
/** Questions one task may send the CEO (ask_ceo) before it must finish with what it has. */
export const MAX_QUESTIONS_PER_TASK = 3;

/**
 * The CEO tapped a button on your question without writing an answer. Buttons carry no data, so say exactly what the
 * decision means; otherwise the agent re-asks the same question (the 2026-09-29 calendar loop).
 */
export function ceoDecisionWithoutNote(decision: string): string {
  const base = 'The CEO answered your question with a button and no text, so no new information was given. Do NOT ask the same '
    + 'question again (not in other words either). ';
  if (decision === 'reject') return `CEO declined your question. ${base}Finish with what you have: submit_output and state plainly what is missing.`;
  return `CEO approved (${decision}) without writing an answer. ${base}If your question asked permission, go ahead. If it asked for `
    + 'information or data, you do not have it: finish with submit_output, state what is missing and how the CEO can connect it.';
}

/** request_external_action's spec as text: strings as given, objects/arrays as readable JSON (capped at 4000 chars). */
export function specText(spec: unknown): string {
  const s = typeof spec === 'string' ? spec : JSON.stringify(spec, null, 2) ?? '';
  return s.length > 4000 ? `${s.slice(0, 3997)}...` : s;
}

export function externalActionSpec(type: string, spec: string): Record<string, unknown> {
  return WORKER_EXECUTED_ACTIONS.has(type) ? { description: spec, executor: 'worker' } : { description: spec, executor: 'manual' };
}

export type RunResult =
  | { status: 'submitted'; costUsd: number; fallback: boolean }
  | { status: 'asked_ceo'; costUsd: number }
  | { status: 'failed'; reason: string; costUsd: number }
  | { status: 'budget_exceeded'; costUsd: number }
  | { status: 'requeued'; reason: string; costUsd: number };

export interface RunState { ended: null | 'submitted' | 'asked'; costUsd: number; overBudget: boolean; toolErrors: number }

/** Global per-task caps (MAX_STEPS_PER_TASK / MAX_COST_PER_TASK_USD). */
export interface TaskLimits { maxSteps: number; maxCostUsd: number }

/** Effective caps for one run: the stricter of the role file (max_turns / budget_usd_per_task) and the global env caps. */
export function taskLimits(role: Pick<Role, 'max_turns' | 'budget_usd_per_task'>, global: TaskLimits = { maxSteps: config.maxStepsPerTask, maxCostUsd: config.maxCostPerTaskUsd }): TaskLimits {
  return { maxSteps: Math.max(1, Math.min(role.max_turns, global.maxSteps)), maxCostUsd: Math.min(role.budget_usd_per_task, global.maxCostUsd) };
}

/** Failure reasons for the per-task limits (see taskLimits). Shown on the task and to the CEO. */
export const maxStepsReason = (maxTurns: number) => `stopped: exceeded max steps ${maxTurns}`;
export const taskBudgetReason = (budgetUsd: number, spentUsd: number) =>
  `stopped: exceeded $${budgetUsd.toFixed(2)} task budget ($${spentUsd.toFixed(4)} spent)`;

export function stubMessage(name: string): string {
  const m = TOOL_MILESTONES[name] ?? 'a later milestone';
  return `Tool "${name}" is not connected yet (milestone ${m}). Continue without it: use the brief and brain_read/brain_search, `
    + 'mark anything you could not verify as [PLACEHOLDER: ...] in your output, or ask_ceo if it blocks the task.';
}

function bulletList(items: unknown[]): string {
  return items.map((c, i) => `${i + 1}. ${typeof c === 'string' ? c : JSON.stringify(c)}`).join('\n');
}

/** Task prompt: instructions + acceptance criteria + QA/CEO feedback on revisions + client context paths. */
export function buildTaskPrompt(task: TaskRow, client: ClientRow | null, deps: Pick<WorkerDeps, 'brain'>): string {
  const parts: string[] = [
    `# Task: ${task.title}`,
    `Task id: ${task.id} · work_type: ${task.work_type}${task.revision_count ? ` · revision ${task.revision_count}` : ''}`,
    `## Instructions\n${task.instructions}`,
    `## Acceptance criteria (QA checks each one verbatim)\n${bulletList(task.acceptance_criteria)}`,
  ];
  const fb = task.qa_feedback as Record<string, unknown> | null;
  if (fb) {
    const lines: string[] = [];
    if (Array.isArray(fb.fix_list) && fb.fix_list.length) lines.push(`Fix list (${fb.source === 'ceo' ? 'from the CEO' : 'from QA'}):\n${bulletList(fb.fix_list)}`);
    if (Array.isArray(fb.failed_checks) && fb.failed_checks.length) {
      lines.push(`Failed checks:\n${(fb.failed_checks as { criterion?: string; note?: string }[]).map((c) => `- ${c.criterion ?? '?'}: ${c.note ?? ''}`).join('\n')}`);
    }
    if (fb.ceo_note) lines.push(`CEO ${fb.ceo_decision ?? 'answer'}: ${String(fb.ceo_note)}`);
    else if (fb.ceo_decision) lines.push(ceoDecisionWithoutNote(String(fb.ceo_decision)));
    if (lines.length) parts.push(`## Feedback on your previous attempt (fix every item)\n${lines.join('\n\n')}`);
    if (task.output) parts.push(`## Your previous output\n${JSON.stringify(task.output).slice(0, 8000)}`);
  }
  const ctx: string[] = [];
  if (client) {
    ctx.push(`Client: ${client.name} (slug ${client.slug}) · platforms: ${client.platforms.join(', ') || 'unknown'}${client.website ? ` · ${client.website}` : ''}`);
    for (const f of ['profile.md', 'brand.md']) {
      const p = `brain/clients/${client.slug}/${f}`;
      if (deps.brain.exists(p)) ctx.push(`- ${p}`);
    }
  }
  for (const p of [`brain/sops/${task.work_type}.md`, `brain/qa-checklists/_general.md`, `brain/qa-checklists/${task.work_type}.md`, 'brain/company/brand-voice.md']) {
    if (deps.brain.exists(p)) ctx.push(`- ${p}`);
  }
  if (ctx.length) parts.push(`## Context files (read with brain_read)\n${ctx.join('\n')}`);
  parts.push('## Finish\nCall report_progress at milestones. When done, call submit_output with the full deliverable in `content` '
    + 'and a criteria_map entry for every acceptance criterion. If something blocking is missing, call ask_ceo. '
    + 'Anything that publishes, sends, merges, deploys or spends goes through request_external_action.');
  return parts.join('\n\n');
}

/**
 * The full task prompt both runtimes send: buildTaskPrompt() plus the handoff context (handoff.ts): the approved
 * outputs of the tasks this one depends on (the Graphic Designer's design spec + asset links/files first, copied into
 * the task workspace under upstream/<id>/) and the role's extra brain context. A task without dependencies (and a
 * role without extra brain context) gets exactly buildTaskPrompt(). Never throws on handoff problems.
 */
export async function buildRunPrompt(
  task: TaskRow, client: ClientRow | null, deps: Pick<WorkerDeps, 'brain' | 'db'>, opts: UpstreamOptions = {},
): Promise<string> {
  return buildTaskPrompt(task, client, deps) + await taskHandoffContext({ db: deps.db, brain: deps.brain }, task, opts);
}

export interface ToolContext { task: TaskRow; role: Role; deps: WorkerDeps; state: RunState }

/** Builds exactly the role's tools: built-ins are real, everything else is a graceful stub. */
export function buildTools(ctx: ToolContext): ToolSet {
  const { task, deps, state } = ctx;
  const db = deps.db;
  const all: ToolSet = {
    report_progress: tool({
      description: 'Report progress on this task. Updates your status and the screen the CEO sees in the office.',
      inputSchema: z.object({
        percent: z.number().min(0).max(100).describe('0-100'),
        note: z.string().describe('One line: what you are doing now'),
        app: z.enum(['editor', 'browser', 'doc', 'sheet', 'leads', 'inbox', 'review', 'whiteboard']).optional()
          .describe('What your screen should look like'),
        title: z.string().optional().describe('Screen title, e.g. a file name'),
        content: z.string().optional().describe('Latest snippet of your work (draft text or code)'),
      }),
      execute: async ({ percent, note, app, title, content }) => {
        await db.reportProgress(task.id, percent, note, { app: app ?? 'doc', title, content: content?.slice(0, 4000) });
        return 'Progress saved.';
      },
    }),
    submit_output: tool({
      description: 'Submit the finished deliverable to QA. Ends your turn on this task.',
      inputSchema: z.object({
        summary: z.string().describe('2-4 sentence summary of what you delivered'),
        content: z.string().optional().describe('The deliverable itself (article, copy, brief, code…) in markdown'),
        files: z.array(z.string()).optional().describe('Files you produced (paths)'),
        links: z.array(z.string()).optional().describe('Relevant links (sources, drafts, previews)'),
        preview_url: z.string().optional(),
        criteria_map: z.array(z.object({ criterion: z.string(), how_met: z.string() })).optional()
          .describe('One entry per acceptance criterion: how and where it is met'),
      }),
      execute: async (input) => {
        if (state.ended) return 'Already submitted; stop now.';
        const output: TaskOutput = {
          summary: input.summary, content: input.content, files: input.files ?? [], links: input.links ?? [],
          preview_url: input.preview_url ?? null,
          criteria_map: Object.fromEntries((input.criteria_map ?? []).map((c) => [c.criterion, c.how_met])),
        };
        await db.submitTaskOutput(task.id, output);
        state.ended = 'submitted';
        return 'Submitted to QA. Your work on this task is done; stop now.';
      },
    }),
    ask_ceo: tool({
      description: 'Ask the CEO a blocking question. Pauses this task until the CEO answers.',
      inputSchema: z.object({ question: z.string(), options: z.array(z.string()).optional() }),
      execute: async ({ question, options }) => {
        if (state.ended) return 'Task already ended; stop now.';
        // A task that keeps asking floods the CEO's Telegram (2026-09-29: 13 near-identical calendar questions).
        const asked = await db.countTaskQuestions(task.id).catch(() => 0);
        if (asked >= MAX_QUESTIONS_PER_TASK) {
          return `Not sent: this task already asked the CEO ${asked} questions. Do not ask again. Finish now with submit_output: `
            + 'deliver what you can and state plainly what is missing and why (e.g. a tool or account that is not connected).';
        }
        const id = await db.askCeo(task.id, question, options ?? []);
        state.ended = 'asked';
        return `Question sent to the CEO (approval ${id}). The task is paused; stop now.`;
      },
    }),
    brain_read: tool({
      description: 'Read a markdown file from brain/ (company, client, SOP, playbook, QA checklist files).',
      inputSchema: z.object({ path: z.string().describe('e.g. brain/clients/madam-muse/profile.md') }),
      execute: async ({ path }) => {
        try { return deps.brain.read(path); } catch (e) { return `Error: ${errMsg(e)}`; }
      },
    }),
    brain_search: tool({
      description: 'Keyword search across brain/ markdown files. Returns paths and snippets.',
      inputSchema: z.object({ query: z.string(), limit: z.number().int().min(1).max(20).optional() }),
      execute: async ({ query, limit }) => {
        const hits = deps.brain.search(query, limit ?? 5);
        return hits.length ? hits.map((h) => `${h.path} (score ${h.score}): ${h.snippet}`).join('\n') : 'No matches.';
      },
    }),
    request_external_action: tool({
      description: 'Propose an action that changes the outside world (publish, send, merge, deploy, spend). '
        + 'Nothing happens until the CEO approves. The worker has no automatic executor for these: after approving, '
        + 'the CEO carries the action out by hand, exactly as your spec says (RizeHub actions go through the rizehub_* tools instead).',
      inputSchema: z.object({
        type: z.string().describe('e.g. publish_article, send_email, merge_pr, publish_theme'),
        // Models often send a JSON object here; accept it and store it as readable text instead of failing the task.
        spec: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())])
          .describe('Exactly what should happen, with targets (URLs, ids, recipients), written so the CEO can do it step by step'),
      }),
      execute: async ({ type, spec: rawSpec }) => {
        const t = type.trim();
        const spec = specText(rawSpec);
        if (WORKER_EXECUTED_ACTIONS.has(t) || /^rizehub\./i.test(t)) {
          return `Not queued: "${t}" is executed by the worker and needs the exact payload its tool builds. Use `
            + (t === 'gmail.send' ? 'gmail_send instead.' : t === 'mcp.call' ? 'the app tool itself (it queues the approval).' : 'the rizehub_* tool (e.g. rizehub_reports publish / rizehub_onboarding request_approval / request_invite_send) instead.');
        }
        const id = await db.requestExternalAction(task.id, t, externalActionSpec(t, spec));
        return `Queued for CEO approval (approval ${id}). This is a MANUAL action: nothing runs automatically after approval; `
          + 'the CEO will do it by hand using your spec. Do not perform it yourself, do not report it as done; continue your task '
          + 'and mention in your output that it is waiting for the CEO.';
      },
    }),
  };

  // Tool modules (vault, RizeHub, …) add real implementations; they win over stubs but never replace built-ins.
  for (const factory of TOOL_FACTORIES) {
    for (const [name, t] of Object.entries(factory(ctx))) if (!(name in all)) all[name] = t;
  }

  const tools: ToolSet = {};
  for (const name of ctx.role.tools) {
    if (name in all) tools[name] = all[name]!;
    else {
      tools[name] = tool({
        description: `${name} (not connected yet)`,
        inputSchema: z.object({ request: z.string().optional().describe('What you wanted to do') }),
        execute: async () => stubMessage(name),
      });
    }
  }
  // Every specialist can always finish or ask, even if a role file forgets to list them.
  for (const name of ['submit_output', 'ask_ceo', 'report_progress'] as const) if (!tools[name]) tools[name] = all[name]!;
  return tools;
}

export interface RunOptions {
  heartbeatMs?: number;
  abortSignal?: AbortSignal;
  /** Global caps (default MAX_STEPS_PER_TASK / MAX_COST_PER_TASK_USD from the env). */
  limits?: TaskLimits;
  /** Hermes runtime overrides (tests); defaults come from the env (hermes/config.ts). */
  hermes?: HermesRunOptions;
  /** Design→dev handoff options (tests: workspacesDir); default copies upstream files into WORKSPACES_DIR. */
  handoff?: UpstreamOptions;
}

/**
 * Runs one claimed task on the agent's runtime: roles with `runtime: hermes` go to their Hermes Agent instance
 * (hermes/runner.ts, which falls back to the built-in runner when Hermes is unavailable); everyone else runs on the
 * built-in AI SDK runner.
 */
export async function runTask(task: TaskRow, deps: WorkerDeps, opts: RunOptions = {}): Promise<RunResult> {
  let role: Role | null = null;
  try { role = deps.loadRole(task.agent_id); } catch { /* runBuiltinTask reports the broken role file */ }
  if (role?.runtime === 'hermes') return runHermesTask(task, deps, role, opts, runBuiltinTask);
  return runBuiltinTask(task, deps, opts);
}

/** The built-in runner: generateText agent loop with the role's tools. */
export async function runBuiltinTask(task: TaskRow, deps: WorkerDeps, opts: RunOptions = {}): Promise<RunResult> {
  const db = deps.db;
  const state: RunState = { ended: null, costUsd: 0, overBudget: false, toolErrors: 0 };
  let picked: PickedModel | null = null;
  let usage: TokenUsage = {};
  let steps = 0;
  const heartbeat = setInterval(() => { db.touchHeartbeat(task.id).catch(() => undefined); }, opts.heartbeatMs ?? 30_000);
  heartbeat.unref?.();

  try {
    const role = deps.loadRole(task.agent_id);
    const agent = await db.getAgent(task.agent_id);
    const client = task.client_id ? await db.getClient(task.client_id) : null;
    picked = await deps.pickModel(role.model_role, { override: agent?.model_override });
    const pm = picked;
    const limits = taskLimits(role, opts.limits);

    const prompt = await buildRunPrompt(task, client, deps, opts.handoff);
    const tools = buildTools({ task, role, deps, state });
    // Connected MCP apps granted to this agent (Admin → Connectors → Apps, docs/15); built-in/role tools keep their names.
    const mcpEnv = mcpToolEnv({ task, role, deps, state });
    if (mcpEnv) for (const [n, t] of Object.entries(await loadMcpTools({ task, role, deps, state }, mcpEnv))) if (!(n in tools)) tools[n] = t;
    const stopWhen: StopCondition<ToolSet>[] = [stepCountIs(limits.maxSteps), () => state.ended !== null || state.overBudget || state.toolErrors >= 3];
    await db.reportProgress(task.id, 5, 'Reading the brief', { app: 'doc', title: task.title });

    const result = await generateText({
      model: pm.model,
      // Anthropic: system prompt + tools cached once per run, conversation cached step by step (models/cache.ts).
      ...cachedPrompt(pm.provider, role.body, prompt),
      prepareStep: ({ messages }) => ({ messages: withRollingCache(pm.provider, messages) }),
      tools,
      stopWhen,
      abortSignal: opts.abortSignal,
      onStepFinish: (step) => {
        steps++;
        usage = addUsage(usage, normalizeUsage(pm.provider, step.usage, step.providerMetadata));
        state.costUsd += pm.recordCall(step.usage, step.providerMetadata);
        state.toolErrors = step.content.some((c) => c.type === 'tool-error') ? state.toolErrors + 1 : 0;
        if (state.costUsd > limits.maxCostUsd) state.overBudget = true;
      },
    });

    if (state.ended === 'submitted') return { status: 'submitted', costUsd: state.costUsd, fallback: false };
    if (state.ended === 'asked') return { status: 'asked_ceo', costUsd: state.costUsd };
    if (state.overBudget) {
      const reason = taskBudgetReason(limits.maxCostUsd, state.costUsd);
      await db.failTask(task.id, reason);
      return { status: 'budget_exceeded', costUsd: state.costUsd };
    }
    // The step cap (min of role max_turns and MAX_STEPS_PER_TASK) cut the loop while the model still wanted to call tools.
    if (steps >= limits.maxSteps && result.finishReason === 'tool-calls') {
      const reason = maxStepsReason(limits.maxSteps);
      await db.failTask(task.id, reason);
      return { status: 'failed', reason, costUsd: state.costUsd };
    }
    if (state.toolErrors >= 3) {
      const reason = '3 consecutive tool errors';
      await db.failTask(task.id, reason);
      return { status: 'failed', reason, costUsd: state.costUsd };
    }
    const text = result.text.trim();
    if (!text) {
      const reason = `Agent stopped after ${steps} steps without submitting output`;
      await db.failTask(task.id, reason);
      return { status: 'failed', reason, costUsd: state.costUsd };
    }
    // Model ended without calling submit_output: its final text becomes the deliverable.
    await db.submitTaskOutput(task.id, {
      summary: text.length > 300 ? `${text.slice(0, 297)}...` : text, content: text, files: [], links: [],
      preview_url: null, criteria_map: {}, fallback: true,
    });
    state.ended = 'submitted';
    return { status: 'submitted', costUsd: state.costUsd, fallback: true };
  } catch (e) {
    if (state.ended) { // work already handed off; don't fail a task that is with QA / the CEO
      log(deps, `[${task.agent_id}] error after ${state.ended}: ${errMsg(e)}`);
      return state.ended === 'submitted' ? { status: 'submitted', costUsd: state.costUsd, fallback: false } : { status: 'asked_ceo', costUsd: state.costUsd };
    }
    if (isQuotaError(e) || opts.abortSignal?.aborted) {
      if (picked && !opts.abortSignal?.aborted) deps.onProviderQuota?.(picked.provider, { modelId: picked.modelId, error: e });
      const reason = opts.abortSignal?.aborted ? 'worker shutting down' : `model quota: ${errMsg(e)}`;
      await db.requeueTask(task.id, reason.slice(0, 500)).catch(() => undefined);
      return { status: 'requeued', reason, costUsd: state.costUsd };
    }
    const reason = errMsg(e).slice(0, 500);
    await db.failTask(task.id, reason).catch(() => undefined);
    return { status: 'failed', reason, costUsd: state.costUsd };
  } finally {
    clearInterval(heartbeat);
    // Close any logged-in client sessions from vault_login right away (cookies wiped).
    await closeRunSessions(state).catch(() => undefined);
    if (picked && steps > 0) {
      const u = usage;
      await db.recordUsage({
        actor: task.agent_id, kind: 'task', taskId: task.id, requestId: task.request_id,
        tokensIn: u.inputTokens ?? 0, tokensOut: u.outputTokens ?? 0, costUsd: state.costUsd,
        detail: usageDetail(picked, u, { steps, cost_usd: state.costUsd, ended: state.ended ?? (state.overBudget ? 'budget' : 'other') }),
      }).catch((e) => log(deps, `[${task.agent_id}] usage log failed`, errMsg(e)));
    }
    await db.finishAgentTurn(task.agent_id).catch(() => undefined);
  }
}
