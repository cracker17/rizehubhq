// M7 reports (docs/05 "Scheduled work", docs/06 §5, docs/13 §7): pure builders that turn
// report_facts() (supabase/migrations/20260928030000_reports_telegram.sql) into standups, the CEO
// daily digest, the morning brief and the weekly summary. Numbers always come from the facts;
// a model may only rephrase (reportsJob.ts), so a report never fails and never invents work.

// ---------- facts (shape of report_facts()) ----------
type Num = number | string;
export interface FactTask {
  task_id: string;
  title: string;
  agent_id: string;
  client_id?: string | null;
  client_name?: string | null;
  status?: string;
  revision_count?: number;
  request_title?: string | null;
  completed_at?: string | null;
  priority?: string | null;
  due_date?: string | null;
  cost_usd?: Num;
}
export interface FactBlocked extends FactTask { kind: 'failed' | 'question'; reason: string; since: string }
export interface FactApproval { id: string; kind: string; title: string; agent_id: string | null; created_at: string; type: string | null; priority: string | null }
export interface FactEvent { actor: string; action: string; task_id: string | null; task_title: string | null; request_title: string | null; at: string; detail?: Record<string, unknown> }
export interface DayFacts {
  from: string;
  to: string;
  tz: string;
  spend_usd: Num;
  spend_by_actor: { actor: string; usd: Num }[];
  spend_by_client: { client_id: string; name: string; usd: Num }[];
  qa: { reviews: number; passed: number };
  qa_by_day: { date: string; reviews: number; passed: number }[];
  done: FactTask[];
  in_progress: FactTask[];
  queued: FactTask[];
  blocked: FactBlocked[];
  approvals_waiting: FactApproval[];
  events: FactEvent[];
  requests_created: number;
  due_soon: { id: string; title: string; due_date: string; status: string; client_name: string | null }[];
  agents: { id: string; name: string; department: string }[];
}

export function emptyFacts(from: string, to = from): DayFacts {
  return {
    from, to, tz: 'Asia/Manila', spend_usd: 0, spend_by_actor: [], spend_by_client: [], qa: { reviews: 0, passed: 0 }, qa_by_day: [],
    done: [], in_progress: [], queued: [], blocked: [], approvals_waiting: [], events: [], requests_created: 0, due_soon: [], agents: [],
  };
}

// ---------- shared helpers ----------
export const usd = (n: Num) => `$${Number(n || 0).toFixed(2)}`;
const q = (s: string | null | undefined) => `“${(s ?? 'untitled').trim()}”`;
const forClient = (t: { client_name?: string | null }) => (t.client_name ? ` (${t.client_name})` : '');
export function passRate(qa: { reviews: number; passed: number }): number | null {
  return qa.reviews ? Math.round((qa.passed / qa.reviews) * 100) : null;
}
function uniq<T>(xs: T[]): T[] { return [...new Set(xs)]; }

// ---------- standups ----------
export interface StandupLines { done: string[]; next: string[]; blockers: string[] }
export interface AgentStandup extends StandupLines { agent_id: string; name: string; cost_usd: number }

const QA_ACTIONS = ['qa.pass', 'qa.revision', 'qa.escalated'];
const MAX_LINES = 6;

/** Agents that did anything in the window (events, finished tasks or model spend). Report writes don't count. */
export function activeAgentIds(f: DayFacts): string[] {
  const known = new Set(f.agents.map((a) => a.id));
  const ids = [
    ...f.events.filter((e) => !e.action.startsWith('report.') && !e.action.startsWith('office.')).map((e) => e.actor),
    ...f.done.map((t) => t.agent_id),
    ...f.spend_by_actor.filter((s) => Number(s.usd) > 0).map((s) => s.actor),
  ];
  return uniq(ids).filter((id) => known.size === 0 || known.has(id)).sort();
}

