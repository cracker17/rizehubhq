// Specialist task runner (docs/05 [4]): one claimed task → generateText agent loop with the role's
// tools → submit_output / ask_ceo. Heartbeat, usage + cost logging, budget guard, quota requeue.
import { generateText, stepCountIs, tool, type StopCondition, type ToolSet } from 'ai';
import { closeRunSessions } from './vault/browser';
import { TOOL_FACTORIES } from './tools';
import { z } from 'zod';
import type { ClientRow, TaskOutput, TaskRow } from './hqdb';
import type { Role } from './roles';
import { errMsg, log, usageDetail, type WorkerDeps } from './deps';
import { addUsage, isQuotaError, type PickedModel } from './models/usage';
import { WORKER_EXECUTED_ACTIONS } from './rizehub/background';

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
export function externalActionSpec(type: string, spec: string): Record<string, unknown> {
  return WORKER_EXECUTED_ACTIONS.has(type) ? { description: spec, executor: 'worker' } : { description: spec, executor: 'manual' };
}

export type RunResult =
  | { status: 'submitted'; costUsd: number; fallback: boolean }
  | { status: 'asked_ceo'; costUsd: number }
  | { status: 'failed'; reason: string; costUsd: number }
  | { status: 'budget_exceeded'; costUsd: number }
  | { status: 'requeued'; reason: string; costUsd: number };

interface RunState { ended: null | 'submitted' | 'asked'; costUsd: number; overBudget: boolean; toolErrors: number }

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
        spec: z.string().describe('Exactly what should happen, with targets (URLs, ids, recipients), written so the CEO can do it step by step'),
      }),
      execute: async ({ type, spec }) => {
        const t = type.trim();
        if (WORKER_EXECUTED_ACTIONS.has(t) || /^rizehub\./i.test(t)) {
          return `Not queued: "${t}" is executed by the worker and needs the exact payload its tool builds. Use the rizehub_* tool `
            + '(e.g. rizehub_reports publish / rizehub_onboarding request_approval / request_invite_send) instead.';
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

export interface RunOptions { heartbeatMs?: number; abortSignal?: AbortSignal }

export async function runTask(task: TaskRow, deps: WorkerDeps, opts: RunOptions = {}): Promise<RunResult> {
  const db = deps.db;
  const state: RunState = { ended: null, costUsd: 0, overBudget: false, toolErrors: 0 };
  let picked: PickedModel | null = null;
  let usage = {};
  let steps = 0;
  const heartbeat = setInterval(() => { db.touchHeartbeat(task.id).catch(() => undefined); }, opts.heartbeatMs ?? 30_000);
  heartbeat.unref?.();

  try {
    const role = deps.loadRole(task.agent_id);
    const agent = await db.getAgent(task.agent_id);
    const client = task.client_id ? await db.getClient(task.client_id) : null;
    picked = await deps.pickModel(role.model_role, { override: agent?.model_override });
    const pm = picked;

    const tools = buildTools({ task, role, deps, state });
    const stopWhen: StopCondition<ToolSet>[] = [stepCountIs(role.max_turns), () => state.ended !== null || state.overBudget || state.toolErrors >= 3];
    await db.reportProgress(task.id, 5, 'Reading the brief', { app: 'doc', title: task.title });

    const result = await generateText({
      model: pm.model,
      system: role.body,
      prompt: buildTaskPrompt(task, client, deps),
      tools,
      stopWhen,
      abortSignal: opts.abortSignal,
      onStepFinish: (step) => {
        steps++;
        usage = addUsage(usage, step.usage);
        state.costUsd += pm.recordCall(step.usage);
        state.toolErrors = step.content.some((c) => c.type === 'tool-error') ? state.toolErrors + 1 : 0;
        if (state.costUsd > role.budget_usd_per_task) state.overBudget = true;
      },
    });

    if (state.ended === 'submitted') return { status: 'submitted', costUsd: state.costUsd, fallback: false };
    if (state.ended === 'asked') return { status: 'asked_ceo', costUsd: state.costUsd };
    if (state.overBudget) {
      await db.failTask(task.id, `Budget exceeded: $${state.costUsd.toFixed(4)} > $${role.budget_usd_per_task.toFixed(2)} per task`);
      return { status: 'budget_exceeded', costUsd: state.costUsd };
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
      if (picked && !opts.abortSignal?.aborted) deps.onProviderQuota?.(picked.provider);
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
      const u = usage as { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
      await db.recordUsage({
        actor: task.agent_id, kind: 'task', taskId: task.id, requestId: task.request_id,
        tokensIn: u.inputTokens ?? 0, tokensOut: u.outputTokens ?? 0, costUsd: state.costUsd,
        detail: usageDetail(picked, u, { steps, cost_usd: state.costUsd, ended: state.ended ?? (state.overBudget ? 'budget' : 'other') }),
      }).catch((e) => log(deps, `[${task.agent_id}] usage log failed`, errMsg(e)));
    }
    await db.finishAgentTurn(task.agent_id).catch(() => undefined);
  }
}
