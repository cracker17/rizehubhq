// When Claude is unavailable (docs/17-OPERATOR.md "Fallback model"): the operator keeps drafting replies, and runs
// small jobs, on another provider from config/models.yaml (default: Groq), never a hard-coded model (docs/14). Same
// tiers, approvals and pauses; only the model changes. Julev's voice: his own sent messages are given to every model
// (Claude or the fallback) so drafts sound like him either way.
//
//   OPERATOR_FALLBACK=on|off            default on
//   OPERATOR_FALLBACK_PROVIDERS         providers allowed as fallback, comma-separated (default groq)
//   OPERATOR_FALLBACK_ROLE              the models.yaml role whose list is searched (default specialist)
//   OPERATOR_FALLBACK_JOBS=on|off       jobs too (default on; a step cap keeps them small)
//   OPERATOR_FALLBACK_MAX_STEPS         tool steps per fallback job run (default 24)
//   OPERATOR_FALLBACK_MAX_USD_PER_DAY   spend cap of the fallback per Manila day (default 1)
import { generateObject, generateText, stepCountIs, tool, type LanguageModel, type ToolSet } from 'ai';
import { z } from 'zod';
import type { ModelRole } from '@rizehubhq/shared';
import { FREE_FALLBACK_PROFILE, KEY_ENV, parseCandidate, profileSpecs, roleSpecs, type Candidate, type ModelsConfig } from 'worker/src/models/router';
import { costUsd, normalizeUsage } from 'worker/src/models/usage';
import type { ClassifyOutcome } from './classify';
import { ClassifyError } from './classify';
import { parseResult, ResultSchema, SYSTEM_PROMPT } from './prompt';
import { classifyEnd, type JobRunOutcome } from './jobs/runner';
import type { RunEnd, ToolSpec } from './jobs/tools';

type Env = Readonly<Record<string, string | undefined>>;

// ---------- Julev's voice ----------

