// Admin → API & AI (docs/14 "Dashboard settings"): pure helpers shared by the page, the form and the server actions
// (unit-tested in apiSettings.test.ts). The rules themselves live in packages/shared/src/aiSettings.ts.
import {
  budgetLoosened, isAiProfile, isModelSpec, MAX_BUDGET_USD, MODEL_ROLES, ROLE_LABEL, type AiProfile, type DashboardAi, type ModelRole,
} from '@rizehubhq/shared';

/** Where a provider key comes from, as the page shows it. */
export type KeyState = 'dashboard' | 'dashboard_unreadable' | 'env' | 'missing' | 'unknown';

/**
 * stored: a provider_keys row exists. worker: what the worker says agents use (null = worker offline).
 * unreadable: the worker could not decrypt the stored row (wrong VAULT_MASTER_KEY): the .env value is used instead.
 */
export function keyState(stored: boolean, worker: 'dashboard' | 'env' | 'missing' | null, unreadable: boolean): KeyState {
  if (stored) return unreadable ? 'dashboard_unreadable' : 'dashboard';
  if (worker === 'env') return 'env';
  if (worker === 'missing') return 'missing';
  return 'unknown'; // worker offline, or it has not reloaded after a removal yet
}

export const KEY_STATE_LABEL: Record<KeyState, string> = {
  dashboard: 'Set here',
  dashboard_unreadable: 'Stored, can\'t decrypt',
  env: 'Set in .env',
  missing: 'Missing',
  unknown: 'Not set here',
};

export interface AiFormInput {
  profile: string;
  monthly: string;
  daily: string;
  modelIds: Partial<Record<ModelRole, string>>;
}
export interface AiValues { profile: AiProfile | null; monthly: number | null; daily: number | null; modelIds: Partial<Record<ModelRole, string>> }

function money(raw: string, what: string): { ok: true; value: number | null } | { ok: false; error: string } {
  const s = raw.trim().replace(/^\$/, '').replace(/,/g, '');
  if (s === '') return { ok: true, value: null };
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: `${what}: enter an amount in USD (0 or more), or leave it empty.` };
  if (n > MAX_BUDGET_USD) return { ok: false, error: `${what}: at most $${MAX_BUDGET_USD.toLocaleString('en-US')}.` };
  return { ok: true, value: Math.round(n * 100) / 100 };
}

/** Form strings → the values ai_settings_set() takes (empty = use the .env value). */
export function parseAiForm(f: AiFormInput): { ok: true; value: AiValues } | { ok: false; error: string } {
  const profile = f.profile.trim();
  if (profile && !isAiProfile(profile)) return { ok: false, error: 'Pick a model profile from the list.' };
  const monthly = money(f.monthly ?? '', 'Monthly budget');
  if (!monthly.ok) return monthly;
  const daily = money(f.daily ?? '', 'Daily budget');
  if (!daily.ok) return daily;
  const modelIds: Partial<Record<ModelRole, string>> = {};
  for (const role of MODEL_ROLES) {
    const v = (f.modelIds?.[role] ?? '').trim();
    if (!v) continue;
    if (!isModelSpec(v)) return { ok: false, error: `${ROLE_LABEL[role]}: use provider:model, e.g. anthropic:claude-sonnet-5.` };
    modelIds[role] = v;
  }
  return { ok: true, value: { profile: (profile || null) as AiProfile | null, monthly: monthly.value, daily: daily.value, modelIds } };
}

export function formFromDashboard(d: DashboardAi): AiFormInput {
  return {
    profile: d.profile ?? '',
    monthly: d.monthlyBudgetUsd === null ? '' : String(d.monthlyBudgetUsd),
    daily: d.dailyBudgetUsd === null ? '' : String(d.dailyBudgetUsd),
    modelIds: { ...d.modelIds },
  };
}

/** Would saving these values ask for a 2FA code in the database (more money may be spent)? Mirrors ai_budget_looser(). */
export function raisesBudget(before: DashboardAi, after: AiValues): boolean {
  return budgetLoosened({ monthly: before.monthlyBudgetUsd, daily: before.dailyBudgetUsd }, { monthly: after.monthly, daily: after.daily });
}

export function usdOrNone(n: number | null | undefined, none: string): string {
  if (n === null || n === undefined) return none;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}
