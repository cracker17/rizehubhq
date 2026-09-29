// Model picking + usage meter (docs/14). Wraps the pure router (chooseCandidate) with live
// per-provider request counts and month-to-date spend, and prices token usage.
import { APICallError, RetryError, type LanguageModel, type LanguageModelUsage } from 'ai';
import type { ModelRole } from '@rizehubhq/shared';
import { chooseCandidate, createModel, QuotaExhaustedError, type Candidate, type ModelsConfig, type Provider } from './router';
import { manilaDay, manilaMonth } from '../budget';

/**
 * USD per million tokens. Anthropic prices from docs/14 (Sep 2026): cache writes cost 1.25× input, cache reads 0.1×
 * input (Opus 5.5: 0.05×). `cacheWrite`/`cacheRead` default to the input price when a provider has no cache pricing.
 */
export interface Price { input: number; output: number; cacheRead?: number; cacheWrite?: number }
export const PRICES: { match: RegExp; price: Price }[] = [
  { match: /^claude-opus-5/, price: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 } },
  { match: /^claude-opus/, price: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 } },
  { match: /^claude-sonnet/, price: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 } },
  { match: /^claude-haiku/, price: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 } },
  // OpenAI: PLACEHOLDER tiers, not official prices. Copy the real per-model prices from OpenAI's pricing page
  // before relying on cost numbers for QA (paid profile). OpenAI caches prompts automatically (reads ~0.1× input).
  { match: /nano/, price: { input: 0.1, output: 0.4, cacheRead: 0.01 } },
  { match: /mini/, price: { input: 0.4, output: 1.6, cacheRead: 0.04 } },
  { match: /^gpt-/, price: { input: 2, output: 10, cacheRead: 0.2 } },
];
/** Unknown model on a paid provider: price it like a mid-tier model rather than as free. */
export const FALLBACK_PAID_PRICE: Price = { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 };
export const PAID_PROVIDERS: readonly string[] = ['anthropic', 'openai'];

export function priceFor(provider: string, modelId: string): Price | null {
  if (!PAID_PROVIDERS.includes(provider)) return null; // free tiers (google, groq, openrouter :free) cost 0
  return PRICES.find((p) => p.match.test(modelId))?.price ?? FALLBACK_PAID_PRICE;
}

/**
 * Token usage in one shape for every provider. inputTokens is ALL input (fresh + cache reads + cache writes);
 * cachedInputTokens are cache reads; cacheWriteTokens are tokens written to the prompt cache (Anthropic).
 */
export interface TokenUsage { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; cacheWriteTokens?: number }

type ProviderMetadata = Record<string, Record<string, unknown> | undefined> | undefined;

/**
 * SDK usage → TokenUsage. The Anthropic provider reports inputTokens WITHOUT cache reads/writes (Anthropic's
 * input_tokens); the write count is in providerMetadata.anthropic.cacheCreationInputTokens. OpenAI, Google and
 * Groq already include cached tokens in inputTokens.
 */
export function normalizeUsage(provider: string, usage: Partial<LanguageModelUsage> | undefined, providerMetadata?: ProviderMetadata): TokenUsage {
  const input = usage?.inputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  const read = usage?.cachedInputTokens ?? 0;
  if (provider === 'anthropic') {
    const write = Number(providerMetadata?.anthropic?.cacheCreationInputTokens ?? 0) || 0;
    return { inputTokens: input + read + write, outputTokens: output, cachedInputTokens: read, cacheWriteTokens: write };
  }
  return { inputTokens: input, outputTokens: output, cachedInputTokens: Math.min(read, input), cacheWriteTokens: 0 };
}

/** Cost of normalized usage (TokenUsage: inputTokens includes cache reads and writes). */
export function costUsd(provider: string, modelId: string, usage: TokenUsage): number {
  const p = priceFor(provider, modelId);
  if (!p) return 0;
  const input = usage.inputTokens ?? 0;
  const read = Math.min(usage.cachedInputTokens ?? 0, input);
  const write = Math.min(usage.cacheWriteTokens ?? 0, input - read);
  const fresh = input - read - write;
  const output = usage.outputTokens ?? 0;
  const usd = (fresh * p.input + read * (p.cacheRead ?? p.input) + write * (p.cacheWrite ?? p.input) + output * p.output) / 1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}

export interface PickedModel {
  model: LanguageModel;
  provider: string;
  modelId: string;
  /** Records one model call (a step): SDK usage + the call's providerMetadata (cache writes). Returns the cost in USD. */
  recordCall(usage: Partial<LanguageModelUsage>, providerMetadata?: ProviderMetadata): number;
}

export type PickModel = (role: ModelRole, opts?: { override?: string | null }) => Promise<PickedModel>;

/**
 * True for "try later / another provider" errors: router has no quota, the provider said 429, or the provider no
 * longer serves this model (404, e.g. a retired Gemini ID). The caller then falls back to the next model in the list.
 */
export function isQuotaError(e: unknown, depth = 0): boolean {
  if (!e || depth > 4) return false;
  if (e instanceof QuotaExhaustedError) return true;
  if (APICallError.isInstance(e) && (e.statusCode === 429 || e.statusCode === 404)) return true;
  if (RetryError.isInstance(e)) return isQuotaError(e.lastError, depth + 1);
  const cause = (e as { cause?: unknown }).cause;
  return cause ? isQuotaError(cause, depth + 1) : false;
}


