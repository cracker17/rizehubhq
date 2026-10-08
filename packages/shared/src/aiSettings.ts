// Admin → API & AI (docs/14 "Dashboard settings", docs/09 "Where system secrets live"). Shared by the worker (key
// overlay + precedence), the dashboard (/admin/api) and the bot (/budget), so all three read one set of rules.
//
// Precedence (every value): the dashboard value when the CEO set one → the .env value → the built-in default.
// The dashboard stores AI settings in `settings` under the ai_* keys below (written only by ai_settings_set(), audited,
// raising a budget needs a fresh 2FA code) and provider keys sealed in `provider_keys` (written only by the worker).
import { MODEL_ROLES, type ModelRole } from './status';

// ---------- profiles ----------
/** Profiles the worker accepts (config/models.yaml profiles; env MODEL_PROFILE). */
export const AI_PROFILES = ['free', 'paid', 'hybrid', 'claude', 'openai', 'kimi'] as const;
export type AiProfile = (typeof AI_PROFILES)[number];
export const isAiProfile = (v: unknown): v is AiProfile => typeof v === 'string' && (AI_PROFILES as readonly string[]).includes(v);

/** One line per profile for the dashboard select (docs/14). */
export const AI_PROFILE_HELP: Record<AiProfile, string> = {
  free: 'Free models only (Gemini, Groq, OpenRouter free). Kimi is the paid last resort when a monthly budget is set.',
  paid: 'Claude Sonnet for the COO, developer and sales; Haiku for design, writing and chat; QA on OpenAI.',
  hybrid: 'Claude Sonnet for the COO, developer, reports and QA; free models for everything else.',
  claude: 'Every role on Claude (Opus for the COO and QA, Sonnet for the team, Haiku for chat).',
  openai: 'Every role on OpenAI models.',
  kimi: 'Every role on Moonshot Kimi (K3 for the COO and QA, K2.6 for the rest).',
};

// ---------- per-role model overrides (MODEL_ID_<ROLE>) ----------
export const MODEL_PROVIDERS = ['google', 'groq', 'openrouter', 'anthropic', 'openai', 'moonshot'] as const;
/** provider:model, e.g. anthropic:claude-sonnet-5 or openrouter:qwen/qwen3.8-27b:free. */
export const MODEL_SPEC = /^(google|groq|openrouter|anthropic|openai|moonshot):[A-Za-z0-9][\w./:@+-]{0,119}$/;
export const isModelSpec = (v: unknown): v is string => typeof v === 'string' && MODEL_SPEC.test(v);
export const ROLE_LABEL: Record<ModelRole, string> = {
  lead: 'COO (planning)', specialist: 'Specialists (default)', dev: 'Web Developer', design: 'Graphic Designer',
  writer: 'Content Writer', sales: 'Sales Agent', reports: 'Reports', qa: 'QA reviews', light: 'Chat and summaries',
};

// ---------- provider keys ----------
export type ProviderKeyGroup = 'ai' | 'research' | 'design';
export interface ProviderKeyDef {
  name: string;
  group: ProviderKeyGroup;
  label: string;
  /** What it unlocks, one line. */
  hint: string;
  /** Where the CEO creates it. */
  docs: string;
  /** Not a secret (an ID): a plain text field, called an ID rather than a key. Stored sealed like the keys. */
  plain?: boolean;
}

/**
 * Keys the CEO may manage in the dashboard: provider API keys only. Bootstrap secrets (SUPABASE_*, VAULT_*,
 * HQ_INTERNAL_SECRET, TELEGRAM_BOT_TOKEN, SUPABASE_DB_URL, RIZEHUB_*, HQ_MCP_TOKEN_*, HERMES_KEY_*, OUTREACH_*) are
 * never on this list: the worker needs them to reach the database and decrypt, and the DB check constraint mirrors it.
 */
