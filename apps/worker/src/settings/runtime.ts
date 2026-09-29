// Admin → API & AI, worker side (docs/14 "Dashboard settings"). Every ~60 s (and right away on POST /settings/reload)
// the worker re-reads the provider keys the CEO stored in the dashboard (sealed; decrypted here with the vault keyring)
// and the ai_* settings rows, lays the keys over workerEnv() (config.ts setProviderKeyOverlay) and hands the AI settings
// to the model picker, so a new key, profile or budget applies without a restart.
//
// Precedence, every value: dashboard (when set) → .env → default. Keys never enter process.env and are never logged
// (only names); a row that fails to decrypt is skipped and the .env value of that name stays in use.
import {
  effectiveDailyBudget, effectiveMonthlyBudget, effectiveProfile, isProviderKeyName, MODEL_ROLES, modelIdEnvVar, parseDashboardAi,
  providerKeyContext, type DashboardAi, type ModelRole, type SettingSource,
} from '@rizehubhq/shared';
import { setProviderKeyOverlay } from '../config';
import { open, type Keyring } from '../vault/crypto';
import type { ModelsConfig } from '../models/router';
import type { ProviderKeyStore } from './store';

type Env = Readonly<Record<string, string | undefined>>;

export interface RuntimeSnapshot {
  /** Names of the dashboard keys in use (decrypted fine). */
  keys: string[];
  /** Names stored in the dashboard that could not be used (no VAULT_MASTER_KEY, wrong key, tampered). */
  unreadable: string[];
  dashboard: DashboardAi;
  /** settings.daily_budget_usd (older setting, used after the dashboard value and DAILY_AI_BUDGET_USD). */
  legacyDaily: unknown;
  loadedAt: number;
}

export interface RuntimeDeps {
  store: Pick<ProviderKeyStore, 'sealed' | 'settings'>;
  keyring: () => Keyring | null;
  /** Where decrypted keys go (default: the workerEnv() overlay). Returns the names applied. */
  applyKeys?: (keys: Readonly<Record<string, string>>) => string[];
  /** Called after every successful refresh with what changed (human-readable, no secrets). */
  onChange?: (s: RuntimeSnapshot, changes: string[]) => void;
  log?: (m: string) => void;
  now?: () => number;
}

const EMPTY_AI: DashboardAi = { profile: null, monthlyBudgetUsd: null, dailyBudgetUsd: null, modelIds: {} };

/** What changed between two snapshots, for the worker log (names and non-secret values only). */
export function describeChanges(before: RuntimeSnapshot | null, after: RuntimeSnapshot): string[] {
  const out: string[] = [];
  const prevKeys = new Set(before?.keys ?? []);
  const nextKeys = new Set(after.keys);
  const added = after.keys.filter((k) => !prevKeys.has(k));
  const removed = [...prevKeys].filter((k) => !nextKeys.has(k));
  if (added.length) out.push(`dashboard key(s) in use: ${added.join(', ')}`);
  if (removed.length) out.push(`dashboard key(s) removed (the .env value applies again): ${removed.join(', ')}`);
  const a = before?.dashboard ?? EMPTY_AI;
  const b = after.dashboard;
  const show = (v: unknown) => (v === null || v === undefined ? '.env default' : String(v));
  if (a.profile !== b.profile) out.push(`model profile: ${show(a.profile)} → ${show(b.profile)}`);
  if (a.monthlyBudgetUsd !== b.monthlyBudgetUsd) out.push(`monthly budget: ${show(a.monthlyBudgetUsd)} → ${show(b.monthlyBudgetUsd)}`);
  if (a.dailyBudgetUsd !== b.dailyBudgetUsd) out.push(`daily AI budget: ${show(a.dailyBudgetUsd)} → ${show(b.dailyBudgetUsd)}`);
  for (const role of MODEL_ROLES) if (a.modelIds[role] !== b.modelIds[role]) out.push(`${role} model: ${show(a.modelIds[role])} → ${show(b.modelIds[role])}`);
  return out;
}

export class RuntimeSettings {
  snapshot: RuntimeSnapshot | null = null;
  private inflight: Promise<RuntimeSnapshot> | null = null;
  private warned = new Set<string>();

  constructor(private d: RuntimeDeps) {}

  private log(m: string) { (this.d.log ?? ((x: string) => console.log(x)))(m); }
  private warnOnce(key: string, m: string) { if (!this.warned.has(key)) { this.warned.add(key); this.log(m); } }

  /** Re-reads keys + settings (single-flight). Throws when the database can't be read; the last snapshot stays in use. */
  refresh(): Promise<RuntimeSnapshot> {
    return (this.inflight ??= this.load().finally(() => { this.inflight = null; }));
  }

