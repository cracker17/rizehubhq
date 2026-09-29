// Cost dashboard model (docs/14 "Usage meter"): pure aggregation of ai_usage rows (one row per model run, see
// supabase/migrations/20260928100000_costs_handoff.sql) + DEMO rows. No server imports, so it is unit-tested.

type Numeric = number | string | null;

/** One ai_usage row (numeric columns may arrive as strings from PostgREST). */
export interface UsageRow {
  id: number | string;
  created_at: string;
  usage_day: string; // Asia/Manila YYYY-MM-DD
  agent_id: string;
  kind: string; // task | plan | qa | chat | report
  task_id: string | null;
  client_id: string | null;
  provider: string | null;
  model: string | null;
  tokens_in: Numeric;
  tokens_out: Numeric;
  cached_in: Numeric;
  cost_usd: Numeric;
}

export interface TaskInfo { title: string; agent_id: string; client_id: string | null }

export type MeterLevel = 'none' | 'ok' | 'warn' | 'over';
export const FREE_PROVIDERS = ['google', 'groq', 'openrouter'];
/** Same rule as the worker router (isPaidSpec): paid providers (Anthropic, OpenAI, Moonshot/Kimi) and OpenRouter models without ":free". */
export const isPaidModel = (provider: string, model: string) =>
  !FREE_PROVIDERS.includes(provider) || (provider === 'openrouter' && !model.endsWith(':free'));

export interface CostSummary {
  today: string;
  rangeDays: 7 | 30;
  budgetUsd: number | null;
  todayUsd: number;
  /** today / cap × 100 (null without a cap). */
  pct: number | null;
  level: MeterLevel;
  rangeUsd: number;
  monthUsd: number;
  runs: number;
  /** Share of input tokens read from the prompt cache (paid providers only; null when no paid input). */
  cacheReadPct: number | null;
  /** Oldest → newest, zero-filled, one entry per Manila day in the range. */
  days: { date: string; usd: number; runs: number }[];
  byAgent: { agent_id: string; usd: number; runs: number }[];
  byClient: { client_id: string | null; name: string; usd: number; runs: number }[];
  topTasks: { task_id: string; title: string; agent_id: string; client: string | null; usd: number; runs: number }[];
  modelMix: { model: string; provider: string; paid: boolean; usd: number; runs: number; tokens: number; sharePct: number }[];
}

const n = (v: Numeric | undefined) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const r4 = (v: number) => Math.round(v * 10_000) / 10_000;

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** DAILY_AI_BUDGET_USD / settings.daily_budget_usd → cap in USD; 0, empty or invalid = no cap (same rule as the worker). */
export function parseDailyCap(envValue: string | undefined, setting?: unknown): number | null {
  const ok = (v: unknown) => { const x = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(x) && x >= 0 ? x : null; };
  const env = ok(envValue);
  if (env !== null) return env > 0 ? env : null;
  const s = ok(setting);
  return s ? s : null;
}

export function meterLevel(todayUsd: number, budgetUsd: number | null): MeterLevel {
  if (!budgetUsd) return 'none';
  if (todayUsd >= budgetUsd) return 'over';
  return todayUsd >= budgetUsd * 0.8 ? 'warn' : 'ok';
}

function bump<K>(m: Map<K, { usd: number; runs: number }>, k: K, usd: number) {
  const v = m.get(k) ?? { usd: 0, runs: 0 };
  v.usd += usd; v.runs += 1;
  m.set(k, v);
}

/**
 * Aggregates usage rows for the /costs page. `rows` should cover at least the month so far and the range
 * (the loader reads 31 days); rows outside the range only count toward the month total.
 */
