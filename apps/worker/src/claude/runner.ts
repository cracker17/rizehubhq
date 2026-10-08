// Claude Agent SDK runtime for one claimed task (docs/05 "Claude runtime"). The task prompt is the same one the
// built-in runner builds (buildRunPrompt); the role file body is the system prompt; Claude Code runs its own tool loop
// in the task workspace and reaches HQ tools (report_progress, brain_*, request_external_action, ask_ceo, submit_output,
// gmail_*, connected MCP apps, …) only through the worker's own HQ MCP endpoint (hermes/mcp.ts), so every
// outside-world effect still becomes an HQ approval. Claude Code's Bash, web and subagent tools are off; HQ's
// bash_sandboxed (agent uid, allowlist) is the only shell.
//
// Runs only when CLAUDE_RUNTIME_ENABLED, ANTHROPIC_API_KEY and a paid budget (MONTHLY_BUDGET_USD > 0, month and day
// not used up) are all there; otherwise, and when the SDK fails / times out, the task runs on the built-in runner and
// activity `claude.fallback` records why (like hermes.fallback).
//
// Run lease (hermes/mcpState.ts): each attempt holds a lease plus a random per-run MCP bearer token bound to it. When
// the run ends, times out or fails, the lease is revoked FIRST (waiting briefly for HQ tool calls still executing
// under it) and the Claude Code process is closed; only then may the built-in runner take over. A late SDK message is
// never read and a late MCP call is refused, so neither can write to the task after a fallback.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HookCallback, Options, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { anthropicWorkspaceHeaders } from '@rizehubhq/shared';
import type { TaskRow } from '../hqdb';
import type { Role } from '../roles';
import { errMsg, log, usageDetail, type WorkerDeps } from '../deps';
import { addUsage, costUsd, type TokenUsage } from '../models/usage';
import { loadModelsConfig, type ModelsConfig } from '../models/router';
import { config, workerEnv } from '../config';
import type { RunOptions, RunResult } from '../runner';
import { buildRunPrompt, maxStepsReason, taskBudgetReason, taskLimits, type TaskLimits } from '../runner';
import { parseFinalAnswer, settledByMcp, DEFAULT_LEASE_DRAIN_MS, type BuiltinRunner } from '../hermes/runner';
import { acquireHermesLease, issueRunToken, revokeHermesLease } from '../hermes/mcpState';
import { agentToolNames } from '../hermes/mcp';
import { openJail, type Jail } from '../dev/jail';
import { agentIdentity, chownTreeToAgent } from '../dev/agentUser';
import { claudeFileTools, claudeModel, claudeRuntimeEnabled, claudeTimeoutMs, hqMcpUrl, MIN_RUN_BUDGET_USD, type ClaudeFileTools } from './config';
import { checkNativeFileCall, handOverToAgent, NATIVE_FILE_TOOLS } from './guard';

type Env = Readonly<Record<string, string | undefined>>;

/** The SDK's query() as the runner uses it (tests inject a fake). */
export type QueryFn = (p: { prompt: string; options: Options }) => AsyncIterable<SDKMessage> & { close?: () => void };

export interface ClaudeRunOptions {
  /** Default: the real @anthropic-ai/claude-agent-sdk query() (loaded on first use). */
  query?: QueryFn;
  /** Default workerEnv(). */
  env?: Env;
  models?: ModelsConfig;
  profile?: string;
  workspacesDir?: string;
  mcpUrl?: string;
  timeoutMs?: number;
  /** Max wait for HQ tool calls still executing under a revoked run before the built-in runner may start (default 30 s). */
  drainMs?: number;
}

/** MCP server name the HQ tools appear under (tool ids mcp__hq__<tool>). */
export const HQ_MCP_SERVER = 'hq';
export const hqToolId = (name: string) => `mcp__${HQ_MCP_SERVER}__${name}`;
/** Claude Code tools that never run in HQ (shell, web, subagents, skills, notebooks). */
export const ALWAYS_DISALLOWED = ['Bash', 'BashOutput', 'KillShell', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'NotebookEdit', 'Skill'] as const;
/** Per HQ MCP tool call (bash_sandboxed / lighthouse can take minutes). */
export const HQ_MCP_TOOL_TIMEOUT_MS = 15 * 60_000;