/** Deterministic Done / Next / Blockers for one agent, straight from the facts. */
export function templateStandup(agentId: string, f: DayFacts): StandupLines {
  const done: string[] = [];
  const next: string[] = [];
  const blockers: string[] = [];
  const mine = <T extends { agent_id: string | null }>(xs: T[]) => xs.filter((x) => x.agent_id === agentId);
  const events = f.events.filter((e) => e.actor === agentId);

  const doneIds = new Set<string>();
  for (const t of mine(f.done)) {
    doneIds.add(t.task_id);
    done.push(`Finished ${q(t.title)}${forClient(t)}, approved by you`);
  }
  const submitted = new Map<string, { title: string | null; n: number }>();
  for (const e of events.filter((e) => e.action === 'task.submitted' && e.task_id && !doneIds.has(e.task_id))) {
    const s = submitted.get(e.task_id!) ?? { title: e.task_title, n: 0 };
    s.n++; submitted.set(e.task_id!, s);
  }
  for (const s of submitted.values()) done.push(`Submitted ${q(s.title)} for QA${s.n > 1 ? ` (${s.n} rounds)` : ''}`);
  for (const title of uniq(events.filter((e) => e.action === 'plan.submitted').map((e) => e.request_title ?? 'a request'))) {
    done.push(`Planned ${q(title)} and sent the plan for approval`);
  }
  const qaEvents = events.filter((e) => QA_ACTIONS.includes(e.action));
  if (qaEvents.length) {
    const c = (a: string) => qaEvents.filter((e) => e.action === a).length;
    const parts = [`${c('qa.pass')} passed`, c('qa.revision') ? `${c('qa.revision')} sent back` : '', c('qa.escalated') ? `${c('qa.escalated')} escalated` : ''].filter(Boolean);
    done.push(`Reviewed ${qaEvents.length} deliverable${qaEvents.length === 1 ? '' : 's'}: ${parts.join(', ')}`);
  }

  for (const t of mine(f.in_progress)) {
    if (t.status === 'working') next.push(`Continue ${q(t.title)}${forClient(t)}`);
    else if (t.status === 'qa_pending' || t.status === 'qa_reviewing') next.push(`${q(t.title)} is with QA`);
    else next.push(`Revise ${q(t.title)}${t.revision_count ? ` (revision ${t.revision_count})` : ''}`);
  }
  for (const t of mine(f.queued)) next.push(`Start ${q(t.title)}${forClient(t)}${t.status === 'pending' ? ' (after its dependencies)' : ''}`);
  if (agentId === 'qa-lead') {
    const waiting = f.in_progress.filter((t) => t.status === 'qa_pending').length;
    if (waiting) next.unshift(`Review ${waiting} deliverable${waiting === 1 ? '' : 's'} waiting for QA`);
  }

  const blockedTasks = new Set<string>();
  for (const b of mine(f.blocked)) {
    blockedTasks.add(b.task_id);
    blockers.push(b.kind === 'question' ? `Waiting for your answer: ${b.reason}` : `${q(b.title)} is stuck: ${b.reason}`);
  }
  for (const a of mine(f.approvals_waiting)) {
    if (a.type === 'task_failed' || a.type === 'question') continue; // already listed above
    if (a.kind === 'plan') blockers.push(`${q(a.title.replace(/^Plan:\s*/, ''))} plan is waiting for your approval`);
    else if (a.kind === 'deliverable') blockers.push(`${q(a.title)} passed QA and is waiting for your approval`);
    else blockers.push(`Waiting for your decision: ${a.title}`);
  }
  return { done: done.slice(0, MAX_LINES), next: next.slice(0, MAX_LINES), blockers: blockers.slice(0, MAX_LINES) };
}

/** A model rewrite is accepted only if it keeps the shape: no new items, no emptied sections. */
export function acceptRewrite(tpl: StandupLines, out: StandupLines): boolean {
  return (['done', 'next', 'blockers'] as const).every((k) =>
    out[k].length <= tpl[k].length && (tpl[k].length === 0) === (out[k].length === 0) && out[k].every((s) => typeof s === 'string' && s.trim().length > 0 && s.length <= 240));
}

export function standupMarkdown(name: string, s: StandupLines): string {
  const sec = (title: string, xs: string[], empty: string) => `**${title}**\n${xs.length ? xs.map((x) => `- ${x}`).join('\n') : `- ${empty}`}`;
  return [`### ${name}`, sec('Done', s.done, 'Nothing finished today'), sec('Next', s.next, 'Nothing queued'), sec('Blockers', s.blockers, 'None')].join('\n\n');
}

