import fs from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import type { LanguageModel } from 'ai';
import type { ModelRole } from '@rizehubhq/shared';
import { config } from '../config';

export const PROVIDERS = ['google', 'groq', 'openrouter', 'anthropic', 'openai'] as const;
export type Provider = (typeof PROVIDERS)[number];

const Specs = z.array(z.string()).min(1);
const ProfileSchema = z.object({ lead: Specs, specialist: Specs, dev: Specs, reports: Specs, qa: Specs, light: Specs });

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

/**
 * Picks the first usable model for a role: provider key present, under 90% of its
 * free daily cap, and (for paid providers) within the monthly budget.
 * Pure function so it's easy to test; the caller supplies env + usage.
 */
export function chooseCandidate(
  role: ModelRole,
  cfg: ModelsConfig,
  opts: { profile?: string; env: Record<string, string | undefined>; usage: UsageSnapshot; monthlyBudgetUsd: number; override?: string | null },
): Candidate {
  const profileName = opts.profile ?? cfg.active_profile;
  const profile = cfg.profiles[profileName];
  if (!profile) throw new Error(`Unknown model profile "${profileName}"`);
  const specs = opts.override ? [opts.override, ...profile[role]] : profile[role];
  const reasons: string[] = [];
  for (const spec of specs) {
    const c = parseCandidate(spec);
    if (!opts.env[KEY_ENV[c.provider]]) { reasons.push(`${spec}: no ${KEY_ENV[c.provider]}`); continue; }
    const cap = cfg.daily_request_caps[c.provider];
    if (cap && (opts.usage.requestsToday[c.provider] ?? 0) >= cap * 0.9) { reasons.push(`${spec}: daily free cap nearly used`); continue; }
    const paid = c.provider === 'anthropic' || c.provider === 'openai';
    if (paid && opts.usage.spentThisMonthUsd >= opts.monthlyBudgetUsd) { reasons.push(`${spec}: monthly budget reached`); continue; }
    return c;
  }
  throw new QuotaExhaustedError(role, reasons);
}

export class QuotaExhaustedError extends Error {
  constructor(public role: ModelRole, public reasons: string[]) {
    super(`No model available for role "${role}": ${reasons.join('; ')}`);
  }
}

/** Creates the AI SDK model object. Providers are imported lazily so unused ones cost nothing. */
export async function createModel(c: Candidate): Promise<LanguageModel> {
  switch (c.provider) {
    case 'google': { const { createGoogleGenerativeAI } = await import('@ai-sdk/google'); return createGoogleGenerativeAI()(c.modelId); }
    case 'groq': { const { createGroq } = await import('@ai-sdk/groq'); return createGroq()(c.modelId); }
    case 'openrouter': { const { createOpenRouter } = await import('@openrouter/ai-sdk-provider'); return createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })(c.modelId); }
    case 'anthropic': { const { createAnthropic } = await import('@ai-sdk/anthropic'); return createAnthropic()(c.modelId); }
    case 'openai': { const { createOpenAI } = await import('@ai-sdk/openai'); return createOpenAI()(c.modelId); }
  }
}