export function summarizeCosts(rows: UsageRow[], o: {
  today: string; rangeDays?: 7 | 30; budgetUsd: number | null;
  clientNames?: Record<string, string>; tasks?: Record<string, TaskInfo>; topN?: number;
}): CostSummary {
  const rangeDays = o.rangeDays ?? 30;
  const from = addDays(o.today, -(rangeDays - 1));
  const month = o.today.slice(0, 7);
  const days = new Map<string, { usd: number; runs: number }>();
  for (let i = 0; i < rangeDays; i++) days.set(addDays(from, i), { usd: 0, runs: 0 });
  const agents = new Map<string, { usd: number; runs: number }>();
  const clients = new Map<string | null, { usd: number; runs: number }>();
  const tasks = new Map<string, { usd: number; runs: number; agent: string; client: string | null }>();
  const models = new Map<string, { provider: string; usd: number; runs: number; tokens: number }>();
  let todayUsd = 0; let monthUsd = 0; let rangeUsd = 0; let runs = 0; let paidIn = 0; let paidCached = 0;

  for (const r of rows) {
    const usd = n(r.cost_usd);
    const day = r.usage_day;
    if (day === o.today) todayUsd += usd;
    if (day.slice(0, 7) === month && day <= o.today) monthUsd += usd;
    if (day < from || day > o.today) continue;
    runs++; rangeUsd += usd;
    bump(days, day, usd);
    bump(agents, r.agent_id, usd);
    bump(clients, r.client_id, usd);
    if (r.task_id) {
      const t = tasks.get(r.task_id) ?? { usd: 0, runs: 0, agent: r.agent_id, client: r.client_id };
      t.usd += usd; t.runs += 1;
      if (r.kind === 'task') t.agent = r.agent_id; // the owner, not the QA reviewer
      tasks.set(r.task_id, t);
    }
    const provider = r.provider ?? 'unknown';
    const key = `${provider}:${r.model ?? 'unknown'}`;
    const m = models.get(key) ?? { provider, usd: 0, runs: 0, tokens: 0 };
    m.usd += usd; m.runs += 1; m.tokens += n(r.tokens_in) + n(r.tokens_out);
    models.set(key, m);
    if (isPaidModel(provider, r.model ?? '')) { paidIn += n(r.tokens_in); paidCached += n(r.cached_in); }
  }

  const byUsd = <T extends { usd: number; runs: number }>(a: T, b: T) => b.usd - a.usd || b.runs - a.runs;
  const names = o.clientNames ?? {};
  const info = o.tasks ?? {};
  const budgetUsd = o.budgetUsd && o.budgetUsd > 0 ? o.budgetUsd : null;
  return {
    today: o.today, rangeDays, budgetUsd,
    todayUsd: r4(todayUsd),
    pct: budgetUsd ? Math.round((todayUsd / budgetUsd) * 1000) / 10 : null,
    level: meterLevel(todayUsd, budgetUsd),
    rangeUsd: r4(rangeUsd), monthUsd: r4(monthUsd), runs,
    cacheReadPct: paidIn ? Math.round((paidCached / paidIn) * 1000) / 10 : null,
    days: [...days].map(([date, v]) => ({ date, usd: r4(v.usd), runs: v.runs })),
    byAgent: [...agents].map(([agent_id, v]) => ({ agent_id, usd: r4(v.usd), runs: v.runs })).sort(byUsd),
    byClient: [...clients].map(([client_id, v]) => ({ client_id, name: client_id ? names[client_id] ?? 'Unknown client' : 'Internal (no client)', usd: r4(v.usd), runs: v.runs })).sort(byUsd),
    topTasks: [...tasks].map(([task_id, v]) => {
      const t = info[task_id];
      const client = t?.client_id ?? v.client;
      return { task_id, title: t?.title ?? `Task ${task_id.slice(0, 8)}`, agent_id: t?.agent_id ?? v.agent, client: client ? names[client] ?? null : null, usd: r4(v.usd), runs: v.runs };
    }).sort(byUsd).slice(0, o.topN ?? 8),
    modelMix: [...models].map(([key, v]) => ({
      model: key.slice(v.provider.length + 1), provider: v.provider, paid: isPaidModel(v.provider, key.slice(v.provider.length + 1)),
      usd: r4(v.usd), runs: v.runs, tokens: v.tokens, sharePct: rangeUsd ? Math.round((v.usd / rangeUsd) * 1000) / 10 : 0,
    })).sort(byUsd),
  };
}