export const PROVIDER_KEYS: readonly ProviderKeyDef[] = [
  { name: 'GOOGLE_GENERATIVE_AI_API_KEY', group: 'ai', label: 'Google Gemini', hint: 'Free tier: the free profile\'s first choice.', docs: 'https://aistudio.google.com/apikey' },
  { name: 'GROQ_API_KEY', group: 'ai', label: 'Groq', hint: 'Free tier: fast fallback models and voice transcription.', docs: 'https://console.groq.com/keys' },
  { name: 'OPENROUTER_API_KEY', group: 'ai', label: 'OpenRouter', hint: 'Free ":free" models as fallback; other models are paid.', docs: 'https://openrouter.ai/settings/keys' },
  { name: 'ANTHROPIC_API_KEY', group: 'ai', label: 'Anthropic (Claude)', hint: 'Paid: paid, hybrid and claude profiles.', docs: 'https://console.anthropic.com/settings/keys' },
  {
    name: 'ANTHROPIC_WORKSPACE_ID', group: 'ai', label: 'Anthropic workspace', plain: true, docs: 'https://platform.claude.com/settings/workspaces',
    hint: 'Only for an Anthropic key that works in several workspaces: the workspace (wrkspc_…) its requests run in. Add it before the key.',
  },
  { name: 'OPENAI_API_KEY', group: 'ai', label: 'OpenAI', hint: 'Paid: QA on the paid profile, the openai profile.', docs: 'https://platform.openai.com/api-keys' },
  { name: 'MOONSHOT_API_KEY', group: 'ai', label: 'Moonshot (Kimi)', hint: 'Paid: last-resort backup and the kimi profile.', docs: 'https://platform.kimi.ai' },
  { name: 'TAVILY_API_KEY', group: 'research', label: 'Tavily search', hint: 'Web search for agents (tried first).', docs: 'https://app.tavily.com' },
  { name: 'BRAVE_SEARCH_API_KEY', group: 'research', label: 'Brave Search', hint: 'Web search fallback.', docs: 'https://api-dashboard.search.brave.com' },
  { name: 'SERPER_API_KEY', group: 'research', label: 'Serper (Google results)', hint: 'Web search fallback.', docs: 'https://serper.dev/api-key' },
  { name: 'PAGESPEED_API_KEY', group: 'research', label: 'PageSpeed Insights', hint: 'Optional: raises the free PageSpeed quota for QA.', docs: 'https://developers.google.com/speed/docs/insights/v5/get-started' },
  { name: 'SEMRUSH_API_KEY', group: 'research', label: 'Semrush API', hint: 'Keyword and domain data (API units are paid).', docs: 'https://www.semrush.com/accounts/subscription-info/api-units' },
  { name: 'FIGMA_TOKEN', group: 'design', label: 'Figma', hint: 'Personal access token (file read) for figma_read.', docs: 'https://www.figma.com/developers/api#access-tokens' },
];
export const PROVIDER_KEY_NAMES: readonly string[] = PROVIDER_KEYS.map((k) => k.name);
export const isProviderKeyName = (v: unknown): v is string => typeof v === 'string' && PROVIDER_KEY_NAMES.includes(v);
export const PROVIDER_KEY_GROUPS: { id: ProviderKeyGroup; label: string }[] = [
  { id: 'ai', label: 'AI models' }, { id: 'research', label: 'Research & SEO' }, { id: 'design', label: 'Design' },
];
/** Names that must never be stored from the dashboard (clear refusal instead of "unknown key"). */
export const BOOTSTRAP_SECRET = /^(SUPABASE_|VAULT_|HQ_INTERNAL_SECRET$|HQ_MCP_TOKEN_|TELEGRAM_|RIZEHUB_|HERMES_KEY_|OUTREACH_|NEXT_PUBLIC_)/;
/** Encryption context of a stored provider key (never the same as a vault credential's or a connector's). */
export const providerKeyContext = (name: string) => `provider_key:${name}`;
/** Shape check for a pasted key: 8–512 printable characters, no spaces. */
export const PROVIDER_KEY_VALUE = /^[\x21-\x7e]{8,512}$/;
/** Anthropic workspace ID, sent as the anthropic-workspace-id header (required with a multi-workspace key). */
export const ANTHROPIC_WORKSPACE_ID = /^wrkspc_[A-Za-z0-9]{8,64}$/;
/** The extra header for every Anthropic call: empty unless a valid workspace ID is set. */
export function anthropicWorkspaceHeaders(workspaceId: string | undefined | null): Record<string, string> {
  const id = workspaceId?.trim();
  return id && ANTHROPIC_WORKSPACE_ID.test(id) ? { 'anthropic-workspace-id': id } : {};
}

// ---------- AI settings rows ----------
export const AI_SETTING_KEYS = {
  profile: 'ai_model_profile',
  monthly: 'ai_monthly_budget_usd',
  daily: 'ai_daily_budget_usd',
  modelIds: 'ai_model_ids',
} as const;
/** Highest budget the dashboard accepts (typo guard; ai_settings_set() enforces the same). */
export const MAX_BUDGET_USD = 100_000;