// ---------- CEO daily digest ----------
export interface DigestLine { title: string; agent_id: string | null; client: string | null; note?: string }
export interface ClientLine { name: string; done: number; in_progress: number; blocked: number; spend_usd: number }
export interface DigestData {
  headline: string;
  counts: { done: number; in_progress: number; blocked: number; approvals_waiting: number; requests_created: number };
  qa: { reviews: number; passed: number; pass_rate: number | null };
  spend_usd: number;
  done: DigestLine[];
  in_progress: DigestLine[];
  blocked: DigestLine[];
  approvals: DigestLine[];
  clients: ClientLine[];
  standups: number;
  /** HQ Brain (M14.4): memory changes today and agent proposals. Absent when the brain has no data. */
  brain?: BrainDigest;
}

export interface BrainDigest {
  saves: number;
  projects: { slug: string; name: string; changes: number }[];
  proposals_pending: number;
  proposals_applied: number;
  proposals_failed: number;
}

const KIND_LABEL: Record<string, string> = { plan: 'Plan', deliverable: 'Deliverable', external_action: 'Action' };
const STATUS_NOTE: Record<string, string> = { working: 'working', qa_pending: 'waiting for QA', qa_reviewing: 'in QA review', queued: 'revising', revision: 'revising' };

export function clientLines(f: DayFacts): ClientLine[] {
  const by = new Map<string, ClientLine>();
  const get = (name: string) => { let c = by.get(name); if (!c) { c = { name, done: 0, in_progress: 0, blocked: 0, spend_usd: 0 }; by.set(name, c); } return c; };
  for (const t of f.done) if (t.client_name) get(t.client_name).done++;
  for (const t of f.in_progress) if (t.client_name) get(t.client_name).in_progress++;
  for (const t of f.blocked) if (t.client_name) get(t.client_name).blocked++;
  for (const s of f.spend_by_client) get(s.name).spend_usd += Number(s.usd);
  return [...by.values()].sort((a, b) => b.done + b.in_progress - (a.done + a.in_progress) || a.name.localeCompare(b.name));
}

export function templateHeadline(d: Omit<DigestData, 'headline'>): string {
  const parts = [`${d.counts.done} task${d.counts.done === 1 ? '' : 's'} done`, `${d.counts.in_progress} in progress`];
  const needs = d.counts.approvals_waiting + d.counts.blocked;
  parts.push(needs ? `${needs} need${needs === 1 ? 's' : ''} you` : 'nothing waiting on you');
  return `${parts.join(', ')}; ${usd(d.spend_usd)} spent today.`;
}

export function buildDigest(f: DayFacts, standups = 0, brain: BrainDigest | null = null): DigestData {
  const base: Omit<DigestData, 'headline'> = {
    counts: {
      done: f.done.length, in_progress: f.in_progress.length, blocked: f.blocked.length,
      approvals_waiting: f.approvals_waiting.length, requests_created: f.requests_created,
    },
    qa: { ...f.qa, pass_rate: passRate(f.qa) },
    spend_usd: Math.round(Number(f.spend_usd || 0) * 10_000) / 10_000,
    done: f.done.map((t) => ({ title: t.title, agent_id: t.agent_id, client: t.client_name ?? null, note: t.revision_count ? `${t.revision_count} revision${t.revision_count === 1 ? '' : 's'}` : undefined })),
    in_progress: f.in_progress.map((t) => ({ title: t.title, agent_id: t.agent_id, client: t.client_name ?? null, note: STATUS_NOTE[t.status ?? ''] ?? t.status })),
    blocked: f.blocked.map((t) => ({ title: t.title, agent_id: t.agent_id, client: t.client_name ?? null, note: t.reason })),
    approvals: f.approvals_waiting.map((a) => ({ title: a.title, agent_id: a.agent_id, client: null, note: KIND_LABEL[a.kind] ?? a.kind })),
    clients: clientLines(f),
    standups,
    ...(brain && (brain.saves || brain.proposals_pending || brain.proposals_applied || brain.proposals_failed) ? { brain } : {}),
  };
  return { headline: templateHeadline(base), ...base };
}

function lineMd(l: DigestLine, names: Map<string, string>) {
  const who = l.agent_id ? names.get(l.agent_id) ?? l.agent_id : null;
  return `- ${l.title}${l.client ? ` · ${l.client}` : ''}${who ? ` · ${who}` : ''}${l.note ? ` (${l.note})` : ''}`;
}
function list(title: string, lines: DigestLine[], names: Map<string, string>, empty: string, max = 12) {
  const more = lines.length > max ? `\n- …and ${lines.length - max} more` : '';
  return `## ${title} (${lines.length})\n${lines.length ? lines.slice(0, max).map((l) => lineMd(l, names)).join('\n') + more : `- ${empty}`}`;
}

