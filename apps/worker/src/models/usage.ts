// Model picking + usage meter (docs/14). Wraps the pure router (chooseCandidate) with live
// per-provider request counts and month-to-date spend, and prices token usage.
import { APICallError, RetryError, type LanguageModel, type LanguageModelUsage } from 'ai';
import type { ModelRole } from '@rizehubhq/shared';
import { chooseCandidate, createModel, isPaidSpec, QuotaExhaustedError, type Candidate, type ModelsConfig, type Provider } from './router';
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
  // Moonshot (Kimi), verified 2026-09-29 on platform.kimi.ai (pricing/chat). Automatic context caching, no write fee.
  { match: /^kimi-k3/, price: { input: 3, output: 15, cacheRead: 0.3 } },
  { match: /^kimi-k2\.7-code/, price: { input: 0.95, output: 4, cacheRead: 0.19 } },
  { match: /^kimi-k2\.6/, price: { input: 0.95, output: 4, cacheRead: 0.16 } },
  // OpenAI: PLACEHOLDER tiers, not official prices. Copy the real per-model prices from OpenAI's pricing page
  // before relying on cost numbers for QA (paid profile). OpenAI caches prompts automatically (reads ~0.1× input).
  // "-nano" / "-mini" as a word part only, so "gemini" (e.g. openrouter google/gemini-…) is not priced as a mini model.
  { match: /(^|-)nano\b/, price: { input: 0.1, output: 0.4, cacheRead: 0.01 } },
  { match: /(^|-)mini\b/, price: { input: 0.4, output: 1.6, cacheRead: 0.04 } },
  { match: /^gpt-/, price: { input: 2, output: 10, cacheRead: 0.2 } },
];
/** Unknown model on a paid provider (or a paid OpenRouter model): price it like a mid-tier model rather than as free. */
export const FALLBACK_PAID_PRICE: Price = { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 };
export { PAID_PROVIDERS } from './router';

/**
 * Price of a model, or null when it is free: Google/Groq free tiers and OpenRouter `:free` models cost 0. Paid models
 * (isPaidSpec) use PRICES, else FALLBACK_PAID_PRICE. OpenRouter IDs are matched without their vendor prefix
 * (anthropic/claude-sonnet-5 → claude-sonnet-5), so a known model gets its own price.
 */
