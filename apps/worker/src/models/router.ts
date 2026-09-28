import fs from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import type { LanguageModel } from 'ai';
import type { ModelRole } from '@rizehubhq/shared';
import { config, workerEnv } from '../config';

export const PROVIDERS = ['google', 'groq', 'openrouter', 'anthropic', 'openai'] as const;
export type Provider = (typeof PROVIDERS)[number];

const Specs = z.array(z.string()).min(1);
// design/writer/sales arrived with the six-agent roster: optional so older profiles still load (they fall back).
const ProfileSchema = z.object({
  lead: Specs, specialist: Specs, dev: Specs, reports: Specs, qa: Specs, light: Specs,
  design: Specs.optional(), writer: Specs.optional(), sales: Specs.optional(),
});

/** A role a profile doesn't define uses this role's models instead. */
export const ROLE_FALLBACK: Partial<Record<ModelRole, ModelRole>> = { design: 'specialist', writer: 'specialist', sales: 'specialist' };
/** Profiles the worker accepts in MODEL_PROFILE / active_profile (config/models.yaml). */
export const MODEL_PROFILES = ['free', 'paid', 'hybrid', 'claude', 'openai'] as const;

/** Env var that overrides a role's model: MODEL_ID_LEAD, MODEL_ID_DEV, MODEL_ID_DESIGN, … (format provider:model). */
export const roleEnvVar = (role: ModelRole) => `MODEL_ID_${role.toUpperCase()}`;

const ModelsFile = z.object({
  active_profile: z.string(),
  profiles: z.record(z.string(), ProfileSchema),
  daily_request_caps: z.record(z.string(), z.number()).default({}),
});
export type ModelsConfig = z.infer<typeof ModelsFile>;

export function loadModelsConfig(file = config.modelsFile): ModelsConfig {
  return ModelsFile.parse(YAML.parse(fs.readFileSync(file, 'utf8')));
}

export interface Candidate { provider: Provider; modelId: string }

/** The model specs of a role in a profile (with the design/writer/sales → specialist fallback). */
export function profileSpecs(profile: z.infer<typeof ProfileSchema>, role: ModelRole): string[] {
  return profile[role] ?? profile[ROLE_FALLBACK[role] ?? 'specialist'] ?? [];
}

/**
 * Ordered, de-duplicated model specs for a role: agent override (Agents page) → env MODEL_ID_<ROLE> → profile list.
 * The env override wins over config/models.yaml; the file's list stays as the fallback.
 */
export function roleSpecs(role: ModelRole, cfg: ModelsConfig, opts: { profile?: string; env: Record<string, string | undefined>; override?: string | null }): string[] {
  const profileName = opts.profile ?? cfg.active_profile;
  const profile = cfg.profiles[profileName];
  if (!profile) throw new Error(`Unknown model profile "${profileName}"`);
  const fromEnv = opts.env[roleEnvVar(role)]?.trim();
  return [...new Set([opts.override, fromEnv, ...profileSpecs(profile, role)].filter((x): x is string => !!x))];
}

export function parseCandidate(spec: string): Candidate {
  const i = spec.indexOf(':');
  const provider = spec.slice(0, i) as Provider;
  const modelId = spec.slice(i + 1);
  if (i < 1 || !PROVIDERS.includes(provider) || !modelId) throw new Error(`Bad model spec "${spec}" (use provider:model)`);
  return { provider, modelId };
}

const KEY_ENV: Record<Provider, string> = {
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

export interface UsageSnapshot {
  requestsToday: Partial<Record<Provider, number>>;
  spentThisMonthUsd: number;
}

export const isPaidProvider = (p: string) => p === 'anthropic' || p === 'openai';
/** Profile whose models are tried after the daily AI budget (DAILY_AI_BUDGET_USD) stops paid providers. */
export const FREE_FALLBACK_PROFILE = 'free';

/**
 * Picks the first usable model for a role (order: roleSpecs): provider key present, under 90% of its
 * free daily cap, and (for paid providers) within the monthly budget.
 * `paidBlocked` (the daily AI budget is used up): paid providers are skipped and the role's models from the
 * `free` profile are tried after the active profile's list, so work continues on free models when their keys exist.
 * Pure function so it's easy to test; the caller supplies env + usage.
 */
export function chooseCandidate(
  role: ModelRole,
  cfg: ModelsConfig,
  opts: {
    profile?: string; env: Record<string, string | undefined>; usage: UsageSnapshot; monthlyBudgetUsd: number; override?: string | null;
    paidBlocked?: boolean;
  },
): Candidate {
  let specs = roleSpecs(role, cfg, opts);
  const free = cfg.profiles[FREE_FALLBACK_PROFILE];
  if (opts.paidBlocked && free) specs = [...new Set([...specs, ...profileSpecs(free, role)])];
  const reasons: string[] = [];
  for (const spec of specs) {
    const c = parseCandidate(spec);
    const paid = isPaidProvider(c.provider);
    if (paid && opts.paidBlocked) { reasons.push(`${spec}: daily AI budget reached`); continue; }
    if (!opts.env[KEY_ENV[c.provider]]) { reasons.push(`${spec}: no ${KEY_ENV[c.provider]}`); continue; }
    const cap = cfg.daily_request_caps[c.provider];
    if (cap && (opts.usage.requestsToday[c.provider] ?? 0) >= cap * 0.9) { reasons.push(`${spec}: daily free cap nearly used`); continue; }
    if (paid && opts.usage.spentThisMonthUsd >= opts.monthlyBudgetUsd) { reasons.push(`${spec}: monthly budget reached`); continue; }
    return c;
  }
  throw new QuotaExhaustedError(role, reasons);
}

/** True when at least one free provider (google / groq / openrouter) has an API key: work can go on after the daily cap. */
export function hasFreeProviderKey(env: Record<string, string | undefined>): boolean {
  return PROVIDERS.some((p) => !isPaidProvider(p) && !!env[KEY_ENV[p]]?.trim());
}

export class QuotaExhaustedError extends Error {
  constructor(public role: ModelRole, public reasons: string[]) {
    super(`No model available for role "${role}": ${reasons.join('; ')}`);
  }
}

/**
 * Creates the AI SDK model object. Providers are imported lazily so unused ones cost nothing. API keys are passed
 * explicitly from workerEnv(): process.env no longer carries them after scrubProcessEnv() (config.ts).
 */
export async function createModel(c: Candidate, env: Readonly<Record<string, string | undefined>> = workerEnv()): Promise<LanguageModel> {
  const apiKey = env[KEY_ENV[c.provider]];
  switch (c.provider) {
    case 'google': { const { createGoogleGenerativeAI } = await import('@ai-sdk/google'); return createGoogleGenerativeAI({ apiKey })(c.modelId); }
    case 'groq': { const { createGroq } = await import('@ai-sdk/groq'); return createGroq({ apiKey })(c.modelId); }
    case 'openrouter': { const { createOpenRouter } = await import('@openrouter/ai-sdk-provider'); return createOpenRouter({ apiKey })(c.modelId); }
    case 'anthropic': { const { createAnthropic } = await import('@ai-sdk/anthropic'); return createAnthropic({ apiKey })(c.modelId); }
    case 'openai': { const { createOpenAI } = await import('@ai-sdk/openai'); return createOpenAI({ apiKey })(c.modelId); }
  }
}
