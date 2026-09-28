// Model picking + usage meter (docs/14). Wraps the pure router (chooseCandidate) with live
// per-provider request counts and month-to-date spend, and prices token usage.
import { APICallError, RetryError, type LanguageModel, type LanguageModelUsage } from 'ai';
import type { ModelRole } from '@rizehubhq/shared';
import { chooseCandidate, createModel, QuotaExhaustedError, type Candidate, type ModelsConfig, type Provider } from './router';

/** USD per million tokens. Anthropic prices from docs/14 (Sep 2026). */
export interface Price { input: number; output: number; cacheRead?: number }
export const PRICES: { match: RegExp; price: Price }[] = [
  { match: /^claude-opus/, price: { input: 4, output: 20, cacheRead: 0.2 } },
  { match: /^claude-sonnet/, price: { input: 2, output: 10, cacheRead: 0.2 } },
  { match: /^claude-haiku/, price: { input: 1, output: 5, cacheRead: 0.1 } },
  // OpenAI: placeholder tiers until real prices are copied from OpenAI's pricing page.
  { match: /nano/, price: { input: 0.1, output: 0.4 } },
  { match: /mini/, price: { input: 0.4, output: 1.6 } },
  { match: /^gpt-/, price: { input: 2, output: 10 } },
];
/** Unknown model on a paid provider: price it like a mid-tier model rather than as free. */
export const FALLBACK_PAID_PRICE: Price = { input: 2, output: 10, cacheRead: 0.2 };
export const PAID_PROVIDERS: readonly string[] = ['anthropic', 'openai'];

export function priceFor(provider: string, modelId: string): Price | null {
  if (!PAID_PROVIDERS.includes(provider)) return null; // free tiers (google, groq, openrouter :free) cost 0
  return PRICES.find((p) => p.match.test(modelId))?.price ?? FALLBACK_PAID_PRICE;
}

export function costUsd(provider: string, modelId: string, usage: Partial<LanguageModelUsage>): number {
  const p = priceFor(provider, modelId);
  if (!p) return 0;
  const input = usage.inputTokens ?? 0;
  const cached = Math.min(usage.cachedInputTokens ?? 0, input);
  const output = usage.outputTokens ?? 0;
  const usd = ((input - cached) * p.input + cached * (p.cacheRead ?? p.input) + output * p.output) / 1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}

export interface PickedModel {
  model: LanguageModel;
  provider: string;
  modelId: string;
  /** Records one model call (a step). Returns the call's cost in USD. */
  recordCall(usage: Partial<LanguageModelUsage>): number;
}

export type PickModel = (role: ModelRole, opts?: { override?: string | null }) => Promise<PickedModel>;

/** True for "try later / another provider" errors: router has no quota, or the provider said 429. */
export function isQuotaError(e: unknown, depth = 0): boolean {
  if (!e || depth > 4) return false;
  if (e instanceof QuotaExhaustedError) return true;
  if (APICallError.isInstance(e) && e.statusCode === 429) return true;
  if (RetryError.isInstance(e)) return isQuotaError(e.lastError, depth + 1);
  const cause = (e as { cause?: unknown }).cause;
  return cause ? isQuotaError(cause, depth + 1) : false;
}

function manilaDay(d = new Date()) { return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }); }

export interface ModelPickerOptions {
  cfg: ModelsConfig;
  profile?: string;
  env: Record<string, string | undefined>;
  monthlyBudgetUsd: number;
  spentThisMonthUsd?: number;
  create?: (c: Candidate) => Promise<LanguageModel>;
}

export class ModelPicker {
  private day = manilaDay();
  private requestsToday: Partial<Record<Provider, number>> = {};
  spentThisMonthUsd: number;

  constructor(private opts: ModelPickerOptions) { this.spentThisMonthUsd = opts.spentThisMonthUsd ?? 0; }

  private rollDay() {
    const d = manilaDay();
    if (d !== this.day) { this.day = d; this.requestsToday = {}; }
  }

  /** After a provider 429, treat its daily cap as used so the router falls back. */
  markExhausted(provider: string) {
    const cap = this.opts.cfg.daily_request_caps[provider] ?? 1_000_000;
    this.requestsToday[provider as Provider] = cap;
  }

  pick: PickModel = async (role, o = {}) => {
    this.rollDay();
    const c = chooseCandidate(role, this.opts.cfg, {
      profile: this.opts.profile, env: this.opts.env, monthlyBudgetUsd: this.opts.monthlyBudgetUsd, override: o.override ?? null,
      usage: { requestsToday: this.requestsToday, spentThisMonthUsd: this.spentThisMonthUsd },
    });
    const model = await (this.opts.create ?? createModel)(c);
    return {
      model, provider: c.provider, modelId: c.modelId,
      recordCall: (usage) => {
        this.rollDay();
        this.requestsToday[c.provider] = (this.requestsToday[c.provider] ?? 0) + 1;
        const usd = costUsd(c.provider, c.modelId, usage);
        this.spentThisMonthUsd += usd;
        return usd;
      },
    };
  };
}

/** Sums SDK usage objects (undefined counts as 0). */
export function addUsage(a: Partial<LanguageModelUsage>, b: Partial<LanguageModelUsage>) {
  return {
    inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
    cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0),
  };
}
