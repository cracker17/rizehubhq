// Classify + draft one message with the Claude Agent SDK (docs/17-OPERATOR.md "Classifier"). One short, tool-less run:
// no Claude Code tools, no MCP, no settings files, a throwaway HOME, structured output (outputFormat json_schema), and a
// hard spend cap (maxBudgetUsd = the smaller of OPERATOR_MAX_USD_PER_MESSAGE and what the month / day have left).
// The Claude Code process gets only harmless env + the API key (claudeProcessEnv from the worker). Cost is priced with
// HQ's own table and recorded as usage.operator, so the dashboard budget and /budget count it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Options, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeProcessEnv, priceRun, redact } from 'worker/src/claude/runner';
import { parseResult, RESULT_JSON_SCHEMA, SYSTEM_PROMPT, type ClassifyResult } from './prompt';

type Env = Readonly<Record<string, string | undefined>>;
export type QueryFn = (p: { prompt: string; options: Options }) => AsyncIterable<SDKMessage> & { close?: () => void };

export interface ClassifyRun {
  prompt: string;
  model: string;
  apiKey: string;
  capUsd: number;
  env: Env;
  timeoutMs?: number;
  query?: QueryFn;
}

export interface ClassifyOutcome {
  result: ClassifyResult;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  model: string;
}

export class ClassifyError extends Error {
  constructor(message: string, readonly costUsd = 0, readonly tokensIn = 0, readonly tokensOut = 0, readonly model = '') { super(message); }
}

let realQuery: QueryFn | null = null;
async function defaultQuery(): Promise<QueryFn> {
  if (!realQuery) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    realQuery = (p) => sdk.query(p);
  }
  return realQuery;
}

export async function classifyMessage(r: ClassifyRun): Promise<ClassifyOutcome> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-operator-'));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), r.timeoutMs ?? 120_000);
  let result: SDKResultMessage | null = null;
  const perMessage = new Map<string, { model: string; usage: Record<string, unknown> }>();
  let stderrTail = '';
  try {
    const options: Options = {
      cwd: home,
      systemPrompt: SYSTEM_PROMPT,
      model: r.model,
      tools: [],                 // no Claude Code tools at all: this run only reads the prompt and answers
      allowedTools: [],
      permissionMode: 'dontAsk',
      permissionPrompts: 'none',
      maxTurns: 3,               // the structured answer may take a retry turn
      maxBudgetUsd: r.capUsd,
      outputFormat: { type: 'json_schema', schema: RESULT_JSON_SCHEMA as unknown as Record<string, unknown> },
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      persistSession: false,
      skills: [],
      env: claudeProcessEnv(r.apiKey, home, r.env),
      abortController: ctrl,
      stderr: (d: string) => { stderrTail = (stderrTail + d).slice(-2000); },
    };
    const q = (r.query ?? await defaultQuery())({ prompt: r.prompt, options });
    try {
      for await (const m of q) {
        if (m.type === 'assistant') {
          const msg = m.message as unknown as { id?: string; model?: string; usage?: Record<string, unknown> };
          if (msg.id && msg.usage) perMessage.set(msg.id, { model: msg.model ?? r.model, usage: msg.usage });
        } else if (m.type === 'result') {
          result = m;
        }
      }
    } finally { q.close?.(); }
  } catch (e) {
    const priced = priceRun(result, perMessage, r.model);
    const msg = ctrl.signal.aborted ? 'timed out' : redact(e instanceof Error ? e.message : String(e), [r.apiKey]);
    throw new ClassifyError(`Claude run failed: ${msg}${stderrTail ? ` (${redact(stderrTail.slice(-300), [r.apiKey])})` : ''}`,
      priced.costUsd, priced.usage.inputTokens, priced.usage.outputTokens, priced.model);
  } finally {
    clearTimeout(timer);
    fs.rmSync(home, { recursive: true, force: true });
  }

  const priced = priceRun(result, perMessage, r.model);
  const fail = (why: string) => new ClassifyError(why, priced.costUsd, priced.usage.inputTokens, priced.usage.outputTokens, priced.model);
  if (!result) throw fail('Claude run ended without a result');
  const res = result as SDKResultMessage & { structured_output?: unknown };
  if (res.subtype !== 'success') throw fail(`Claude run stopped: ${res.subtype}`);
  let parsed: ClassifyResult;
  try {
    parsed = parseResult(res.structured_output ?? JSON.parse(String((res as { result?: string }).result ?? '')));
  } catch (e) {
    throw fail(`unusable answer: ${e instanceof Error ? e.message.slice(0, 300) : 'parse error'}`);
  }
  return { result: parsed, costUsd: priced.costUsd, tokensIn: priced.usage.inputTokens, tokensOut: priced.usage.outputTokens, model: priced.model };
}
