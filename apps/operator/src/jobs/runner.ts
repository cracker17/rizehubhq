// One run of a job with the Claude Agent SDK (docs/17-OPERATOR.md "Worker mode"): a multi-turn agent whose ONLY tools
// are the operator's own, served in-process (createSdkMcpServer → tool ids mcp__op__<name>). Claude Code's built-in
// tools (Bash, files, web, subagents) are off, a PreToolUse hook denies anything that is not mcp__op__*, no settings
// files, no MCP config, a throwaway HOME, the spend cap of the run (maxBudgetUsd) and a wall-clock timeout. Cost is
// priced with HQ's own table, like the classifier.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HookCallback, Options, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeProcessEnv, priceRun, redact } from 'worker/src/claude/runner';
import type { RunEnd, ToolSpec } from './tools';

type Env = Readonly<Record<string, string | undefined>>;
export type QueryFn = (p: { prompt: string; options: Options }) => AsyncIterable<SDKMessage> & { close?: () => void };
type Sdk = Pick<typeof import('@anthropic-ai/claude-agent-sdk'), 'query' | 'tool' | 'createSdkMcpServer'>;

export const OP_SERVER = 'op';
export const opToolId = (name: string) => `mcp__${OP_SERVER}__${name}`;

export interface JobRun {
  prompt: string;
  systemPrompt: string;
  tools: ToolSpec[];
  /** Read after the run: what finish / wait_for_approvals recorded. */
  ended: () => RunEnd | null;
  model: string;
  apiKey: string;
  capUsd: number;
  env: Env;
  maxTurns?: number;
  timeoutMs?: number;
  sdk?: Sdk;
}

export interface JobRunOutcome {
  outcome: 'finished' | 'waiting' | 'blocked' | 'error';
  end: RunEnd | null;
  error: string | null;
  costUsd: number; tokensIn: number; tokensOut: number; model: string; turns: number | null;
}

let realSdk: Sdk | null = null;
async function loadSdk(): Promise<Sdk> {
  if (!realSdk) realSdk = await import('@anthropic-ai/claude-agent-sdk');
  return realSdk;
}

/** Where a run ended, from what the tools recorded and how the SDK stopped (pure, tested). */
export function classifyEnd(end: RunEnd | null, sdk: { subtype?: string | null; isError?: boolean; error?: string | null; timedOut?: boolean }): Pick<JobRunOutcome, 'outcome' | 'error'> {
  if (end?.kind === 'finished') return end.finish.status === 'blocked' ? { outcome: 'blocked', error: end.finish.needs_from_julev || end.finish.summary } : { outcome: 'finished', error: null };
  if (end?.kind === 'waiting') return { outcome: 'waiting', error: null };
  if (sdk.timedOut) return { outcome: 'error', error: 'the run timed out before finish' };
  if (sdk.error) return { outcome: 'error', error: sdk.error };
  if (sdk.subtype === 'error_max_turns') return { outcome: 'error', error: 'used all its turns before finish (split the task or continue)' };
  if (sdk.subtype === 'error_max_budget_usd') return { outcome: 'error', error: 'hit the spend cap of one run before finish' };
  if (sdk.subtype && sdk.subtype !== 'success') return { outcome: 'error', error: `run stopped: ${sdk.subtype}` };
  if (sdk.isError) return { outcome: 'error', error: 'API error' };
  return { outcome: 'error', error: 'ended without calling finish' };
}

export async function runJobAgent(r: JobRun): Promise<JobRunOutcome> {
  const sdk = r.sdk ?? await loadSdk();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-opjob-'));
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, r.timeoutMs ?? 30 * 60_000);
  let result: SDKResultMessage | null = null;
  const perMessage = new Map<string, { model: string; usage: Record<string, unknown> }>();
  let stderrTail = '';
  let sdkError: string | null = null;
  const allowed = new Set(r.tools.map((t) => opToolId(t.name)));
  try {
    const server = sdk.createSdkMcpServer({
      name: OP_SERVER, version: '1.0.0', alwaysLoad: true, timeout: 15 * 60_000,
      tools: r.tools.map((t) => sdk.tool(t.name, t.description, t.shape, async (args: unknown) => (await t.run(args)) as never)),
    });
    const deny = (why: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: why } });
    const preToolUse: HookCallback = async (input) => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      return allowed.has(input.tool_name) ? {} : deny(`${input.tool_name} is not available. Use the ${opToolId('…')} tools.`);
    };
    const options: Options = {
      cwd: home,
      systemPrompt: r.systemPrompt,
      model: r.model,
      tools: [],
      allowedTools: [...allowed],
      disallowedTools: ['Bash', 'BashOutput', 'KillShell', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'NotebookEdit', 'Skill'],
      permissionMode: 'dontAsk',
      permissionPrompts: 'none',
      maxTurns: r.maxTurns ?? 80,
      maxBudgetUsd: r.capUsd,
      mcpServers: { [OP_SERVER]: server },
      strictMcpConfig: true,
      settingSources: [],
      persistSession: false,
      skills: [],
      env: claudeProcessEnv(r.apiKey, home, r.env),
      abortController: ctrl,
      hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
      stderr: (d: string) => { stderrTail = (stderrTail + d).slice(-3000); },
    };
    const q = (sdk.query as QueryFn)({ prompt: r.prompt, options });
    try {
      for await (const m of q) {
        if (m.type === 'assistant' && !m.parent_tool_use_id) {
          const msg = m.message as unknown as { id?: string; model?: string; usage?: Record<string, unknown> };
          if (msg.id && msg.usage) perMessage.set(msg.id, { model: msg.model ?? r.model, usage: msg.usage });
        } else if (m.type === 'system' && m.subtype === 'api_retry' && (m.error_status === 401 || m.error_status === 403)) {
          sdkError = `Anthropic API rejected the key (HTTP ${m.error_status})`;
          break;
        } else if (m.type === 'result') {
          result = m;
          break;
        }
      }
    } finally { try { q.close?.(); } catch { /* gone */ } }
  } catch (e) {
    if (!timedOut) sdkError = redact(e instanceof Error ? e.message : String(e), [r.apiKey]).slice(0, 400) + (stderrTail ? ` (${redact(stderrTail.slice(-200), [r.apiKey])})` : '');
  } finally {
    clearTimeout(timer);
    fs.rmSync(home, { recursive: true, force: true });
  }
  const priced = priceRun(result, perMessage, r.model);
  const res = result as (SDKResultMessage & { is_error?: boolean; num_turns?: number }) | null;
  const c = classifyEnd(r.ended(), { subtype: res?.subtype ?? null, isError: res?.is_error === true, error: sdkError ?? (res ? null : timedOut ? null : 'the SDK ended without a result'), timedOut });
  return { ...c, end: r.ended(), costUsd: priced.costUsd, tokensIn: priced.usage.inputTokens, tokensOut: priced.usage.outputTokens, model: priced.model, turns: res?.num_turns ?? null };
}