/** His recent messages as style examples (newest first in, oldest first out; short, deduplicated, clipped). */
export function voiceSection(messages: string[], max = 12): string {
  const seen = new Set<string>();
  const picked: string[] = [];
  for (const m of messages) {
    const t = m.replace(/\s+/g, ' ').trim();
    if (t.length < 4 || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    picked.push(t.length > 300 ? `${t.slice(0, 300)}…` : t);
    if (picked.length >= max) break;
  }
  if (!picked.length) return '';
  return `HOW JULEV WRITES (his own recent messages to this client; match his tone, length, greetings and wording; do not copy facts from them):\n<data>\n${picked.reverse().map((t) => `- ${t}`).join('\n')}\n</data>`;
}

// ---------- which model ----------

export interface FallbackConfig { enabled: boolean; providers: string[]; role: ModelRole; jobs: boolean; maxSteps: number; maxUsdPerDay: number }

/** The first fallback model with its key set: the role's specs in the active profile, then the free profile. */
export function fallbackCandidate(o: { env: Env; cfg: ModelsConfig; role: ModelRole; providers: string[]; profile?: string }): Candidate | null {
  const specs = [...roleSpecs(o.role, o.cfg, { env: o.env, profile: o.profile }), ...(o.cfg.profiles[FREE_FALLBACK_PROFILE] ? profileSpecs(o.cfg.profiles[FREE_FALLBACK_PROFILE]!, o.role) : [])];
  for (const spec of [...new Set(specs)]) {
    let c: Candidate;
    try { c = parseCandidate(spec); } catch { continue; }
    if (c.provider === 'anthropic' || !o.providers.includes(c.provider)) continue;
    if (!o.env[KEY_ENV[c.provider]]?.trim()) continue;
    return c;
  }
  return null;
}

/** Errors that mean "Claude is out" (credit, key, quota, overload), not "this message was hard". */
export function isClaudeOutage(message: string): boolean {
  return /credit balance|insufficient (credit|funds|quota)|billing|quota|rate.?limit|overloaded|\b(401|402|403|429|529)\b|invalid x-api-key|authentication|monthly AI budget|ANTHROPIC_API_KEY is not set|rejected the key/i.test(message);
}

/** Remembers that Claude is out (for 30 minutes per failure) and says so once; then tries Claude again. */
export class FallbackSwitch {
  private downUntil = 0;
  private reason = '';
  private announced = false;
  constructor(private now: () => number = Date.now) {}
  markDown(reason: string, ms = 30 * 60_000) { this.downUntil = this.now() + ms; this.reason = reason.slice(0, 300); }
  isDown() { return this.now() < this.downUntil; }
  get why() { return this.reason; }
  /** true once per outage: the moment to send the Telegram notice. */
  shouldAnnounce() { if (this.announced) return false; this.announced = true; return true; }
  /** Claude answered again: true when an outage was announced (send "Claude is back"). */
  restored() { const was = this.announced; this.downUntil = 0; this.announced = false; return was; }
}

export const fallbackModelId = (c: Candidate) => `fallback:${c.provider}:${c.modelId}`;
export function parseFallbackId(model: string): Candidate | null {
  const m = /^fallback:([a-z]+):(.+)$/.exec(model);
  return m ? { provider: m[1] as Candidate['provider'], modelId: m[2]! } : null;
}

// ---------- classify + draft ----------

export async function classifyFallback(o: { model: LanguageModel; c: Candidate; prompt: string; generate?: typeof generateObject }): Promise<ClassifyOutcome> {
  const gen = o.generate ?? generateObject;
  const label = `${o.c.provider}:${o.c.modelId}`;
  try {
    const res = await gen({ model: o.model, schema: ResultSchema, schemaName: 'operator_draft', system: SYSTEM_PROMPT, prompt: o.prompt, maxRetries: 1 });
    const usage = normalizeUsage(o.c.provider, res.usage, res.providerMetadata);
    return { result: parseResult(res.object), costUsd: costUsd(o.c.provider, o.c.modelId, usage), tokensIn: usage.inputTokens ?? 0, tokensOut: usage.outputTokens ?? 0, model: label };
  } catch (e) {
    throw new ClassifyError(`${label}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500), 0, 0, 0, label);
  }
}

// ---------- jobs ----------

/** The operator's job tools as AI SDK tools (text out; screenshots stay in the evidence, the model gets a note). */
export function toAiTools(specs: ToolSpec[]): ToolSet {
  const out: ToolSet = {};
  for (const s of specs) {
    out[s.name] = tool({
      description: s.description,
      inputSchema: z.object(s.shape),
      execute: async (args: unknown) => {
        const r = await s.run(args);
        const text = r.content.map((c) => (c.type === 'text' ? c.text : '[screenshot saved to the job evidence]')).join('\n');
        return r.isError ? `ERROR: ${text}` : text;
      },
    });
  }
  return out;
}

export async function runJobFallback(o: {
  model: LanguageModel; c: Candidate; prompt: string; systemPrompt: string; tools: ToolSpec[]; ended: () => RunEnd | null;
  maxSteps: number; timeoutMs?: number; generate?: typeof generateText;
}): Promise<JobRunOutcome> {
  const gen = o.generate ?? generateText;
  const label = `${o.c.provider}:${o.c.modelId}`;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, o.timeoutMs ?? 20 * 60_000);
  try {
    const res = await gen({
      model: o.model, system: `${o.systemPrompt}\n\nYou run on a smaller backup model: keep the job small, use few steps, and call finish (or wait_for_approvals) as soon as you can.`,
      prompt: o.prompt, tools: toAiTools(o.tools), stopWhen: [stepCountIs(o.maxSteps), () => !!o.ended()], abortSignal: ctrl.signal, maxRetries: 1,
    });
    const usage = normalizeUsage(o.c.provider, res.totalUsage ?? res.usage, res.providerMetadata);
    const end = o.ended();
    const c = classifyEnd(end, { subtype: end ? 'success' : res.steps.length >= o.maxSteps ? 'error_max_turns' : 'success' });
    return { ...c, end, costUsd: costUsd(o.c.provider, o.c.modelId, usage), tokensIn: usage.inputTokens ?? 0, tokensOut: usage.outputTokens ?? 0, model: label, turns: res.steps.length };
  } catch (e) {
    const end = o.ended();
    const c = classifyEnd(end, { error: timedOut ? null : `${label}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 400), timedOut });
    return { ...c, end, costUsd: 0, tokensIn: 0, tokensOut: 0, model: label, turns: null };
  } finally {
    clearTimeout(timer);
  }
}