export interface DashboardAi {
  profile: AiProfile | null;
  monthlyBudgetUsd: number | null;
  /** 0 = no daily cap. */
  dailyBudgetUsd: number | null;
  modelIds: Partial<Record<ModelRole, string>>;
}

function money(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= MAX_BUDGET_USD ? n : null;
}

/** The CEO's dashboard values from the settings rows (key → jsonb value). Invalid values are ignored (null). */
export function parseDashboardAi(settings: Readonly<Record<string, unknown>>): DashboardAi {
  const profile = settings[AI_SETTING_KEYS.profile];
  const ids = settings[AI_SETTING_KEYS.modelIds];
  const modelIds: Partial<Record<ModelRole, string>> = {};
  if (ids && typeof ids === 'object' && !Array.isArray(ids)) {
    for (const role of MODEL_ROLES) {
      const v = (ids as Record<string, unknown>)[role];
      if (isModelSpec(v)) modelIds[role] = v;
    }
  }
  return {
    profile: isAiProfile(profile) ? profile : null,
    monthlyBudgetUsd: money(settings[AI_SETTING_KEYS.monthly]),
    dailyBudgetUsd: money(settings[AI_SETTING_KEYS.daily]),
    modelIds,
  };
}

export type SettingSource = 'dashboard' | 'env' | 'settings' | 'default';

/** Monthly paid-model budget: dashboard → MONTHLY_BUDGET_USD → 0 (free models only). */
export function effectiveMonthlyBudget(dashboard: number | null, envValue: string | undefined | null): { usd: number; source: SettingSource } {
  if (dashboard !== null) return { usd: dashboard, source: 'dashboard' };
  const env = money(envValue);
  return env !== null ? { usd: env, source: 'env' } : { usd: 0, source: 'default' };
}

/**
 * Daily AI cap: dashboard → DAILY_AI_BUDGET_USD → settings.daily_budget_usd (older setting) → none. 0 at any level
 * means "no cap" and stops the lookup (same rule the worker always had for an explicit DAILY_AI_BUDGET_USD=0).
 */
export function effectiveDailyBudget(dashboard: number | null, envValue: string | undefined | null, legacySetting?: unknown): { usd: number | null; source: SettingSource } {
  const cap = (n: number) => (n > 0 ? n : null);
  if (dashboard !== null) return { usd: cap(dashboard), source: 'dashboard' };
  const env = money(envValue);
  if (env !== null) return { usd: cap(env), source: 'env' };
  const legacy = money(legacySetting);
  return legacy ? { usd: legacy, source: 'settings' } : { usd: null, source: 'default' };
}

/** Model profile: dashboard → MODEL_PROFILE → config/models.yaml active_profile. */
export function effectiveProfile(dashboard: AiProfile | null, envValue: string | undefined | null, fileDefault: string): { profile: string; source: SettingSource } {
  if (dashboard) return { profile: dashboard, source: 'dashboard' };
  const env = envValue?.trim();
  return env ? { profile: env, source: 'env' } : { profile: fileDefault, source: 'default' };
}

/** Env var of a role's model override (MODEL_ID_LEAD, …). */
export const modelIdEnvVar = (role: ModelRole) => `MODEL_ID_${role.toUpperCase()}`;

/**
 * Does moving from `before` to `after` let more money be spent? Then ai_settings_set() needs a fresh 2FA code.
 * Monthly: a higher figure, or any figure where none was set (the .env default is unknown here), or clearing one.
 * Daily: the same, where 0 (no cap) counts as unlimited. Mirrors ai_budget_looser() in SQL.
 */
export function budgetLoosened(before: { monthly: number | null; daily: number | null }, after: { monthly: number | null; daily: number | null }): boolean {
  const monthly = looser(before.monthly, after.monthly, (n) => n);
  const daily = looser(before.daily, after.daily, (n) => (n === 0 ? Infinity : n));
  return monthly || daily;
}
function looser(before: number | null, after: number | null, rank: (n: number) => number): boolean {
  if (after === null) return before !== null; // back to the .env default: may be higher
  if (before === null) return !(rank(after) === 0); // 0/month is the floor; anything else may exceed the .env value
  return rank(after) > rank(before);
}