export const claudeFallbackNote = (agentId: string, reason: string) =>
  `Claude unavailable for ${agentId}, ran on the built-in runner (${reason})`;

/** Env vars the Claude Code process may inherit (never a secret; ANTHROPIC_API_KEY is added explicitly). */
const PASS_ENV = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR'];

/**
 * The Claude Code process environment: REPLACES the worker's (the SDK does not merge), so it holds only harmless
 * basics, a private throwaway HOME / CLAUDE_CONFIG_DIR, and the API key. No other worker secret reaches it.
 */
export function claudeProcessEnv(apiKey: string, home: string, env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of PASS_ENV) { const v = env[k]; if (v !== undefined && v !== '') out[k] = v; }
  // A multi-workspace key must name its workspace on every request (Claude Code sends ANTHROPIC_CUSTOM_HEADERS).
  const ws = anthropicWorkspaceHeaders(env.ANTHROPIC_WORKSPACE_ID)['anthropic-workspace-id'];
  if (ws) out.ANTHROPIC_CUSTOM_HEADERS = `anthropic-workspace-id: ${ws}`;
  return {
    ...out, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: home, ANTHROPIC_API_KEY: apiKey,
    CLAUDE_AGENT_SDK_CLIENT_APP: 'rizehub-hq-worker/1.0', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
  };
}

/** Replaces every occurrence of the given secrets (API key, run token) in text. */
export function redact(text: string, secrets: readonly string[]): string {
  let t = text;
  for (const s of secrets) if (s && s.length >= 8) t = t.split(s).join('[redacted]');
  return t;
}

/** Budget a run may spend: the stricter of the task cap and what the month and the day have left, or why none. */
export async function claudeBudget(deps: WorkerDeps, limits: TaskLimits): Promise<{ capUsd: number } | { reason: string }> {
  const monthly = deps.spend?.().monthlyBudgetUsd ?? deps.monthlyBudgetUsd ?? 0;
  if (!(monthly > 0)) return { reason: 'MONTHLY_BUDGET_USD is 0: paid models are off' };
  const s = deps.spend?.() ?? {
    monthlyBudgetUsd: monthly, spentThisMonthUsd: await deps.db.monthSpendUsd().catch(() => Number.POSITIVE_INFINITY),
    dailyBudgetUsd: null, spentTodayUsd: 0,
  };
  const monthLeft = s.monthlyBudgetUsd - s.spentThisMonthUsd;
  if (!(monthLeft >= MIN_RUN_BUDGET_USD)) return { reason: `monthly budget used up ($${s.spentThisMonthUsd.toFixed(2)} of $${s.monthlyBudgetUsd.toFixed(2)})` };
  let cap = Math.min(limits.maxCostUsd, monthLeft);
  if (s.dailyBudgetUsd !== null && Number.isFinite(s.dailyBudgetUsd) && s.dailyBudgetUsd > 0) {
    const dayLeft = s.dailyBudgetUsd - s.spentTodayUsd;
    if (!(dayLeft >= MIN_RUN_BUDGET_USD)) return { reason: `daily AI budget reached ($${s.spentTodayUsd.toFixed(2)} of $${s.dailyBudgetUsd.toFixed(2)})` };
    cap = Math.min(cap, dayLeft);
  }
  if (!(cap >= MIN_RUN_BUDGET_USD)) return { reason: `task budget too small ($${cap.toFixed(2)})` };
  return { capUsd: Math.round(cap * 1e4) / 1e4 };
}