export function priceFor(provider: string, modelId: string): Price | null {
  if (!isPaidSpec(provider, modelId)) return null;
  const id = provider === 'openrouter' ? modelId.slice(modelId.indexOf('/') + 1) : modelId;
  return PRICES.find((p) => p.match.test(id))?.price ?? FALLBACK_PAID_PRICE;
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

/** Provider-side hiccups that clear on their own: overloaded ("high demand", Gemini 503; Anthropic 529) or a 5xx. */
export const TRANSIENT_STATUSES: readonly number[] = [500, 502, 503, 504, 529];
/** How long a model is skipped after a transient error before the router tries it again. */
export const TRANSIENT_BLOCK_MS = 10 * 60_000;
/** How long a model is skipped after a per-minute rate limit (429 without a daily quota in the message). */
export const RATE_LIMIT_BLOCK_MS = 2 * 60_000;
/** A 429 about a daily quota (Gemini "…PerDay…" / free-tier requests, Groq RPD/TPD, OpenRouter free-models-per-day). */
const DAILY_QUOTA = /per.?day|daily|\bRPD\b|\bTPD\b|free_tier_requests|free-models-per-day/i;

/**
 * True for "try later / another provider" errors: router has no quota, the provider said 429, or the provider no
 * longer serves this model (404, e.g. a retired Gemini ID), or the request is over its per-minute size cap (413, e.g.
 * Groq free tier: 8k tokens/min), or the model is overloaded / erroring (TRANSIENT_STATUSES, after the SDK's own
 * retries). The caller then falls back to the next model in the list.
 */
export function isQuotaError(e: unknown, depth = 0): boolean {
  if (!e || depth > 4) return false;
  if (e instanceof QuotaExhaustedError) return true;
  if (APICallError.isInstance(e) && (e.statusCode === 429 || e.statusCode === 404 || e.statusCode === 413 || TRANSIENT_STATUSES.includes(e.statusCode ?? 0))) return true;
  if (RetryError.isInstance(e)) return isQuotaError(e.lastError, depth + 1);
  const cause = (e as { cause?: unknown }).cause;
  return cause ? isQuotaError(cause, depth + 1) : false;
}

/** The provider's APICallError behind e (through RetryError / cause chains), or null. */
function providerError(e: unknown, depth = 0): InstanceType<typeof APICallError> | null {
  if (!e || depth > 4) return null;
  if (APICallError.isInstance(e)) return e;
  if (RetryError.isInstance(e)) return providerError(e.lastError, depth + 1);
  const cause = (e as { cause?: unknown }).cause;
  return cause ? providerError(cause, depth + 1) : null;
}

/** HTTP status of the provider error behind e (through RetryError / cause chains), or null. */
export function providerStatus(e: unknown): number | null {
  return providerError(e)?.statusCode ?? null;
}

/**
 * How long to skip just the failing model (the provider's other models still work), or null to block the provider.
 * Free-tier limits are per model (Gemini: 20 requests/day each; Groq: per-model TPM/RPD), so every provider error
 * with a status blocks only that model:
 * 404 (retired) and 413 (over the per-minute size cap, e.g. Groq's 8k TPM on a long agent loop) → rest of the day;
 * 429 → rest of the day when the message names a daily quota, else RATE_LIMIT_BLOCK_MS; overloaded / 5xx →
 * TRANSIENT_BLOCK_MS. No provider status (e.g. the router itself had nothing) → null.
 */
export function modelBlock(e: unknown): 'day' | number | null {
  const err = providerError(e);
  const s = err?.statusCode ?? null;
  if (s === 404 || s === 413) return 'day';
  if (s === 429) return DAILY_QUOTA.test(`${err?.message ?? ''} ${err?.responseBody ?? ''}`) ? 'day' : RATE_LIMIT_BLOCK_MS;
  if (s !== null && TRANSIENT_STATUSES.includes(s)) return TRANSIENT_BLOCK_MS;
  return null;
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
  /** provider:model → epoch ms until which the router skips it (Infinity = rest of the Manila day). */
  private blockedModels = new Map<string, number>();
  spentThisMonthUsd: number;
  /** Today's (Asia/Manila) spend across all agents: loop updates + every call this process records. */
  spentTodayUsd = 0;
  dailyBudgetUsd: number | null;

  private opts: ModelPickerOptions;

  constructor(opts: ModelPickerOptions) {
    this.opts = { ...opts }; // configure() changes this copy, never the caller's object
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

  /**
   * Applies the CEO's dashboard settings (settings/runtime.ts, every ~60 s and on /settings/reload): profile, monthly
   * budget, and the env the router checks keys and MODEL_ID_<ROLE> in. Takes effect on the next pick; running calls
   * keep the model they have.
   */
  configure(u: { profile?: string; monthlyBudgetUsd?: number; env?: Record<string, string | undefined>; dailyBudgetUsd?: number | null }): void {
    if (u.profile !== undefined) {
      if (!this.opts.cfg.profiles[u.profile]) throw new Error(`Unknown model profile "${u.profile}"`);
      this.opts.profile = u.profile;
    }
    if (u.monthlyBudgetUsd !== undefined && Number.isFinite(u.monthlyBudgetUsd)) this.opts.monthlyBudgetUsd = u.monthlyBudgetUsd;
    if (u.env) this.opts.env = u.env;
    if (u.dailyBudgetUsd !== undefined) this.dailyBudgetUsd = u.dailyBudgetUsd;
  }

  /** The active profile and monthly budget (after configure()). */
  get settings(): { profile: string; monthlyBudgetUsd: number } {
    return { profile: this.opts.profile ?? this.opts.cfg.active_profile, monthlyBudgetUsd: this.opts.monthlyBudgetUsd };
  }

  /** Which model a role would get right now (no model is created, nothing is counted). */
  preview(role: ModelRole, override?: string | null): { provider: string; modelId: string } | { error: string } {
    this.rollDay();
    try {
      const c = chooseCandidate(role, this.opts.cfg, {
        profile: this.opts.profile, env: this.opts.env, monthlyBudgetUsd: this.opts.monthlyBudgetUsd, override: override ?? null,
        paidBlocked: this.paidBlocked,
        usage: { requestsToday: this.requestsToday, spentThisMonthUsd: this.spentThisMonthUsd, blockedModels: this.activeBlocks() },
      });
      return { provider: c.provider, modelId: c.modelId };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
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
    if (d !== this.day) { this.day = d; this.requestsToday = {}; this.blockedModels = new Map(); this.spentTodayUsd = 0; }
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

  /**
   * After a provider error the router falls back. With the failing modelId only that model is skipped, for as long as
   * modelBlock() says (daily quota / 404 / 413 → rest of the Manila day; per-minute 429 → 2 min; 5xx → 10 min).
   * Without a model id (or a status), the provider's daily cap is treated as used up (all its models).
   */
  markExhausted(provider: string, detail: { modelId?: string; error?: unknown } = {}) {
    this.rollDay();
    const block = detail.modelId ? modelBlock(detail.error) : null;
    if (block !== null) {
      this.blockedModels.set(`${provider}:${detail.modelId}`, block === 'day' ? Infinity : this.now().getTime() + block);
      return;
    }
    const cap = this.opts.cfg.daily_request_caps[provider] ?? 1_000_000;
    this.requestsToday[provider as Provider] = cap;
  }

  private activeBlocks(): Set<string> {
    const now = this.now().getTime();
    return new Set([...this.blockedModels].filter(([, until]) => until > now).map(([spec]) => spec));
  }

  pick: PickModel = async (role, o = {}) => {
    this.rollDay();
    if (this.opts.monthSpend && this.now().getTime() - this.refreshedAt >= (this.opts.refreshEveryMs ?? 5 * 60_000)) {
      await this.refreshSpend().catch(() => undefined); // keep the last known figure if the DB is unreachable
    }
    const c = chooseCandidate(role, this.opts.cfg, {
      profile: this.opts.profile, env: this.opts.env, monthlyBudgetUsd: this.opts.monthlyBudgetUsd, override: o.override ?? null,
      paidBlocked: this.paidBlocked,
      usage: { requestsToday: this.requestsToday, spentThisMonthUsd: this.spentThisMonthUsd, blockedModels: this.activeBlocks() },
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
