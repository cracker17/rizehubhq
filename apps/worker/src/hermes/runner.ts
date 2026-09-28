// Hermes runtime for one claimed task (docs/05 "Hermes runtime"). The task prompt is the same one the built-in
// runner builds (instructions, acceptance criteria, prior QA/CEO feedback, SOP / QA checklist / brain context paths);
// Hermes runs its own tool loop and reaches HQ tools (report_progress, brain_*, request_external_action, ask_ceo,
// submit_output, …) through the worker's MCP endpoint (hermes/mcp.ts), so every outside-world effect still becomes
// an HQ approval. Hermes never holds publish/send credentials.
//
// Fallback: Hermes not configured, /health failing, or the run failing with down/timeout → the task runs on the
// built-in AI SDK runner and an activity row "Hermes unavailable for <agent>, ran on the built-in runner (<reason>)"
// is written (HERMES_FALLBACK=off: the task is re-queued, or failed when Hermes is not configured at all).
import { z } from 'zod';
import type { TaskOutput, TaskRow } from '../hqdb';
import type { Role } from '../roles';
import { errMsg, log, usageDetail, type WorkerDeps } from '../deps';
import { costUsd, type TokenUsage } from '../models/usage';
import type { RunOptions, RunResult } from '../runner';
import { buildTaskPrompt } from '../runner';
import { HermesClient, HermesError, type HermesUsage } from './client';
import { hermesAgentConfig, hermesFallbackEnabled, type HermesAgentConfig } from './config';
import { releaseMcpTaskState } from './mcpState';

export interface HermesRunOptions {
  /** Agent id → its Hermes instance (default: HERMES_URL_<AGENT> / HERMES_KEY_<AGENT>). */
  resolve?: (agentId: string) => HermesAgentConfig | null;
  /** HERMES_FALLBACK (default on). */
  fallback?: boolean;
  fetch?: typeof fetch;
  healthTimeoutMs?: number;
}

export type BuiltinRunner = (task: TaskRow, deps: WorkerDeps, opts: RunOptions) => Promise<RunResult>;

export const fallbackNote = (agentId: string, reason: string) =>
  `Hermes unavailable for ${agentId}, ran on the built-in runner (${reason})`;

/** Extra instructions appended to the task prompt for Hermes runs. */
export function hermesInstructions(task: Pick<TaskRow, 'id'>): string {
  return [
    '## Running on Hermes',
    `HQ tools come from the MCP server "hq" (report_progress, brain_read, brain_search, ask_ceo, request_external_action, submit_output, `
      + `and your role's other tools). Pass task_id "${task.id}" to every HQ tool call.`,
    'You have NO publish, send, merge, deploy or payment credentials and must not try to obtain or use any: propose every such '
      + 'action with request_external_action (the CEO approves it; nothing happens before that). Client logins and API calls go '
      + 'through the HQ vault tools only.',
    'Finish by calling submit_output (full deliverable in `content`, one criteria_map entry per acceptance criterion), or ask_ceo if '
      + 'something blocking is missing. If the HQ tools are not reachable, end your final answer with a fenced ```json block: '
      + '{"summary": "...", "content": "...", "files": [], "links": [], "preview_url": null, "criteria_map": [{"criterion": "...", "how_met": "..."}]} '
      + 'or {"ask_ceo": {"question": "...", "options": []}}.',
  ].join('\n');
}

const FinalOutput = z.object({
  summary: z.string().min(1),
  content: z.string().optional(),
  files: z.array(z.string()).optional(),
  links: z.array(z.string()).optional(),
  preview_url: z.string().nullable().optional(),
  criteria_map: z.union([
    z.array(z.object({ criterion: z.string(), how_met: z.string() })),
    z.record(z.string(), z.string()),
  ]).optional(),
});
const FinalAsk = z.object({ ask_ceo: z.object({ question: z.string().min(1), options: z.array(z.string()).optional() }) });

export type FinalAnswer =
  | { kind: 'output'; output: TaskOutput }
  | { kind: 'ask'; question: string; options: string[] }
  | { kind: 'empty' };

