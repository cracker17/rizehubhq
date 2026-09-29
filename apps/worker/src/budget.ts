// Budget guards (docs/09 "Budgets", docs/14): per-agent daily spend (agents.daily_budget_usd, Asia/Manila day)
// is checked before a claimed task starts. Manila has no DST: a Manila day/month starts at 00:00 +08:00.
import type { HqDb, TaskRow } from './hqdb';

export const MANILA_OFFSET = '+08:00';
export const manilaDay = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
export const manilaMonth = (d = new Date()) => manilaDay(d).slice(0, 7);
/** ISO instant of 00:00 Manila on d's Manila day. */
export const manilaDayStartIso = (d = new Date()) => new Date(`${manilaDay(d)}T00:00:00${MANILA_OFFSET}`).toISOString();
/** ISO instant of 00:00 Manila on the 1st of d's Manila month. */
export const manilaMonthStartIso = (d = new Date()) => new Date(`${manilaMonth(d)}-01T00:00:00${MANILA_OFFSET}`).toISOString();

export interface DailyBudgetCheck { over: boolean; spentUsd: number; budgetUsd: number | null; day: string }

/**
 * Over budget when the agent has spent money today and reached its daily_budget_usd. Free-tier runs cost $0 and
 * never block; budget 0 means "no paid spend at all". A missing budget (null) means no per-agent limit.
 */
export function isOverDaily(spentUsd: number, budgetUsd: number | null): boolean {
  if (budgetUsd === null || !Number.isFinite(budgetUsd)) return false;
  return spentUsd > 0 && spentUsd >= budgetUsd;
}

export class DailyBudgetGuard {
  private cache = new Map<string, { at: number; check: DailyBudgetCheck }>();

  constructor(private db: Pick<HqDb, 'getAgent' | 'agentSpendSinceUsd'>, private o: { now?: () => Date; cacheMs?: number } = {}) {}

  private now() { return this.o.now?.() ?? new Date(); }

  async check(agentId: string): Promise<DailyBudgetCheck> {
    const now = this.now();
    const day = manilaDay(now);
    const hit = this.cache.get(agentId);
    if (hit && hit.check.day === day && now.getTime() - hit.at < (this.o.cacheMs ?? 30_000)) return hit.check;
    const agent = await this.db.getAgent(agentId);
    const raw = agent?.daily_budget_usd;
    const budgetUsd = raw === undefined || raw === null || raw === '' ? null : Number(raw);
    const spentUsd = await this.db.agentSpendSinceUsd(agentId, manilaDayStartIso(now));
    const check = { over: isOverDaily(spentUsd, budgetUsd), spentUsd, budgetUsd, day };
    this.cache.set(agentId, { at: now.getTime(), check });
    return check;
  }

  /** Forget cached numbers (e.g. after a task finished and recorded its cost). */
  invalidate(agentId?: string) { if (agentId) this.cache.delete(agentId); else this.cache.clear(); }
}

export function overBudgetNote(task: Pick<TaskRow, 'agent_id'>, c: DailyBudgetCheck): string {
  return `Daily budget reached for ${task.agent_id}: $${c.spentUsd.toFixed(2)} spent of $${(c.budgetUsd ?? 0).toFixed(2)} today `
    + `(Asia/Manila ${c.day}). Task stays queued and starts after midnight Manila time, or when the CEO raises the agent's daily budget.`;
}

// ---------- global daily AI budget (DAILY_AI_BUDGET_USD): all agents + planning + QA + reports + chat ----------

/** Telegram alerts fire once per Manila day at each level (budget_alerts table; the bot sends them). */
export const BUDGET_ALERT_LEVELS = [80, 100] as const;

export interface GlobalBudgetCheck { over: boolean; spentUsd: number; budgetUsd: number | null; day: string; pct: number | null }

/**
 * The daily cap: DAILY_AI_BUDGET_USD when set, else settings.daily_budget_usd, else none. 0 means "no cap" (an
 * explicit DAILY_AI_BUDGET_USD=0 also ignores settings); values that are not a finite number ≥ 0 are ignored.
 */
export function resolveDailyBudget(envValue: number | null | undefined, settings: Record<string, unknown> = {}): number | null {
  const ok = (v: unknown) => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) && n >= 0 ? n : null; };
  const env = ok(envValue);
  if (env !== null) return env > 0 ? env : null;
  const fromSettings = ok(settings.daily_budget_usd);
  return fromSettings ? fromSettings : null;
}

export class GlobalDailyBudget {
  private cache: { at: number; check: GlobalBudgetCheck } | null = null;
  private alerted = new Set<string>();

  constructor(
    private db: Pick<HqDb, 'spendSinceUsd' | 'recordBudgetAlert' | 'getSettings'>,
    private o: { budgetUsd?: number | null; now?: () => Date; cacheMs?: number; log?: (m: string) => void } = {},
  ) {}

  private now() { return this.o.now?.() ?? new Date(); }

  /** Today's spend vs the cap; records the 80% / 100% alerts (idempotent per day and level). */
  async check(): Promise<GlobalBudgetCheck> {
    const now = this.now();
    const day = manilaDay(now);
    if (this.cache && this.cache.check.day === day && now.getTime() - this.cache.at < (this.o.cacheMs ?? 30_000)) return this.cache.check;
    const budgetUsd = resolveDailyBudget(this.o.budgetUsd, this.o.budgetUsd == null ? await this.db.getSettings() : {});
    const spentUsd = budgetUsd === null ? 0 : await this.db.spendSinceUsd(manilaDayStartIso(now));
    const pct = budgetUsd ? Math.round((spentUsd / budgetUsd) * 1000) / 10 : null;
    const check: GlobalBudgetCheck = { over: isOverDaily(spentUsd, budgetUsd), spentUsd, budgetUsd, day, pct };
    this.cache = { at: now.getTime(), check };
    if (budgetUsd) {
      for (const level of BUDGET_ALERT_LEVELS) {
        const key = `${day}:${level}`;
        if (spentUsd < (budgetUsd * level) / 100 || this.alerted.has(key)) continue;
        try {
          await this.db.recordBudgetAlert(day, level, spentUsd, budgetUsd);
          this.alerted.add(key);
        } catch (e) { this.o.log?.(`[worker] could not record the ${level}% budget alert: ${e instanceof Error ? e.message : String(e)}`); }
      }
    }
    return check;
  }

  /** Forget the cached figure (e.g. a run just recorded its cost). */
  invalidate() { this.cache = null; }
}

/** Logged once per day when the cap is hit but free models (free profile keys) keep the team working. */
export function freeFallbackNote(c: GlobalBudgetCheck): string {
  return `Daily AI budget reached: $${c.spentUsd.toFixed(2)} spent of $${(c.budgetUsd ?? 0).toFixed(2)} today (Asia/Manila ${c.day}). `
    + 'Paid providers (Anthropic, OpenAI, Kimi, paid OpenRouter) are stopped until midnight Manila time; new work runs on the free profile models.';
}

export function globalBudgetNote(c: GlobalBudgetCheck): string {
  return `Daily AI budget reached: $${c.spentUsd.toFixed(2)} spent of $${(c.budgetUsd ?? 0).toFixed(2)} today (Asia/Manila ${c.day}). `
    + 'No new planning, tasks or QA reviews start until midnight Manila time or until DAILY_AI_BUDGET_USD is raised; running work finishes.';
}