export function digestMarkdown(date: string, d: DigestData, names: Map<string, string>): string {
  return [
    `# CEO digest · ${date}`,
    d.headline,
    `**QA pass rate:** ${d.qa.pass_rate === null ? 'no reviews' : `${d.qa.pass_rate}% (${d.qa.passed}/${d.qa.reviews})`} · **Spend today:** ${usd(d.spend_usd)} · **New requests:** ${d.counts.requests_created}`,
    list('Done today', d.done, names, 'Nothing finished today'),
    list('In progress', d.in_progress, names, 'Nothing in progress'),
    list('Blocked / needs you', d.blocked, names, 'Nothing blocked'),
    list('Approvals waiting', d.approvals, names, 'Inbox zero'),
    ...(d.brain ? [brainMd(d.brain)] : []),
    `## Clients\n${d.clients.length ? d.clients.map((c) => `- **${c.name}**: ${c.done} done, ${c.in_progress} in progress${c.blocked ? `, ${c.blocked} blocked` : ''}, ${usd(c.spend_usd)}`).join('\n') : '- No client work today'}`,
  ].join('\n\n');
}

export function brainMd(b: BrainDigest): string {
  const lines = [`- ${b.saves} memory change${b.saves === 1 ? '' : 's'} today${b.projects.length ? `: ${b.projects.map((p) => `${p.name} (${p.changes})`).join(', ')}` : ''}`];
  if (b.proposals_applied) lines.push(`- ${b.proposals_applied} agent proposal${b.proposals_applied === 1 ? '' : 's'} saved`);
  if (b.proposals_pending) lines.push(`- ${b.proposals_pending} agent proposal${b.proposals_pending === 1 ? '' : 's'} waiting for you (Approvals)`);
  if (b.proposals_failed) lines.push(`- ${b.proposals_failed} approved proposal${b.proposals_failed === 1 ? '' : 's'} could not be saved (see /brain)`);
  return `## Brain\n${lines.join('\n')}`;
}

// ---------- morning brief ----------
export interface MorningData {
  headline: string;
  queue: DigestLine[];
  in_progress: DigestLine[];
  due_soon: { title: string; due_date: string; client: string | null; status: string }[];
  approvals: DigestLine[];
  blocked: DigestLine[];
  yesterday: { done: number; spend_usd: number };
}

export function buildMorningBrief(f: DayFacts, yesterday: { done: number; spend_usd: number }): MorningData {
  const queue = f.queued.map((t) => ({ title: t.title, agent_id: t.agent_id, client: t.client_name ?? null, note: t.priority && t.priority !== 'normal' ? t.priority : undefined }));
  const inProg = f.in_progress.map((t) => ({ title: t.title, agent_id: t.agent_id, client: t.client_name ?? null, note: STATUS_NOTE[t.status ?? ''] ?? t.status }));
  const due = f.due_soon.map((r) => ({ title: r.title, due_date: r.due_date, client: r.client_name, status: r.status }));
  const approvals = f.approvals_waiting.map((a) => ({ title: a.title, agent_id: a.agent_id, client: null, note: KIND_LABEL[a.kind] ?? a.kind }));
  const blocked = f.blocked.map((t) => ({ title: t.title, agent_id: t.agent_id, client: t.client_name ?? null, note: t.reason }));
  const headline = `Good morning. ${queue.length + inProg.length} task${queue.length + inProg.length === 1 ? '' : 's'} on the board, `
    + `${approvals.length} approval${approvals.length === 1 ? '' : 's'} waiting, ${due.length} due in the next 3 days.`;
  return { headline, queue, in_progress: inProg, due_soon: due, approvals, blocked, yesterday };
}

export function morningMarkdown(date: string, m: MorningData, names: Map<string, string>): string {
  return [
    `# Morning brief · ${date}`,
    m.headline,
    `Yesterday: ${m.yesterday.done} done, ${usd(m.yesterday.spend_usd)} spent.`,
    list('Approvals waiting', m.approvals, names, 'Inbox zero'),
    `## Due soon (${m.due_soon.length})\n${m.due_soon.length ? m.due_soon.map((r) => `- ${r.title}${r.client ? ` · ${r.client}` : ''} · due ${r.due_date}`).join('\n') : '- Nothing due in the next 3 days'}`,
    list('In progress', m.in_progress, names, 'Nothing in progress'),
    list("Today's queue", m.queue, names, 'Queue is empty'),
    list('Blocked', m.blocked, names, 'Nothing blocked'),
  ].join('\n\n');
}

