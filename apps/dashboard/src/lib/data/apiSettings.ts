import 'server-only';
// Admin → API & AI data (docs/14 "Dashboard settings"): which provider keys are stored here (name + last 4 + test
// result; the ciphertext column is not readable by the browser role), the CEO's ai_* settings rows, and what the worker
// runs with right now (POST /settings/status: key sources, .env defaults, the model each role gets). Never a key value.
import { AI_SETTING_KEYS, MODEL_ROLES, parseDashboardAi, PROVIDER_KEYS, type DashboardAi, type ModelRole, type ProviderKeyDef } from '@rizehubhq/shared';
import { createSupabaseServer } from '@/lib/supabase/server';
import { supabaseEnv } from '@/lib/env';
import { totpState } from '@/lib/auth/mfaServer';
import { callWorker } from '@/lib/workerCall';
import { keyState, type KeyState } from '@/lib/apiSettings';

export interface ApiKeyView extends ProviderKeyDef {
  state: KeyState;
  last4: string | null;
  updated_at: string | null;
  last_test_at: string | null;
  last_test_ok: boolean | null;
  last_error: string | null;
  /** The .env also has a value (shown when the dashboard one overrides it). */
  alsoInEnv: boolean;
}

type Source = 'dashboard' | 'env' | 'settings' | 'default';
export interface WorkerAiStatus {
  ai: { profile: string; profileSource: Source; monthlyBudgetUsd: number; monthlySource: Source; dailyBudgetUsd: number | null; dailySource: Source; warnings: string[] };
  defaults: { profile: string; monthlyBudgetUsd: number; dailyBudgetUsd: number | null; modelIds: Partial<Record<ModelRole, { spec: string }>> };
  models: Partial<Record<ModelRole, { provider: string; modelId: string } | { error: string }>>;
  paidBlocked: boolean;
}

export interface ApiPage {
  mode: 'demo' | 'live';
  totpOn: boolean;
  keys: ApiKeyView[];
  dashboard: DashboardAi;
  /** null = the worker could not be reached (key sources from .env unknown). */
  worker: WorkerAiStatus | null;
  workerError?: string;
  error?: string;
}

interface KeyRow { name: string; last4: string; updated_at: string; last_test_at: string | null; last_test_ok: boolean | null; last_error: string | null }
interface StatusBody extends Partial<WorkerAiStatus> { keys?: { name: string; source: 'dashboard' | 'env' | 'missing' }[]; unreadable?: string[]; envAlso?: string[] }

function build(rows: KeyRow[], status: StatusBody | null): ApiKeyView[] {
  const byName = new Map(rows.map((r) => [r.name, r]));
  const source = new Map((status?.keys ?? []).map((k) => [k.name, k.source]));
  const unreadable = new Set(status?.unreadable ?? []);
  return PROVIDER_KEYS.map((def) => {
    const r = byName.get(def.name);
    return {
      ...def, state: keyState(!!r, status ? (source.get(def.name) ?? 'missing') : null, unreadable.has(def.name)),
      last4: r?.last4 ?? null, updated_at: r?.updated_at ?? null, last_test_at: r?.last_test_at ?? null,
      last_test_ok: r?.last_test_ok ?? null, last_error: r?.last_error ?? null, alsoInEnv: (status?.envAlso ?? []).includes(def.name),
    };
  });
}

function demo(): ApiPage {
  const now = new Date().toISOString();
  const rows: KeyRow[] = [
    { name: 'GOOGLE_GENERATIVE_AI_API_KEY', last4: 'x9Qa', updated_at: now, last_test_at: now, last_test_ok: true, last_error: null },
    { name: 'ANTHROPIC_API_KEY', last4: '7fKd', updated_at: now, last_test_at: now, last_test_ok: false, last_error: 'Anthropic rejected the key (HTTP 401). Check that you copied all of it.' },
  ];
  const keys = [
    { name: 'GOOGLE_GENERATIVE_AI_API_KEY', source: 'dashboard' as const }, { name: 'ANTHROPIC_API_KEY', source: 'dashboard' as const },
    { name: 'GROQ_API_KEY', source: 'env' as const }, { name: 'TAVILY_API_KEY', source: 'env' as const },
  ];
  const dashboard = parseDashboardAi({ [AI_SETTING_KEYS.profile]: 'hybrid', [AI_SETTING_KEYS.monthly]: 60 });
  const models = Object.fromEntries(MODEL_ROLES.map((r) => [r, ['lead', 'dev', 'reports', 'qa'].includes(r)
    ? { provider: 'anthropic', modelId: 'claude-sonnet-5' } : { provider: 'google', modelId: 'gemini-3.8-flash' }]));
  return {
    mode: 'demo', totpOn: false, dashboard, keys: build(rows, { keys }),
    worker: {
      ai: { profile: 'hybrid', profileSource: 'dashboard', monthlyBudgetUsd: 60, monthlySource: 'dashboard', dailyBudgetUsd: 10, dailySource: 'settings', warnings: [] },
      defaults: { profile: 'free', monthlyBudgetUsd: 0, dailyBudgetUsd: 10, modelIds: {} }, models, paidBlocked: false,
    },
  };
}

export async function loadApiSettings(): Promise<ApiPage> {
  if (!supabaseEnv()) return demo();
  const db = (await createSupabaseServer())!;
  const [rows, settings, state, status] = await Promise.all([
    db.from('provider_keys').select('name,last4,updated_at,last_test_at,last_test_ok,last_error').order('name'),
    db.from('settings').select('key,value').in('key', Object.values(AI_SETTING_KEYS)),
    totpState(db),
    callWorker<StatusBody>('/settings/status', {}, 8_000),
  ]);
  const ok = status.status === 200 ? (status.body as StatusBody) : null;
  const worker = ok && ok.ai && ok.defaults && ok.models ? { ai: ok.ai, defaults: ok.defaults, models: ok.models, paidBlocked: !!ok.paidBlocked } : null;
  return {
    mode: 'live',
    totpOn: !!state?.factorId,
    keys: build((rows.data ?? []) as KeyRow[], ok),
    dashboard: parseDashboardAi(Object.fromEntries(((settings.data ?? []) as { key: string; value: unknown }[]).map((r) => [r.key, r.value]))),
    worker,
    workerError: ok ? undefined : (status.body.error ?? `Worker answered ${status.status}`),
    error: rows.error?.message ?? settings.error?.message,
  };
}