export interface ModelPickerOptions {
  cfg: ModelsConfig;
  profile?: string;
  env: Record<string, string | undefined>;
  monthlyBudgetUsd: number;
  spentThisMonthUsd?: number;
  create?: (c: Candidate) => Promise<LanguageModel>;
  /** Month-to-date spend from the DB (Asia/Manila month). Re-read every refreshEveryMs and right after a month change. */
  monthSpend?: () => Promise<number>;
  refreshEveryMs?: number;
  now?: () => Date;
  /** DAILY_AI_BUDGET_USD (null / 0 = no cap). Once today's spend reaches it, paid providers stop (free profile fallback). */
  dailyBudgetUsd?: number | null;
}

/** What the worker loop learned about today's total spend (GlobalDailyBudget.check()). */
export interface DailySpendUpdate { day: string; spentUsd: number; budgetUsd: number | null }

export class ModelPicker {
  private day: string;
  private month: string;
  private refreshedAt: number;
  private requestsToday: Partial<Record<Provider, number>> = {};
  spentThisMonthUsd: number;
  /** Today's (Asia/Manila) spend across all agents: loop updates + every call this process records. */
  spentTodayUsd = 0;
  dailyBudgetUsd: number | null;

  constructor(private opts: ModelPickerOptions) {
    const now = this.now();
    this.day = manilaDay(now);
    this.month = manilaMonth(now);
    this.refreshedAt = now.getTime();
    this.spentThisMonthUsd = opts.spentThisMonthUsd ?? 0;
    this.dailyBudgetUsd = opts.dailyBudgetUsd ?? null;
  }

  /** True when the daily AI budget is used up: paid providers are skipped until the next Manila day. */
  get paidBlocked(): boolean {
    this.rollDay();
    const b = this.dailyBudgetUsd;
    return b !== null && Number.isFinite(b) && b > 0 && this.spentTodayUsd >= b;
  }

  /** Feeds today's DB total (and the resolved cap) from the loop's budget check. Never lowers today's figure. */
  setDailySpend(u: DailySpendUpdate): void {
    this.rollDay();
    this.dailyBudgetUsd = u.budgetUsd;
    if (u.day === this.day && Number.isFinite(u.spentUsd)) this.spentTodayUsd = Math.max(this.spentTodayUsd, u.spentUsd);
  }

  private now() { return this.opts.now?.() ?? new Date(); }

  private rollDay() {
    const now = this.now();
    const d = manilaDay(now);
    if (d !== this.day) { this.day = d; this.requestsToday = {}; this.spentTodayUsd = 0; }
    const m = manilaMonth(now);
    if (m !== this.month) { this.month = m; this.spentThisMonthUsd = 0; this.refreshedAt = -Infinity; } // new budget month
  }

  /** Re-reads month-to-date spend from the DB. Never lowers the in-memory figure within the same month
   * (costs of running tasks are only written to the DB when the task ends). */
  async refreshSpend(): Promise<void> {
    if (!this.opts.monthSpend) return;
    const month = this.month;
    this.refreshedAt = this.now().getTime();
    const v = await this.opts.monthSpend();
    if (month === this.month && Number.isFinite(v)) this.spentThisMonthUsd = Math.max(this.spentThisMonthUsd, v);
  }

  /** After a provider 429, treat its daily cap as used so the router falls back. */
  markExhausted(provider: string) {
    const cap = this.opts.cfg.daily_request_caps[provider] ?? 1_000_000;
    this.requestsToday[provider as Provider] = cap;
  }

  pick: PickModel = async (role, o = {}) => {
    this.rollDay();
    if (this.opts.monthSpend && this.now().getTime() - this.refreshedAt >= (this.opts.refreshEveryMs ?? 5 * 60_000)) {
      await this.refreshSpend().catch(() => undefined); // keep the last known figure if the DB is unreachable
    }
    const c = chooseCandidate(role, this.opts.cfg, {
      profile: this.opts.profile, env: this.opts.env, monthlyBudgetUsd: this.opts.monthlyBudgetUsd, override: o.override ?? null,
      paidBlocked: this.paidBlocked,
      usage: { requestsToday: this.requestsToday, spentThisMonthUsd: this.spentThisMonthUsd },
    });
    const model = await (this.opts.create ?? createModel)(c);
    return {
      model, provider: c.provider, modelId: c.modelId,
      recordCall: (usage, providerMetadata) => {
        this.rollDay();
        this.requestsToday[c.provider] = (this.requestsToday[c.provider] ?? 0) + 1;
        const usd = costUsd(c.provider, c.modelId, normalizeUsage(c.provider, usage, providerMetadata));
        this.spentThisMonthUsd += usd;
        this.spentTodayUsd += usd;
        return usd;
      },
    };
  };
}

/** Sums normalized usage (undefined counts as 0). */
export function addUsage(a: TokenUsage, b: TokenUsage): Required<TokenUsage> {
  return {
    inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
    cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0),
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
  };
}
