import 'server-only';
// /costs page data (docs/14 "Usage meter"). LIVE: the ai_usage view (last 31 Manila days + the month so far), client
// names, task titles and the daily cap (DAILY_AI_BUDGET_USD, else settings.daily_budget_usd). DEMO (no Supabase env):
// generated paid-profile usage. Aggregation lives in ./costsModel.ts (unit-tested).
import { createSupabaseServer } from '@/lib/supabase/server';
import { supabaseEnv } from '@/lib/env';
import { manilaToday } from './reports';
import { addDays, DEMO_CLIENTS, DEMO_TASK_INFO, demoUsageRows, parseDailyCap, summarizeCosts, type CostSummary, type TaskInfo, type UsageRow } from './costsModel';

export interface CostsPage { summary: CostSummary; mode: 'demo' | 'live'; error?: string }

const COLS = 'id,created_at,usage_day,agent_id,kind,task_id,client_id,provider,model,tokens_in,tokens_out,cached_in,cost_usd';
const PAGE = 1000;
const MAX_ROWS = 20_000;

export async function loadCosts(rangeDays: 7 | 30): Promise<CostsPage> {
  const today = manilaToday();
  const cap = (setting?: unknown) => parseDailyCap(process.env.DAILY_AI_BUDGET_USD, setting);
  const demo = (): CostsPage => ({
    mode: 'demo',
    summary: summarizeCosts(demoUsageRows(today), { today, rangeDays, budgetUsd: cap(5), clientNames: DEMO_CLIENTS, tasks: DEMO_TASK_INFO }),
  });
  if (!supabaseEnv()) return demo();
  const db = await createSupabaseServer();
  if (!db) return demo();

  // From the earlier of: 30 days back, the 1st of this month (month total).
  const from = [addDays(today, -30), `${today.slice(0, 7)}-01`].sort()[0]!;
  const rows: UsageRow[] = [];
  let error: string | undefined;
  for (let at = 0; at < MAX_ROWS; at += PAGE) {
    const { data, error: e } = await db.from('ai_usage').select(COLS).gte('usage_day', from).order('id').range(at, at + PAGE - 1);
    if (e) { error = e.message; break; }
    rows.push(...((data ?? []) as UsageRow[]));
    if ((data ?? []).length < PAGE) break;
  }

  const [clients, settings] = await Promise.all([
    db.from('clients').select('id,name'),
    db.from('settings').select('value').eq('key', 'daily_budget_usd').maybeSingle(),
  ]);
  const clientNames = Object.fromEntries(((clients.data ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]));

  // Titles for the most expensive tasks only.
  const first = summarizeCosts(rows, { today, rangeDays, budgetUsd: null, clientNames, topN: 8 });
  const ids = first.topTasks.map((t) => t.task_id);
  const tasks: Record<string, TaskInfo> = {};
  if (ids.length) {
    const { data } = await db.from('tasks').select('id,title,agent_id,client_id').in('id', ids);
    for (const t of (data ?? []) as ({ id: string } & TaskInfo)[]) tasks[t.id] = { title: t.title, agent_id: t.agent_id, client_id: t.client_id };
  }
  error ??= clients.error?.message;
  return {
    mode: 'live', error,
    summary: summarizeCosts(rows, { today, rangeDays, budgetUsd: cap((settings.data as { value?: unknown } | null)?.value), clientNames, tasks }),
  };
}
