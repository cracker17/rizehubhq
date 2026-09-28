import 'server-only';
// Daily Reports page data (docs/06 §5). Rows come from `reports` (written by the worker, see
// apps/worker/src/reportsJob.ts); `data` holds the structured digest / brief / weekly fields.
// DEMO mode (no Supabase env) gets realistic generated reports for the last 30 days.
import { createSupabaseServer } from '@/lib/supabase/server';
import { supabaseEnv } from '@/lib/env';

type Numeric = number | string;
export type ReportKind = 'standup' | 'daily_digest' | 'morning_brief' | 'weekly';

export interface ReportRow {
  id: string;
  agent_id: string | null;
  report_date: string;
  kind: ReportKind;
  done: string[];
  next: string[];
  blockers: string[];
  body_md: string | null;
  cost_usd: Numeric;
  data: Record<string, unknown> | null;
  created_at: string;
}

export interface DigestLine { title: string; agent_id: string | null; client: string | null; note?: string }
export interface DigestData {
  headline: string;
  counts: { done: number; in_progress: number; blocked: number; approvals_waiting: number; requests_created: number };
  qa: { reviews: number; passed: number; pass_rate: number | null };
  spend_usd: number;
  done: DigestLine[];
  in_progress: DigestLine[];
  blocked: DigestLine[];
  approvals: DigestLine[];
  clients: { name: string; done: number; in_progress: number; blocked: number; spend_usd: number }[];
  standups: number;
}
export interface MorningData {
  headline: string;
  queue: DigestLine[];
  in_progress: DigestLine[];
  due_soon: { title: string; due_date: string; client: string | null; status: string }[];
  approvals: DigestLine[];
  blocked: DigestLine[];
  yesterday: { done: number; spend_usd: number };
}
export interface WeeklyData {
  headline: string;
  range: { from: string; to: string };
  done: number;
  spend_usd: number;
  requests_created: number;
  qa: { reviews: number; passed: number; pass_rate: number | null };
  qa_trend: { date: string; reviews: number; pass_rate: number | null }[];
  by_department: { department: string; done: number }[];
  cost_by_client: { name: string; usd: number }[];
  cost_by_agent: { agent_id: string; usd: number }[];
  bottlenecks: string[];
}

export interface ReportsForDate {
  date: string;
  today: string;
  digest: (ReportRow & { data: DigestData }) | null;
  morning: (ReportRow & { data: MorningData }) | null;
  standups: ReportRow[];
  weekly: (ReportRow & { data: WeeklyData }) | null;
  error?: string;
}

// ---------- dates (Asia/Manila) ----------
export const TZ = 'Asia/Manila';
export function manilaToday(now = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: TZ });
}
export function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** Monday of the week containing `date`. */
export function mondayOf(date: string): string {
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((wd + 6) % 7));
}

// ---------- loader ----------
const COLS = 'id,agent_id,report_date,kind,done,next,blockers,body_md,cost_usd,data,created_at';

export async function loadReports(date: string): Promise<ReportsForDate> {
  const today = manilaToday();
  if (!supabaseEnv()) return demoReports(date, today);
  const db = await createSupabaseServer();
  if (!db) return demoReports(date, today);
  const [day, weekly] = await Promise.all([
    db.from('reports').select(COLS).eq('report_date', date).order('agent_id'),
    db.from('reports').select(COLS).eq('kind', 'weekly').lte('report_date', addDays(mondayOf(date), 6)).order('report_date', { ascending: false }).limit(1),
  ]);
  const error = day.error?.message ?? weekly.error?.message;
  const rows = (day.data ?? []) as ReportRow[];
  const one = <T,>(kind: ReportKind) => (rows.find((r) => r.kind === kind && r.data && Object.keys(r.data).length) ?? null) as (ReportRow & { data: T }) | null;
  const w = ((weekly.data ?? [])[0] ?? null) as ReportRow | null;
  return {
    date, today,
    digest: one<DigestData>('daily_digest'),
    morning: one<MorningData>('morning_brief'),
    standups: rows.filter((r) => r.kind === 'standup'),
    weekly: w && w.data && Object.keys(w.data).length ? (w as ReportRow & { data: WeeklyData }) : null,
    error,
  };
}