export function loadFallbackConfig(env: Env, roles: readonly string[]): FallbackConfig {
  const off = (v: string | undefined) => ['0', 'false', 'off', 'no'].includes((v ?? '').trim().toLowerCase());
  const role = (env.OPERATOR_FALLBACK_ROLE ?? '').trim();
  const steps = Number(env.OPERATOR_FALLBACK_MAX_STEPS);
  const usd = Number(env.OPERATOR_FALLBACK_MAX_USD_PER_DAY);
  const providers = (env.OPERATOR_FALLBACK_PROVIDERS ?? 'groq').split(',').map((s) => s.trim().toLowerCase()).filter((p) => p && p !== 'anthropic');
  return {
    enabled: !off(env.OPERATOR_FALLBACK),
    providers: providers.length ? providers : ['groq'],
    role: (roles.includes(role) ? role : 'specialist') as ModelRole,
    jobs: !off(env.OPERATOR_FALLBACK_JOBS),
    maxSteps: Number.isFinite(steps) && steps >= 4 ? Math.min(Math.round(steps), 60) : 24,
    maxUsdPerDay: Number.isFinite(usd) && usd >= 0 ? usd : 1,
  };
}

// ---------- the switch (pure, tested) ----------

type GateOk = { ok: true; model: string; apiKey: string; capUsd: number };
type GateNo = { ok: false; reason: string };

/**
 * Claude's own gate + whether Claude is marked down + the fallback settings → the gate the loop uses, and what to
 * announce. Claude wins whenever it is usable; the fallback only covers an outage, a missing key / budget for Claude,
 * and (jobs) only when OPERATOR_FALLBACK_JOBS is on; it has its own daily cap.
 */
export function chooseGate(o: {
  claude: GateOk | GateNo; claudeDown: boolean; kind: 'message' | 'job'; cfg: FallbackConfig; candidate: Candidate | null;
  fallbackSpentTodayUsd: number; capUsd: number;
}): { gate: GateOk | GateNo; event: 'fallback' | 'restored' | null; reason: string } {
  if (o.claude.ok && !o.claudeDown) return { gate: o.claude, event: 'restored', reason: '' };
  const why = o.claude.ok ? 'Claude returned an outage error' : o.claude.reason;
  const no = (reason: string) => ({ gate: { ok: false as const, reason }, event: null, reason: why });
  if (!o.cfg.enabled) return no(`${why} (fallback off: OPERATOR_FALLBACK)`);
  if (o.kind === 'job' && !o.cfg.jobs) return no(`${why}; jobs wait for Claude (OPERATOR_FALLBACK_JOBS=off)`);
  if (!o.candidate) return no(`${why}; no fallback model (set GROQ_API_KEY, or OPERATOR_FALLBACK_PROVIDERS)`);
  const left = o.cfg.maxUsdPerDay - o.fallbackSpentTodayUsd;
  if (left <= 0 && o.cfg.maxUsdPerDay > 0) return no(`${why}; the fallback's daily cap ($${o.cfg.maxUsdPerDay}) is used up`);
  const cap = o.cfg.maxUsdPerDay > 0 ? Math.min(o.capUsd, left) : o.capUsd;
  return { gate: { ok: true, model: fallbackModelId(o.candidate), apiKey: '', capUsd: Math.round(cap * 100) / 100 }, event: 'fallback', reason: why };
}
