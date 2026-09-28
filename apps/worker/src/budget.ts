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