// ---------- DEMO data ----------
function rng(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0) / 4294967296;
}

// [agent, client, title] — same agents and clients as src/lib/mock.ts
const WORK: [string, string | null, string][] = [
  ['writer', 'Madam Muse', 'Bundle landing page copy'],
  ['writer', 'Vinyl Icons', 'September SEO blog: vinyl care guide'],
  ['designer', 'Madam Muse', 'Bundle page wireframe'],
  ['web-dev', 'Madam Muse', 'Bundle builder section (unpublished theme)'],
  ['web-dev', 'LvlUp Ventures', 'Ecosystem Initiatives CMS grid'],
  ['designer', 'Madam Muse', '3 bundle ad creatives'],
  ['writer', 'IO', 'October content calendar'],
  ['writer', 'IO', 'Club O reel script (30s)'],
  ['web-dev', 'MVS Psychology', 'Halaxy booking webhook'],
  ['sales', null, 'Threads lead list: 25 Shopify DTC founders'],
  ['sales', null, 'OnlineJobs.ph shortlist + drafts'],
  ['sales', 'Sagebeet', 'Proposal: Shopify speed retainer'],
  ['web-dev', 'Brisbane Coffee Co', 'Plugin update + speed pass'],
];

function line(w: [string, string | null, string], note?: string): DigestLine {
  return { agent_id: w[0], client: w[1], title: w[2], note };
}

function row<T extends Record<string, unknown>>(id: string, date: string, kind: ReportKind, agent: string | null, data: T, extra: Partial<ReportRow> = {}): ReportRow & { data: T } {
  const hour = kind === 'morning_brief' ? '08:00' : kind === 'weekly' ? '08:01' : '18:00';
  return {
    id, agent_id: agent, report_date: date, kind, done: [], next: [], blockers: [], body_md: null, cost_usd: 0,
    created_at: new Date(`${date}T${hour}:00+08:00`).toISOString(), ...extra, data,
  };
}

function demoDigest(date: string, today: string) {
  const r = rng(date);
  const shuffled = [...WORK].sort(() => r() - 0.5);
  const nDone = 3 + Math.floor(r() * 4);
  const done = shuffled.slice(0, nDone);
  const prog = shuffled.slice(nDone, nDone + 3 + Math.floor(r() * 2));
  const blocked = date === today || r() > 0.4 ? [line(['designer', 'Vinyl Icons', 'Record Store Day banner set'], 'Missing brand fonts: asked the client for the .otf files')] : [];
  const approvals: DigestLine[] = [
    { title: 'Plan: Vinyl Icons October SEO report', agent_id: 'coo', client: null, note: 'Plan' },
    { title: 'Bundle page wireframe', agent_id: 'designer', client: null, note: 'Deliverable' },
    ...(r() > 0.5 ? [{ title: 'Action: publish · IO October calendar to Meta Business Suite', agent_id: 'writer', client: null, note: 'Action' }] : []),
  ];
  const reviews = 4 + Math.floor(r() * 6);
  const passed = Math.max(1, reviews - 1 - Math.floor(r() * 2));
  const spend = Math.round((0.6 + r() * 2.4) * 100) / 100;
  const byClient = new Map<string, { name: string; done: number; in_progress: number; blocked: number; spend_usd: number }>();
  const c = (name: string | null) => { if (!name) return null; let v = byClient.get(name); if (!v) { v = { name, done: 0, in_progress: 0, blocked: 0, spend_usd: 0 }; byClient.set(name, v); } return v; };
  done.forEach((w) => { const x = c(w[1]); if (x) { x.done++; x.spend_usd += Math.round(r() * 40) / 100; } });
  prog.forEach((w) => { const x = c(w[1]); if (x) { x.in_progress++; x.spend_usd += Math.round(r() * 25) / 100; } });
  blocked.forEach((b) => { const x = c(b.client); if (x) x.blocked++; });
  const needs = blocked.length + approvals.length;
  const data: DigestData = {
    headline: `${done.length} tasks shipped: ${done[0]![1] ?? 'internal'} work led the day. ${needs} item${needs === 1 ? '' : 's'} need you, starting with the ${approvals[0]!.title.replace(/^Plan: /, '')} plan; $${spend.toFixed(2)} spent.`,
    counts: { done: done.length, in_progress: prog.length, blocked: blocked.length, approvals_waiting: approvals.length, requests_created: 1 + Math.floor(r() * 3) },
    qa: { reviews, passed, pass_rate: Math.round((passed / reviews) * 100) },
    spend_usd: spend,
    done: done.map((w) => line(w, r() > 0.7 ? '1 revision' : undefined)),
    in_progress: prog.map((w, i) => line(w, i === 0 ? 'in QA review' : i === 1 ? 'waiting for QA' : 'working')),
    blocked,
    approvals,
    clients: [...byClient.values()].map((x) => ({ ...x, spend_usd: Math.round(x.spend_usd * 100) / 100 })).sort((a, b) => b.done + b.in_progress - a.done - a.in_progress),
    standups: 0,
  };
  return { data, done, prog, blocked, r };
}