/** Extra instructions appended to the task prompt for Claude runs. */
export function claudeInstructions(o: { cwd: string; fileTools: 'native' | 'hq' | 'none'; shell: boolean; workspaceFs: boolean }): string {
  const files = o.fileTools === 'native'
    ? `Read, Edit, Write, Glob and Grep work only inside it (anything outside is refused). brain/ files: ${hqToolId('brain_read')}.`
    : o.workspaceFs
      ? `Use ${hqToolId('workspace_fs')} for files in it (paths relative to the workspace; brain/… is read-only).`
      : 'You have no file tools; work from the brief and the HQ tools.';
  return [
    '## Running on Claude',
    `HQ tools are the MCP tools named ${hqToolId('<tool>')} (report_progress, brain_read, brain_search, ask_ceo, request_external_action, `
      + 'submit_output and your role\'s other tools). They act on this task automatically: no task id is needed. If an HQ tool says '
      + 'this run has ended, stop immediately: HQ has handed the task to someone else.',
    `Your workspace (current directory) is ${o.cwd}. ${files} There is no Bash tool`
      + (o.shell ? `: run commands with ${hqToolId('bash_sandboxed')}.` : '.'),
    'You have NO publish, send, merge, deploy or payment credentials and must not try to obtain or use any: propose every such '
      + 'action with request_external_action (the CEO approves it; nothing happens before that). Client logins and API calls go '
      + 'through the HQ vault tools only.',
    `Finish by calling ${hqToolId('submit_output')} (full deliverable in \`content\`, one criteria_map entry per acceptance criterion), `
      + `or ${hqToolId('ask_ceo')} if something blocking is missing. If the HQ tools are not reachable, end your final answer with a fenced `
      + '```json block: {"summary": "...", "content": "...", "files": [], "links": [], "preview_url": null, "criteria_map": '
      + '[{"criterion": "...", "how_met": "..."}]} or {"ask_ceo": {"question": "...", "options": []}}.',
  ].join('\n');
}

/** SDK model usage → TokenUsage (inputTokens = fresh + cache reads + cache writes, as models/usage.ts expects). */
function toTokenUsage(u: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }): Required<TokenUsage> {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const read = n(u.cacheReadInputTokens);
  const write = n(u.cacheCreationInputTokens);
  return { inputTokens: n(u.inputTokens) + read + write, outputTokens: n(u.outputTokens), cachedInputTokens: read, cacheWriteTokens: write };
}

interface Priced { usage: Required<TokenUsage>; costUsd: number; model: string; sdkCostUsd: number | null }

/**
 * Tokens and cost of a run, priced with HQ's own table (models/usage.ts PRICES, docs/14): from the result's per-model
 * totals, or (no result, e.g. a crash) from the assistant messages seen (last usage per API message id).
 */
export function priceRun(result: SDKResultMessage | null, perMessage: Map<string, { model: string; usage: Record<string, unknown> }>, fallbackModel: string): Priced {
  let usage: Required<TokenUsage> = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 };
  let cost = 0;
  let top = { model: fallbackModel, tokens: -1 };
  const add = (model: string, u: Required<TokenUsage>) => {
    usage = addUsage(usage, u);
    cost += costUsd('anthropic', model, u);
    if (u.inputTokens + u.outputTokens > top.tokens) top = { model, tokens: u.inputTokens + u.outputTokens };
  };
  if (result && result.modelUsage && Object.keys(result.modelUsage).length) {
    for (const [key, m] of Object.entries(result.modelUsage)) add(m.canonicalModel || key, toTokenUsage(m));
  } else {
    for (const { model, usage: u } of perMessage.values()) {
      add(model, toTokenUsage({
        inputTokens: u.input_tokens as number, outputTokens: u.output_tokens as number,
        cacheReadInputTokens: u.cache_read_input_tokens as number, cacheCreationInputTokens: u.cache_creation_input_tokens as number,
      }));
    }
  }
  return { usage, costUsd: Math.round(cost * 1e6) / 1e6, model: top.model, sdkCostUsd: result ? result.total_cost_usd : null };
}

let realQuery: QueryFn | null = null;
async function defaultQuery(): Promise<QueryFn> {
  if (!realQuery) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    realQuery = (p) => sdk.query(p);
  }
  return realQuery;
}

async function fallBack(task: TaskRow, deps: WorkerDeps, opts: RunOptions, builtin: BuiltinRunner, reason: string): Promise<RunResult> {
  const note = claudeFallbackNote(task.agent_id, reason);
  log(deps, `[${task.agent_id}] ${note}`);
  await deps.db.logActivity(task.agent_id, 'claude.fallback', task.request_id, task.id, { note, reason })
    .catch((e) => log(deps, `[${task.agent_id}] could not log the Claude fallback`, errMsg(e)));
  return builtin(task, deps, opts);
}

type Attempt = { result: RunResult } | { fallback: string };