// ---------- DEMO rows (no Supabase): same agents and clients as src/lib/mock.ts ----------
export const DEMO_CLIENTS: Record<string, string> = {
  'demo-madam-muse': 'Madam Muse', 'demo-vinyl-icons': 'Vinyl Icons', 'demo-io': 'IO', 'demo-lvlup': 'LvlUp Ventures', 'demo-mvs': 'MVS Psychology',
};
const DEMO_TASKS: [string, TaskInfo, number][] = [ // id, info, typical run cost
  ['demo-t1', { title: 'Bundle builder section (unpublished theme)', agent_id: 'web-dev', client_id: 'demo-madam-muse' }, 0.62],
  ['demo-t2', { title: 'Bundle page mockup + design spec', agent_id: 'designer', client_id: 'demo-madam-muse' }, 0.14],
  ['demo-t3', { title: 'September SEO blog: vinyl care guide', agent_id: 'writer', client_id: 'demo-vinyl-icons' }, 0.11],
  ['demo-t4', { title: 'Ecosystem Initiatives CMS grid', agent_id: 'web-dev', client_id: 'demo-lvlup' }, 0.48],
  ['demo-t5', { title: 'October content calendar', agent_id: 'writer', client_id: 'demo-io' }, 0.09],
  ['demo-t6', { title: 'Halaxy booking webhook', agent_id: 'web-dev', client_id: 'demo-mvs' }, 0.55],
  ['demo-t7', { title: 'Threads lead list: 25 Shopify DTC founders', agent_id: 'sales', client_id: null }, 0.21],
  ['demo-t8', { title: '3 bundle ad creatives', agent_id: 'designer', client_id: 'demo-madam-muse' }, 0.08],
];
export const DEMO_TASK_INFO: Record<string, TaskInfo> = Object.fromEntries(DEMO_TASKS.map(([id, t]) => [id, t]));
const MODEL_FOR: Record<string, [string, string]> = {
  'web-dev': ['anthropic', 'claude-sonnet-5'], sales: ['anthropic', 'claude-sonnet-5'], coo: ['anthropic', 'claude-sonnet-5'],
  designer: ['anthropic', 'claude-haiku-4-5-20251001'], writer: ['anthropic', 'claude-haiku-4-5-20251001'], 'qa-lead': ['openai', 'gpt-5.5'],
};

function rng(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0) / 4294967296;
}

/** 31 days of plausible paid-profile usage ending today (deterministic per day). */
export function demoUsageRows(today: string): UsageRow[] {
  const rows: UsageRow[] = [];
  let id = 1;
  const push = (day: string, hour: number, agent: string, kind: string, taskId: string | null, clientId: string | null, usd: number, r: () => number, free = false) => {
    const [provider, model] = free ? ['groq', 'openai/gpt-oss-120b'] : MODEL_FOR[agent] ?? ['anthropic', 'claude-sonnet-5'];
    const tokensIn = Math.round(8000 + r() * 40_000);
    rows.push({
      id: id++, created_at: new Date(`${day}T${String(hour).padStart(2, '0')}:15:00+08:00`).toISOString(), usage_day: day, agent_id: agent, kind,
      task_id: taskId, client_id: clientId, provider, model, tokens_in: tokensIn, tokens_out: Math.round(tokensIn * 0.18),
      cached_in: provider === 'anthropic' ? Math.round(tokensIn * (0.45 + r() * 0.25)) : 0, cost_usd: free ? 0 : Math.round(usd * 10_000) / 10_000,
    });
  };
  for (let i = 30; i >= 0; i--) {
    const day = addDays(today, -i);
    const r = rng(`costs-${day}`);
    const weekend = [0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());
    const nTasks = weekend ? 1 + Math.floor(r() * 2) : 3 + Math.floor(r() * 4);
    for (let k = 0; k < nTasks; k++) {
      const [taskId, t, base] = DEMO_TASKS[Math.floor(r() * DEMO_TASKS.length)]!;
      push(day, 9 + k, t.agent_id, 'task', taskId, t.client_id, base * (0.6 + r() * 0.8), r);
      push(day, 9 + k, 'qa-lead', 'qa', taskId, t.client_id, 0.04 + r() * 0.06, r);
    }
    push(day, 8, 'coo', 'plan', null, r() > 0.5 ? 'demo-madam-muse' : null, 0.03 + r() * 0.05, r);
    push(day, 18, 'coo', 'report', null, null, 0.02 + r() * 0.02, r);
    for (let c = 0; c < 3; c++) push(day, 12 + c, ['web-dev', 'writer', 'sales'][c]!, 'chat', null, null, 0, r, true);
  }
  return rows;
}
