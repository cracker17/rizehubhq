// /budget: today's and this month's model spend (activity_log.cost_usd) in the HQ timezone.
import { effectiveDailyBudget, effectiveMonthlyBudget, parseDashboardAi } from '@rizehubhq/shared';
import type { SpendRow } from './types';

/**
 * The caps /budget shows, with the worker's precedence (packages/shared aiSettings.ts): the CEO's dashboard value
 * (Admin → API & AI) → the .env value → default (monthly 0; daily: older settings.daily_budget_usd, else none).
 */
export function budgetCaps(env: { monthlyBudgetUsd: number | null; dailyBudgetUsd: number | null }, settings: Record<string, unknown>): { monthly: number; daily: number | null } {
  const dash = parseDashboardAi(settings);
  const str = (n: number | null) => (n === null ? undefined : String(n));
  return {
    monthly: effectiveMonthlyBudget(dash.monthlyBudgetUsd, str(env.monthlyBudgetUsd)).usd,
    daily: effectiveDailyBudget(dash.dailyBudgetUsd, str(env.dailyBudgetUsd), settings.daily_budget_usd).usd,
  };
}

export interface SpendSummary { today: number; month: number; topToday: { actor: string; usd: number }[] }

export function localDate(d: Date, tz: string): string {
  return d.toLocaleDateString('en-CA', { timeZone: tz });
}

export function summarizeSpend(rows: SpendRow[], now: Date, tz = 'Asia/Manila'): SpendSummary {
  const today = localDate(now, tz);
  const month = today.slice(0, 7);
  let t = 0, m = 0;
  const byActor = new Map<string, number>();
  for (const r of rows) {
    const usd = Number(r.cost_usd) || 0;
    if (!usd) continue;
    const day = localDate(new Date(r.created_at), tz);
    if (day.slice(0, 7) === month) m += usd;
    if (day === today) { t += usd; byActor.set(r.actor, (byActor.get(r.actor) ?? 0) + usd); }
  }
  const topToday = [...byActor.entries()].map(([actor, usd]) => ({ actor, usd })).sort((a, b) => b.usd - a.usd).slice(0, 3);
  return { today: t, month: m, topToday };
}