export async function runClaudeTask(task: TaskRow, deps: WorkerDeps, role: Role, opts: RunOptions, builtin: BuiltinRunner): Promise<RunResult> {
  const c = opts.claude ?? {};
  const env = c.env ?? workerEnv();
  const apiKey = env.ANTHROPIC_API_KEY?.trim() ?? '';
  if (!claudeRuntimeEnabled(env)) return fallBack(task, deps, opts, builtin, 'CLAUDE_RUNTIME_ENABLED is off');
  if (!apiKey) return fallBack(task, deps, opts, builtin, 'ANTHROPIC_API_KEY not set');
  const limits = taskLimits(role, opts.limits);
  const budget = await claudeBudget(deps, limits);
  if ('reason' in budget) return fallBack(task, deps, opts, builtin, budget.reason);
  const agent = await deps.db.getAgent(task.agent_id).catch(() => null);
  let model: string | null = null;
  try {
    model = claudeModel(role, { env, cfg: c.models ?? loadModelsConfig(), profile: c.profile ?? config.modelProfile, override: agent?.model_override });
  } catch (e) { log(deps, `[${task.agent_id}] Claude model not resolved: ${errMsg(e)}`); }
  if (!model) return fallBack(task, deps, opts, builtin, `no Anthropic model configured for model role ${role.model_role}`);

  const attempt = await attemptClaude(task, deps, role, opts, { env, apiKey, model, capUsd: budget.capUsd, limits, fileTools: claudeFileTools(env) });
  if ('result' in attempt) return attempt.result;
  return fallBack(task, deps, opts, builtin, attempt.fallback);
}

interface AttemptConfig { env: Env; apiKey: string; model: string; capUsd: number; limits: TaskLimits; fileTools: ClaudeFileTools }