/** Hermes' final answer → the task output shape the built-in runner saves (fenced json block, else the text itself). */
export function parseFinalAnswer(text: string): FinalAnswer {
  const t = text.trim();
  if (!t) return { kind: 'empty' };
  const blocks = [...t.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]!.trim());
  const candidates = [...blocks.reverse(), t];
  for (const c of candidates) {
    let v: unknown;
    try { v = JSON.parse(c); } catch { continue; }
    const ask = FinalAsk.safeParse(v);
    if (ask.success) return { kind: 'ask', question: ask.data.ask_ceo.question, options: ask.data.ask_ceo.options ?? [] };
    const out = FinalOutput.safeParse(v);
    if (out.success) {
      const cm = out.data.criteria_map;
      return {
        kind: 'output',
        output: {
          summary: out.data.summary, content: out.data.content, files: out.data.files ?? [], links: out.data.links ?? [],
          preview_url: out.data.preview_url ?? null,
          criteria_map: Array.isArray(cm) ? Object.fromEntries(cm.map((c) => [c.criterion, c.how_met])) : (cm ?? {}),
        },
      };
    }
  }
  // Plain text: same fallback shape as the built-in runner when the model ends without submit_output.
  return {
    kind: 'output',
    output: { summary: t.length > 300 ? `${t.slice(0, 297)}...` : t, content: t, files: [], links: [], preview_url: null, criteria_map: {}, fallback: true },
  };
}

/** Provider + model to price Hermes usage with (docs/14 prices). Unknown → unpriced ($0, flagged in the usage detail). */
export function hermesPricing(responseModel: string | null, configured: string | null): { provider: string; modelId: string } {
  for (const m of [responseModel, configured]) {
    if (!m) continue;
    const id = m.replace(/^(anthropic|openai)[/:]/, '');
    if (/^claude-/.test(id)) return { provider: 'anthropic', modelId: id };
    if (/^(gpt-|o\d)/.test(id)) return { provider: 'openai', modelId: id };
  }
  return { provider: 'hermes', modelId: responseModel ?? configured ?? 'unknown' };
}

type Attempt = { result: RunResult } | { fallback: string; requeue: boolean };

export async function runHermesTask(task: TaskRow, deps: WorkerDeps, role: Role, opts: RunOptions, builtin: BuiltinRunner): Promise<RunResult> {
  const h = opts.hermes ?? {};
  const cfg = (h.resolve ?? hermesAgentConfig)(task.agent_id);
  const fallbackOn = h.fallback ?? hermesFallbackEnabled();

  const attempt: Attempt = cfg
    ? await attemptHermes(task, deps, role, cfg, opts)
    : { fallback: `not configured: set HERMES_URL_${task.agent_id.toUpperCase().replace(/-/g, '_')} and HERMES_KEY_…`, requeue: false };
  if ('result' in attempt) return attempt.result;

  const db = deps.db;
  if (!fallbackOn) {
    const reason = `Hermes unavailable for ${task.agent_id} (${attempt.fallback}); HERMES_FALLBACK=off`;
    log(deps, `[${task.agent_id}] ${reason}`);
    try {
      if (attempt.requeue) { await db.requeueTask(task.id, reason.slice(0, 500)); return { status: 'requeued', reason, costUsd: 0 }; }
      await db.failTask(task.id, reason.slice(0, 500));
      return { status: 'failed', reason, costUsd: 0 };
    } finally {
      await db.finishAgentTurn(task.agent_id).catch(() => undefined);
    }
  }
  const note = fallbackNote(task.agent_id, attempt.fallback);
  log(deps, `[${task.agent_id}] ${note}`);
  await db.logActivity(task.agent_id, 'hermes.fallback', task.request_id, task.id, { note, reason: attempt.fallback })
    .catch((e) => log(deps, `[${task.agent_id}] could not log the Hermes fallback`, errMsg(e)));
  return builtin(task, deps, opts);
}

/** Current state of the task after Hermes returned (it may have finished or paused it through the HQ MCP tools). */
async function settledByMcp(task: TaskRow, deps: WorkerDeps, costUsd: number): Promise<RunResult | null> {
  const cur = await deps.db.getTask(task.id);
  if (!cur || cur.status === 'working') return null;
  if (cur.status === 'qa_pending' || cur.status === 'qa_reviewing') return { status: 'submitted', costUsd, fallback: false };
  if (cur.status === 'awaiting_ceo') return { status: 'asked_ceo', costUsd };
  return { status: 'failed', reason: `task is ${cur.status}`, costUsd };
}