// ---------- weekly (COO) ----------
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

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}

export function buildWeekly(f: DayFacts): WeeklyData {
  const dept = new Map(f.agents.map((a) => [a.id, a.department]));
  const byDept = new Map<string, number>();
  for (const t of f.done) { const d = dept.get(t.agent_id) ?? 'other'; byDept.set(d, (byDept.get(d) ?? 0) + 1); }
  const qaDays = new Map(f.qa_by_day.map((d) => [d.date, d]));
  const trend: WeeklyData['qa_trend'] = [];
  for (let d = f.from; d < f.to; d = addDays(d, 1)) {
    const x = qaDays.get(d);
    trend.push({ date: d, reviews: x?.reviews ?? 0, pass_rate: x ? passRate(x) : null });
  }
  const bottlenecks: string[] = [];
  const revised = [...f.done].filter((t) => (t.revision_count ?? 0) >= 2).sort((a, b) => (b.revision_count ?? 0) - (a.revision_count ?? 0));
  for (const t of revised.slice(0, 3)) bottlenecks.push(`${q(t.title)} needed ${t.revision_count} QA revisions`);
  const oldApprovals = f.approvals_waiting.filter((a) => Date.parse(a.created_at) < Date.parse(`${f.to}T00:00:00+08:00`) - 24 * 3600_000);
  if (oldApprovals.length) bottlenecks.push(`${oldApprovals.length} approval${oldApprovals.length === 1 ? '' : 's'} waiting on you for over a day`);
  if (f.blocked.length) bottlenecks.push(`${f.blocked.length} task${f.blocked.length === 1 ? ' is' : 's are'} blocked: ${f.blocked.slice(0, 3).map((b) => q(b.title)).join(', ')}`);
  const rate = passRate(f.qa);
  if (rate !== null && rate < 70) bottlenecks.push(`QA first-pass rate is low (${rate}%): check briefs and acceptance criteria`);
  const done = f.done.length;
  const spend = Math.round(Number(f.spend_usd || 0) * 100) / 100;
  return {
    headline: `${done} task${done === 1 ? '' : 's'} delivered, ${usd(spend)} spent, QA pass rate ${rate === null ? 'n/a' : `${rate}%`}.`,
    range: { from: f.from, to: addDays(f.to, -1) },
    done, spend_usd: spend, requests_created: f.requests_created,
    qa: { ...f.qa, pass_rate: rate }, qa_trend: trend,
    by_department: [...byDept.entries()].map(([department, n]) => ({ department, done: n })).sort((a, b) => b.done - a.done),
    cost_by_client: f.spend_by_client.map((s) => ({ name: s.name, usd: Number(s.usd) })),
    cost_by_agent: f.spend_by_actor.map((s) => ({ agent_id: s.actor, usd: Number(s.usd) })),
    bottlenecks,
  };
}

export function weeklyMarkdown(w: WeeklyData, names: Map<string, string>): string {
  return [
    `# Weekly summary · ${w.range.from} → ${w.range.to}`,
    w.headline,
    `## Tasks by department\n${w.by_department.length ? w.by_department.map((d) => `- ${d.department}: ${d.done}`).join('\n') : '- Nothing delivered'}`,
    `## QA pass rate by day\n${w.qa_trend.map((d) => `- ${d.date}: ${d.pass_rate === null ? '—' : `${d.pass_rate}%`} (${d.reviews} reviews)`).join('\n')}`,
    `## Cost by client\n${w.cost_by_client.length ? w.cost_by_client.map((c) => `- ${c.name}: ${usd(c.usd)}`).join('\n') : '- No client spend'}`,
    `## Cost by agent\n${w.cost_by_agent.length ? w.cost_by_agent.slice(0, 8).map((c) => `- ${names.get(c.agent_id) ?? c.agent_id}: ${usd(c.usd)}`).join('\n') : '- No spend'}`,
    `## Bottlenecks\n${w.bottlenecks.length ? w.bottlenecks.map((b) => `- ${b}`).join('\n') : '- None this week'}`,
  ].join('\n\n');
}