async function attemptClaude(task: TaskRow, deps: WorkerDeps, role: Role, opts: RunOptions, a: AttemptConfig): Promise<Attempt> {
  const db = deps.db;
  const c = opts.claude ?? {};
  const agentId = task.agent_id;
  const runId = await acquireHermesLease(task.id, agentId, 'Claude');
  const token = issueRunToken(task.id, runId);
  const secrets = [a.apiKey, token];
  const clean = (s: string) => redact(s, secrets);
  /** Revokes this run's lease (idempotent). true = no HQ tool call of this run is still executing. */
  const endLease = (reason: string, drainMs = 0) => revokeHermesLease(task.id, runId, reason, drainMs).catch(() => false);
  const drainMs = c.drainMs ?? DEFAULT_LEASE_DRAIN_MS;
  const heartbeat = setInterval(() => { db.touchHeartbeat(task.id).catch(() => undefined); }, opts.heartbeatMs ?? 30_000);
  heartbeat.unref?.();

  const ctrl = new AbortController();
  let timedOut = false;
  const timeoutMs = c.timeoutMs ?? claudeTimeoutMs(a.env);
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  const onAbort = () => ctrl.abort();
  opts.abortSignal?.addEventListener('abort', onAbort, { once: true });

  let result: SDKResultMessage | null = null;
  const perMessage = new Map<string, { model: string; usage: Record<string, unknown> }>();
  let started = false;
  let ended = 'other';
  let home: string | null = null;
  let stderrTail = '';

  const finish = async (r: RunResult, how: string): Promise<Attempt> => { ended = how; return { result: r }; };

  try {
    const jail: Jail = openJail(c.workspacesDir ?? config.workspacesDir, task.id);
    const agentUser = agentIdentity(a.env);
    chownTreeToAgent(jail.root, agentUser);
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-claude-'));

    const client0 = task.client_id ? await db.getClient(task.client_id) : null;
    await db.reportProgress(task.id, 5, 'Reading the brief', { app: 'doc', title: task.title });
    const base = await buildRunPrompt(task, client0, deps, opts.handoff);
    const hasFs = role.tools.includes('workspace_fs');
    const native = a.fileTools === 'native' && hasFs ? [...NATIVE_FILE_TOOLS] : [];
    const prompt = `${base}\n\n${claudeInstructions({
      cwd: jail.root, fileTools: native.length ? 'native' : hasFs ? 'hq' : 'none', shell: role.tools.includes('bash_sandboxed'), workspaceFs: hasFs,
    })}`;
    const hqTools = (await agentToolNames(deps, agentId)).map(hqToolId);
    const allowed = new Set<string>([...hqTools, ...native]);

    const deny = (why: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: why } });
    // Final say before every tool call (a hook deny beats any permission rule): only HQ tools + the jailed file tools.
    const preToolUse: HookCallback = async (input) => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      if (!allowed.has(input.tool_name)) return deny(`${input.tool_name} is not available in RizeHub HQ. Use the ${hqToolId('…')} tools.`);
      if ((NATIVE_FILE_TOOLS as readonly string[]).includes(input.tool_name)) {
        const why = checkNativeFileCall(input.tool_name, input.tool_input, jail);
        if (why) return deny(why);
      }
      return {};
    };
    const postToolUse: HookCallback = async (input) => {
      if (input.hook_event_name === 'PostToolUse' && (input.tool_name === 'Write' || input.tool_name === 'Edit')) {
        handOverToAgent(jail, (input.tool_input as { file_path?: unknown } | null)?.file_path, agentUser);
      }
      return {};
    };

    const options: Options = {
      cwd: jail.root,
      systemPrompt: role.body,
      model: a.model,
      tools: native,
      allowedTools: [...allowed],
      disallowedTools: [...ALWAYS_DISALLOWED, ...(native.length ? [] : NATIVE_FILE_TOOLS)],
      permissionMode: 'dontAsk',
      permissionPrompts: 'none',
      maxTurns: a.limits.maxSteps,
      maxBudgetUsd: a.capUsd,
      mcpServers: {
        [HQ_MCP_SERVER]: {
          type: 'http', url: c.mcpUrl ?? hqMcpUrl(a.env), headers: { Authorization: `Bearer ${token}` },
          timeout: HQ_MCP_TOOL_TIMEOUT_MS, alwaysLoad: true,
        },
      },
      strictMcpConfig: true,
      settingSources: [],
      persistSession: false,
      skills: [],
      env: claudeProcessEnv(a.apiKey, home, a.env),
      abortController: ctrl,
      hooks: { PreToolUse: [{ hooks: [preToolUse] }], PostToolUse: [{ matcher: 'Write|Edit', hooks: [postToolUse] }] },
      stderr: (d: string) => { stderrTail = (stderrTail + d).slice(-4000); },
    };

    const q = (c.query ?? await defaultQuery())({ prompt, options });
    started = true;
    let sdkError: unknown = null;
    let authError: string | null = null;
    try {
      for await (const m of q) {
        if (ctrl.signal.aborted) break;
        if (m.type === 'result') { result = m; break; }
        // Claude Code retries a rejected key ~10 times with backoff (minutes): a wrong key will not fix itself.
        if (m.type === 'system' && m.subtype === 'api_retry' && (m.error_status === 401 || m.error_status === 403)) {
          authError = `Anthropic API rejected ANTHROPIC_API_KEY (HTTP ${m.error_status})`;
          break;
        }
        if (m.type === 'assistant' && !m.parent_tool_use_id) {
          const msg = m.message as unknown as { id?: string; model?: string; usage?: Record<string, unknown> };
          if (msg?.id && msg.usage) perMessage.set(msg.id, { model: msg.model ?? a.model, usage: msg.usage });
        }
      }
    } catch (e) {
      sdkError = e;
    } finally {
      try { q.close?.(); } catch { /* already gone */ }
    }

    // Worker shutting down: re-queue (unless the task was already handed on through MCP).
    if (opts.abortSignal?.aborted) {
      await endLease('worker shutting down', drainMs);
      const settled = await settledByMcp(task, deps, 0).catch(() => null);
      if (settled) return finish(settled, settled.status);
      await db.requeueTask(task.id, 'worker shutting down').catch(() => undefined);
      return finish({ status: 'requeued', reason: 'worker shutting down', costUsd: 0 }, 'requeued');
    }

    const priced = priceRun(result, perMessage, a.model);
    const failure = timedOut ? `timeout after ${Math.round(timeoutMs / 1000)}s`
      : authError ? authError
      : sdkError ? `SDK error: ${errMsg(sdkError)}`
        : !result ? 'the SDK ended without a result'
          : result.subtype === 'error_during_execution' ? `run failed: ${(result.errors ?? []).join('; ') || 'error during execution'}`
            : result.subtype === 'success' && result.is_error ? `API error${result.api_error_status ? ` ${result.api_error_status}` : ''}: ${result.result}`
              : null;

    const drained = await endLease(failure ? `Claude run ${failure.slice(0, 120)}; HQ took the task back` : 'Claude run ended', drainMs);
    // Claude may have finished or paused the task through the HQ MCP tools.
    const settled = await settledByMcp(task, deps, priced.costUsd);
    if (settled) return finish(settled, settled.status);

    if (failure) {
      const detail = clean(`${failure}${stderrTail.trim() ? ` · ${stderrTail.trim().split('\n').slice(-2).join(' ')}` : ''}`).slice(0, 400);
      if (!drained) {
        const reason = `Claude ${detail}; an HQ tool call of that run was still running, re-queued instead of falling back`.slice(0, 500);
        log(deps, `[${agentId}] ${reason}`);
        await db.requeueTask(task.id, reason).catch(() => undefined);
        return finish({ status: 'requeued', reason, costUsd: priced.costUsd }, 'requeued');
      }
      ended = 'fallback';
      return { fallback: detail };
    }

    const r = result!;
    if (r.subtype === 'error_max_turns') {
      const reason = maxStepsReason(a.limits.maxSteps);
      await db.failTask(task.id, reason);
      return finish({ status: 'failed', reason, costUsd: priced.costUsd }, 'max_turns');
    }
    if (r.subtype === 'error_max_budget_usd') {
      await db.failTask(task.id, taskBudgetReason(a.capUsd, Math.max(priced.costUsd, r.total_cost_usd)));
      return finish({ status: 'budget_exceeded', costUsd: priced.costUsd }, 'budget');
    }
    if (r.subtype !== 'success') {
      const reason = `Claude run stopped: ${r.subtype}`;
      await db.failTask(task.id, reason);
      return finish({ status: 'failed', reason, costUsd: priced.costUsd }, 'failed');
    }
    const final = parseFinalAnswer(r.result);
    if (final.kind === 'empty') {
      const reason = 'Claude ended without submitting output';
      await db.failTask(task.id, reason);
      return finish({ status: 'failed', reason, costUsd: priced.costUsd }, 'failed');
    }
    if (final.kind === 'ask') {
      await db.askCeo(task.id, final.question, final.options);
      return finish({ status: 'asked_ceo', costUsd: priced.costUsd }, 'asked');
    }
    await db.submitTaskOutput(task.id, final.output);
    return finish({ status: 'submitted', costUsd: priced.costUsd, fallback: final.output.fallback === true }, 'submitted');
  } catch (e) {
    const reason = clean(errMsg(e)).slice(0, 500);
    await endLease(`Claude run failed: ${reason}`, drainMs);
    const settled = await settledByMcp(task, deps, 0).catch(() => null);
    if (settled) return finish(settled, settled.status);
    if (!started) { ended = 'fallback'; return { fallback: `could not start: ${reason}` }; }
    await db.failTask(task.id, reason).catch(() => undefined);
    return finish({ status: 'failed', reason, costUsd: 0 }, 'failed');
  } finally {
    clearTimeout(timer);
    clearInterval(heartbeat);
    opts.abortSignal?.removeEventListener('abort', onAbort);
    await endLease(`Claude run ended (${ended})`);
    if (started) {
      const priced = priceRun(result, perMessage, a.model);
      if (priced.usage.inputTokens + priced.usage.outputTokens > 0 || priced.costUsd > 0) {
        deps.recordSpend?.(priced.costUsd);
        const turns = (result as { num_turns?: number } | null)?.num_turns ?? null;
        await db.recordUsage({
          actor: agentId, kind: 'task', taskId: task.id, requestId: task.request_id,
          tokensIn: priced.usage.inputTokens, tokensOut: priced.usage.outputTokens, costUsd: priced.costUsd,
          detail: usageDetail({ provider: 'anthropic', modelId: priced.model }, priced.usage, {
            runtime: 'claude', cost_usd: priced.costUsd, ended, turns, budget_usd: a.capUsd,
            ...(priced.sdkCostUsd !== null ? { sdk_cost_usd: priced.sdkCostUsd } : {}),
            ...(priced.costUsd > a.capUsd ? { over_task_budget: a.capUsd } : {}),
          }),
        }).catch((e) => log(deps, `[${agentId}] usage log failed`, clean(errMsg(e))));
      }
    }
    if (home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ } }
    if (ended !== 'fallback') await db.finishAgentTurn(agentId).catch(() => undefined);
  }
}