function demoStandups(date: string, d: ReturnType<typeof demoDigest>): ReportRow[] {
  // one standup per agent per day (the six agents each own several lines of work)
  const acc = new Map<string, { done: string[]; next: string[]; blockers: string[]; cost: number }>();
  const add = (agent: string, done: string[], next: string[], blockers: string[], cost: number) => {
    const a = acc.get(agent) ?? { done: [], next: [], blockers: [], cost: 0 };
    a.done.push(...done); a.next.push(...next); a.blockers.push(...blockers); a.cost = Math.round((a.cost + cost) * 100) / 100;
    acc.set(agent, a);
  };
  const r = d.r;
  add('coo', ['Planned the Vinyl Icons October SEO report (4 tasks) and sent it to you', 'Re-planned the IO reel after your note: now a 30s script with on-screen captions'],
    ['Route tomorrow’s Madam Muse follow-ups once the wireframe is approved'], ['The Vinyl Icons SEO report plan is waiting for your approval'], 0.21);
  add('qa-lead', [`Reviewed ${d.data.qa.reviews} deliverables: ${d.data.qa.passed} passed, ${d.data.qa.reviews - d.data.qa.passed} sent back with fix lists`],
    [`Review ${d.prog.length > 1 ? 2 : 1} deliverables waiting for QA`], [], 0.34);
  for (const w of d.done) {
    const nextWork = WORK.find((x) => x[0] === w[0] && x !== w);
    add(w[0], [`Finished “${w[2]}”${w[1] ? ` for ${w[1]}` : ''}; you approved it`],
      nextWork ? [`Start “${nextWork[2]}”`] : ['Pick up the next task from the queue'], [], Math.round(r() * 40) / 100);
  }
  d.prog.forEach((w, i) => {
    add(w[0], i === 1 ? [`Submitted “${w[2]}” for QA`] : [`Got “${w[2]}” to ${50 + Math.floor(r() * 40)}%`],
      i === 0 ? [`Fix the QA notes on “${w[2]}” (revision 1)`] : [`Finish “${w[2]}”`], [], Math.round(r() * 30) / 100);
  });
  if (d.blocked.length) add('designer', ['Drafted 2 of 4 Record Store Day banners'], ['Finish the banner set once the fonts arrive'], ['“Record Store Day banner set” is stuck: missing brand fonts (.otf) from Vinyl Icons'], 0.12);
  const out: ReportRow[] = [...acc].map(([agent, a]) =>
    ({ ...row(`s-${agent}-${date}`, date, 'standup', agent, { spend_usd: a.cost }), done: a.done, next: a.next, blockers: a.blockers, cost_usd: a.cost }));
  return out.sort((a, b) => (b.blockers.length - a.blockers.length) || (a.agent_id ?? '').localeCompare(b.agent_id ?? ''));
}