async function attemptHermes(task: TaskRow, deps: WorkerDeps, role: Role, cfg: HermesAgentConfig, opts: RunOptions): Promise<Attempt> {
  const db = deps.db;
  const client = new HermesClient({ url: cfg.url, key: cfg.key, timeoutMs: cfg.timeoutMs, fetch: opts.hermes?.fetch });
  try {
    await client.health({ timeoutMs: opts.hermes?.healthTimeoutMs ?? 5_000, signal: opts.abortSignal });
  } catch (e) {
    if (opts.abortSignal?.aborted) {
      await db.requeueTask(task.id, 'worker shutting down').catch(() => undefined);
      await db.finishAgentTurn(task.agent_id).catch(() => undefined);
      return { result: { status: 'requeued', reason: 'worker shutting down', costUsd: 0 } };
    }
    return { fallback: `health check failed: ${e instanceof HermesError ? `${e.kind}: ` : ''}${errMsg(e)}`, requeue: true };
  }

  let usage: HermesUsage | null = null;
  let pricing: { provider: string; modelId: string } | null = null;
  let cost = 0;
  let ended = 'other';
  const heartbeat = setInterval(() => { db.touchHeartbeat(task.id).catch(() => undefined); }, opts.heartbeatMs ?? 30_000);
  heartbeat.unref?.();
  try {
    const client0 = task.client_id ? await db.getClient(task.client_id) : null;
    await db.reportProgress(task.id, 5, 'Reading the brief', { app: 'doc', title: task.title });
    const prompt = `${buildTaskPrompt(task, client0, deps)}\n\n${hermesInstructions(task)}`;
    let res;
    try {
      res = await client.chat({
        messages: [{ role: 'system', content: role.body }, { role: 'user', content: prompt }],
        sessionId: task.id, sessionKey: task.agent_id, signal: opts.abortSignal,
      });
    } catch (e) {
      const he = e instanceof HermesError ? e : new HermesError('bad_response', errMsg(e));
      if (he.kind === 'aborted') {
        await db.requeueTask(task.id, 'worker shutting down').catch(() => undefined);
        ended = 'requeued';
        return { result: { status: 'requeued', reason: 'worker shutting down', costUsd: 0 } };
      }
      // Hermes may have finished or paused the task through MCP before the connection dropped.
      const settled = await settledByMcp(task, deps, 0);
      if (settled) { ended = settled.status; return { result: settled }; }
      if (he.kind === 'down' || he.kind === 'timeout') { ended = 'fallback'; return { fallback: `${he.kind}: ${he.message}`, requeue: true }; }
      const reason = `Hermes run failed (${he.kind}): ${he.message}`.slice(0, 500);
      await db.failTask(task.id, reason).catch(() => undefined);
      ended = 'failed';
      return { result: { status: 'failed', reason, costUsd: 0 } };
    }

    usage = res.usage;
    pricing = hermesPricing(res.model, cfg.model);
    cost = usage ? costUsd(pricing.provider, pricing.modelId, usage) : 0;

    const settled = await settledByMcp(task, deps, cost);
    if (settled) { ended = settled.status; return { result: settled }; }

    const final = parseFinalAnswer(res.text);
    if (final.kind === 'empty') {
      const reason = 'Hermes ended without submitting output';
      await db.failTask(task.id, reason);
      ended = 'failed';
      return { result: { status: 'failed', reason, costUsd: cost } };
    }
    if (final.kind === 'ask') {
      await db.askCeo(task.id, final.question, final.options);
      ended = 'asked';
      return { result: { status: 'asked_ceo', costUsd: cost } };
    }
    await db.submitTaskOutput(task.id, final.output);
    ended = 'submitted';
    return { result: { status: 'submitted', costUsd: cost, fallback: final.output.fallback === true } };
  } catch (e) {
    const reason = errMsg(e).slice(0, 500);
    const settled = await settledByMcp(task, deps, cost).catch(() => null);
    if (settled) return { result: settled };
    await db.failTask(task.id, reason).catch(() => undefined);
    ended = 'failed';
    return { result: { status: 'failed', reason, costUsd: cost } };
  } finally {
    clearInterval(heartbeat);
    await releaseMcpTaskState(task.id).catch(() => undefined);
    if (usage && pricing) {
      const u: TokenUsage = usage;
      const limitUsd = role.budget_usd_per_task;
      await db.recordUsage({
        actor: task.agent_id, kind: 'task', taskId: task.id, requestId: task.request_id,
        tokensIn: u.inputTokens ?? 0, tokensOut: u.outputTokens ?? 0, costUsd: cost,
        detail: usageDetail(pricing, u, { runtime: 'hermes', cost_usd: cost, ended, ...(pricing.provider === 'hermes' ? { unpriced: true } : {}),
          ...(cost > limitUsd ? { over_task_budget: limitUsd } : {}) }),
      }).catch((e) => log(deps, `[${task.agent_id}] usage log failed`, errMsg(e)));
    }
    if (ended !== 'fallback') await db.finishAgentTurn(task.agent_id).catch(() => undefined);
  }
}