  private async load(): Promise<RuntimeSnapshot> {
    const [settings, rows] = await Promise.all([this.d.store.settings(), this.d.store.sealed()]);
    const kr = this.d.keyring();
    const keys: Record<string, string> = {};
    const unreadable: string[] = [];
    for (const r of rows) {
      if (!isProviderKeyName(r.name)) continue; // the DB check constraint already refuses these
      if (!kr) { unreadable.push(r.name); continue; }
      try { keys[r.name] = open(r.sealed, kr, providerKeyContext(r.name)); } catch { unreadable.push(r.name); }
    }
    if (unreadable.length) {
      this.warnOnce(`unreadable:${unreadable.join(',')}`, kr
        ? `[settings] could not decrypt dashboard key(s) ${unreadable.join(', ')}: replace them in Admin → API & AI (the .env values stay in use)`
        : `[settings] VAULT_MASTER_KEY is not set: ${unreadable.length} dashboard key(s) ignored (${unreadable.join(', ')})`);
    }
    const applied = (this.d.applyKeys ?? setProviderKeyOverlay)(keys);
    const next: RuntimeSnapshot = {
      keys: applied, unreadable, dashboard: parseDashboardAi(settings), legacyDaily: settings.daily_budget_usd, loadedAt: (this.d.now ?? Date.now)(),
    };
    const changes = describeChanges(this.snapshot, next);
    const first = this.snapshot === null;
    this.snapshot = next;
    if (changes.length && !first) this.log(`[settings] updated from the dashboard: ${changes.join('; ')}`);
    this.d.onChange?.(next, changes);
    return next;
  }

  /** Refreshes every everyMs (errors are logged, never thrown). Returns a stop function. */
  start(everyMs = 60_000): () => void {
    const t = setInterval(() => {
      this.refresh().catch((e) => this.warnOnce(`refresh:${e instanceof Error ? e.message : ''}`,
        `[settings] could not re-read dashboard settings (keeping the last ones): ${e instanceof Error ? e.message.slice(0, 200) : 'error'}`));
    }, everyMs);
    t.unref?.();
    return () => clearInterval(t);
  }
}

// ---------- effective AI settings (pure) ----------

export interface EffectiveAi {
  profile: string;
  profileSource: SettingSource;
  monthlyBudgetUsd: number;
  monthlySource: SettingSource;
  /** null = no daily cap. */
  dailyBudgetUsd: number | null;
  dailySource: SettingSource;
  modelIds: Partial<Record<ModelRole, { spec: string; source: 'dashboard' | 'env' }>>;
  warnings: string[];
}

/**
 * Resolves what the worker runs with. `env` = workerEnv() (the .env values; the dashboard keys don't matter here).
 * A dashboard profile missing from config/models.yaml is ignored with a warning (the .env / file profile is used).
 */
export function effectiveAi(env: Env, snap: Pick<RuntimeSnapshot, 'dashboard' | 'legacyDaily'> | null, cfg: Pick<ModelsConfig, 'active_profile' | 'profiles'>): EffectiveAi {
  const dash = snap?.dashboard ?? EMPTY_AI;
  const warnings: string[] = [];
  let dashProfile = dash.profile;
  if (dashProfile && !cfg.profiles[dashProfile]) {
    warnings.push(`The dashboard profile "${dashProfile}" is not in config/models.yaml: using the .env / file profile.`);
    dashProfile = null;
  }
  const p = effectiveProfile(dashProfile, env.MODEL_PROFILE, cfg.active_profile);
  const m = effectiveMonthlyBudget(dash.monthlyBudgetUsd, env.MONTHLY_BUDGET_USD);
  const d = effectiveDailyBudget(dash.dailyBudgetUsd, env.DAILY_AI_BUDGET_USD, snap?.legacyDaily);
  const modelIds: EffectiveAi['modelIds'] = {};
  for (const role of MODEL_ROLES) {
    const fromDash = dash.modelIds[role];
    const fromEnv = env[modelIdEnvVar(role)]?.trim();
    if (fromDash) modelIds[role] = { spec: fromDash, source: 'dashboard' };
    else if (fromEnv) modelIds[role] = { spec: fromEnv, source: 'env' };
  }
  return {
    profile: p.profile, profileSource: p.source, monthlyBudgetUsd: m.usd, monthlySource: m.source,
    dailyBudgetUsd: d.usd, dailySource: d.source, modelIds, warnings,
  };
}

/** The env the router sees: workerEnv() with the dashboard's per-role models as MODEL_ID_<ROLE> (dashboard wins). */
export function routerEnv(env: Env, dashboard: DashboardAi | null | undefined): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const [role, spec] of Object.entries(dashboard?.modelIds ?? {})) if (spec) out[modelIdEnvVar(role as ModelRole)] = spec;
  return out;
}

/**
 * The daily cap handed to the loop's GlobalDailyBudget: the dashboard value, else DAILY_AI_BUDGET_USD, else null (the
 * budget then reads settings.daily_budget_usd itself, as before). 0 = no cap.
 */
export function loopDailyBudget(dashboard: DashboardAi | null | undefined, envDaily: number | null): number | null {
  return dashboard?.dailyBudgetUsd ?? envDaily;
}