function demoWeekly(monday: string): ReportRow & { data: WeeklyData } {
  const r = rng(`week-${monday}`);
  const from = addDays(monday, -7);
  const trend = Array.from({ length: 7 }, (_, i) => {
    const reviews = i >= 5 ? Math.floor(r() * 3) : 4 + Math.floor(r() * 6);
    return { date: addDays(from, i), reviews, pass_rate: reviews ? Math.round(62 + r() * 36) : null };
  });
  const reviews = trend.reduce((s, d) => s + d.reviews, 0);
  const passed = trend.reduce((s, d) => s + Math.round(d.reviews * (d.pass_rate ?? 0) / 100), 0);
  const depts = [['content', 11], ['dev', 7], ['design', 6], ['growth', 5], ['leadership', 2]] as const;
  const by_department = depts.map(([department, n]) => ({ department, done: Math.max(1, Math.round(n * (0.7 + r() * 0.6))) })).sort((a, b) => b.done - a.done);
  const done = by_department.reduce((s, d) => s + d.done, 0);
  const cost_by_client = [['Madam Muse', 3.9], ['Vinyl Icons', 2.4], ['IO', 2.1], ['LvlUp Ventures', 1.3], ['MVS Psychology', 0.9], ['Sagebeet', 0.5]]
    .map(([name, v]) => ({ name: name as string, usd: Math.round((v as number) * (0.7 + r() * 0.6) * 100) / 100 })).sort((a, b) => b.usd - a.usd);
  const spend = Math.round((cost_by_client.reduce((s, c) => s + c.usd, 0) + 2.2) * 100) / 100;
  const rate = reviews ? Math.round((passed / reviews) * 100) : null;
  const data: WeeklyData = {
    headline: `${done} tasks delivered for 6 clients at $${spend.toFixed(2)} in model spend; QA first-pass rate ${rate}%, with Madam Muse’s bundle launch the biggest workstream.`,
    range: { from, to: addDays(from, 6) }, done, spend_usd: spend, requests_created: 9 + Math.floor(r() * 6),
    qa: { reviews, passed, pass_rate: rate }, qa_trend: trend, by_department, cost_by_client,
    cost_by_agent: [{ agent_id: 'web-dev', usd: 2.8 }, { agent_id: 'writer', usd: 1.9 }, { agent_id: 'qa-lead', usd: 1.6 }],
    bottlenecks: [
      '“Bundle builder section” needed 3 QA revisions: acceptance criteria were missing mobile breakpoints',
      '2 approvals waited on you for over a day (plans are the slowest step this week)',
      '“Record Store Day banner set” is blocked on client fonts',
    ],
  };
  return row(`w-${monday}`, monday, 'weekly', 'coo', data as unknown as Record<string, unknown>) as unknown as ReportRow & { data: WeeklyData };
}

export function demoReports(date: string, today = manilaToday()): ReportsForDate {
  const inRange = date <= today && date >= addDays(today, -30);
  const lastMonday = mondayOf(date > today ? today : date);
  const weekly = lastMonday >= addDays(mondayOf(today), -28) ? demoWeekly(lastMonday) : null;
  if (!inRange) return { date, today, digest: null, morning: null, standups: [], weekly };
  const d = demoDigest(date, today);
  const standups = demoStandups(date, d);
  d.data.standups = standups.length;
  const digest = row(`d-${date}`, date, 'daily_digest', 'coo', d.data as unknown as Record<string, unknown>) as unknown as ReportRow & { data: DigestData };
  const morningData: MorningData = {
    headline: `Good morning. ${d.prog.length + 3} tasks on the board, ${d.data.approvals.length} approvals waiting, 2 due in the next 3 days.`,
    queue: WORK.slice(9, 12).map((w) => line(w)),
    in_progress: d.prog.map((w) => line(w, 'working')),
    due_soon: [
      { title: 'Madam Muse bundle launch', due_date: addDays(date, 2), client: 'Madam Muse', status: 'in_progress' },
      { title: 'Vinyl Icons monthly SEO report', due_date: addDays(date, 3), client: 'Vinyl Icons', status: 'plan_review' },
    ],
    approvals: d.data.approvals.slice(0, 2),
    blocked: d.data.blocked,
    yesterday: { done: 4, spend_usd: 1.37 },
  };
  const morning = row(`m-${date}`, date, 'morning_brief', 'coo', morningData as unknown as Record<string, unknown>) as unknown as ReportRow & { data: MorningData };
  return { date, today, digest, morning, standups, weekly };
}
