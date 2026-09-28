// Telegram message text (HTML parse mode). Pure functions; every dynamic string goes through esc().
import type { SpendSummary } from './budget';
import type { AgentLite, BotApproval, BotReport, QuickFacts } from './types';

export const TG_LIMIT = 4096;

export function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Cuts on a line boundary so HTML tags (always opened and closed on one line here) stay balanced. */
export function truncate(text: string, max = TG_LIMIT - 96): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const nl = cut.lastIndexOf('\n');
  return `${nl > max / 2 ? cut.slice(0, nl) : cut.replace(/<[^>]*$/, '')}\n…`;
}

export const usd = (n: unknown) => `$${(Number(n) || 0).toFixed(2)}`;

export function hhmmIn(iso: string, tz = 'Asia/Manila'): string {
  return new Date(iso).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

export function prettyDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
}

type Names = Map<string, string>;
const nameOf = (names: Names, id: string | null | undefined) => (id ? names.get(id) ?? id : 'Someone');

interface PlanTask { key?: string; agent_id?: string; title?: string; depends_on?: string[] }

function planBody(ap: BotApproval, names: Names): string[] {
  const p = (ap.payload ?? {}) as { tasks?: PlanTask[]; estimated_cost_usd?: number; due_date?: string | null; questions_for_ceo?: string[] };
  const tasks = Array.isArray(p.tasks) ? p.tasks : [];
  const index = new Map(tasks.map((t, i) => [t.key ?? '', i + 1]));
  const client = ap.requests?.clients?.name;
  const due = p.due_date ?? ap.requests?.due_date;
  const meta = [`${tasks.length} task${tasks.length === 1 ? '' : 's'}`, p.estimated_cost_usd !== undefined ? `est. ${usd(p.estimated_cost_usd)}` : '', due ? `due ${prettyDate(due)}` : '']
    .filter(Boolean).join(' · ');
  const lines = [`📋 <b>PLAN</b> · ${client ? `${esc(client)} — ` : ''}${esc(ap.title.replace(/^Plan:\s*/, ''))}`, meta];
  tasks.slice(0, 12).forEach((t, i) => {
    const after = (t.depends_on ?? []).map((k) => index.get(k)).filter(Boolean);
    lines.push(`${i + 1}. ${esc(nameOf(names, t.agent_id))} — ${esc(t.title)}${after.length ? ` (after ${after.join(', ')})` : ''}`);
  });
  if (tasks.length > 12) lines.push(`…and ${tasks.length - 12} more`);
  for (const q of (p.questions_for_ceo ?? []).slice(0, 3)) lines.push(`❓ ${esc(q)}`);
  return lines;
}

function deliverableBody(ap: BotApproval, names: Names): string[] {
  const p = (ap.payload ?? {}) as { qa?: { score?: number; summary?: string }; output?: { summary?: string } };
  const score = p.qa?.score;
  const lines = [`✅ <b>QA PASSED${score !== undefined ? ` ${esc(score)}/100` : ''}</b> · ${esc(ap.title)} (${esc(nameOf(names, ap.agent_id))})`];
  const summary = p.output?.summary ?? ap.summary;
  if (summary) lines.push(esc(summary));
  if (ap.preview_url) lines.push(`Preview: ${esc(ap.preview_url)}`);
  return lines;
}

function actionBody(ap: BotApproval, names: Names): string[] {
  const p = (ap.payload ?? {}) as { type?: string; question?: string; options?: string[]; reason?: string; action_type?: string; executor?: string; spec?: { description?: string; executor?: string } };
  const who = esc(nameOf(names, ap.agent_id));
  switch (p.type) {
    case 'question':
      return [`❓ <b>QUESTION</b> · ${who}`, esc(p.question ?? ap.summary ?? ap.title), ...(p.options?.length ? [`Options: ${p.options.map(esc).join(' / ')}`] : [])];
    case 'task_failed':
      return [`⚠️ <b>TASK FAILED</b> · ${esc(ap.title.replace(/^Stuck:\s*/, ''))} (${who})`, esc(p.reason ?? ap.summary ?? ''), 'Approve = retry with your note · Reject = cancel'];
    case 'qa_escalation':
      return [`🔁 <b>QA KEEPS FAILING</b> · ${esc(ap.title.replace(/^QA keeps failing:\s*/, ''))} (${who})`, esc(ap.summary ?? '')];
    case 'qa_stuck':
      return [`🧪 <b>QA CAN'T REVIEW</b> · ${esc(ap.title.replace(/^QA can't review:\s*/, ''))} (${who})`, esc(p.reason ?? ap.summary ?? ''),
        'Approve = try QA again · Reject = cancel the task'];
    case 'planning_failed':
      return [`🧭 <b>COO COULDN'T PLAN THIS</b>`, esc(p.reason ?? ap.summary ?? '')];
    default: {
      const lines = [`🚀 <b>ACTION</b> · ${esc(p.action_type ?? 'external action')} (${who})`, esc(p.spec?.description ?? ap.summary ?? ap.title)];
      // Only rizehub.* actions are executed by the worker; everything else is a step the CEO does by hand.
      if ((p.executor ?? p.spec?.executor) !== 'worker' && !String(p.action_type ?? '').startsWith('rizehub.')) lines.push('👤 <i>Manual step: you do this after approving.</i>');
      return lines;
    }
  }
}

export function decisionLine(ap: Pick<BotApproval, 'status' | 'decided_at' | 'decided_via' | 'ceo_note'>, tz = 'Asia/Manila'): string {
  if (ap.status === 'pending') return '';
  const at = ap.decided_at ? ` ${hhmmIn(ap.decided_at, tz)}` : '';
  const via = ap.decided_via === 'dashboard' ? ' (dashboard)' : '';
  const head = ap.status === 'approved' ? '✅ Approved' : ap.status === 'rejected' ? '❌ Rejected' : '✏️ Changes requested';
  return `<b>${head} by you${at}</b>${via}${ap.ceo_note ? `\n“${esc(ap.ceo_note)}”` : ''}`;
}

/** Full approval message; after a decision the result line is appended. */
export function formatApproval(ap: BotApproval, names: Names, tz = 'Asia/Manila'): string {
  const body = ap.kind === 'plan' ? planBody(ap, names) : ap.kind === 'deliverable' ? deliverableBody(ap, names) : actionBody(ap, names);
  if (ap.requests?.priority === 'urgent' && ap.status === 'pending') body[0] = `🔴 <b>URGENT</b> · ${body[0]}`;
  const text = body.filter((l) => l !== '').join('\n');
  const d = is2fa(ap) ? twofaLine(ap, tz) : decisionLine(ap, tz);
  return truncate(d ? `${text}\n\n${d}` : text);
}

/** 2FA outcome without the code (the note holds the code or a scrub marker, never shown). */
function twofaLine(ap: BotApproval, tz: string): string {
  if (ap.status === 'pending') return '';
  if (ap.ceo_note === '[2FA request expired]') return '<b>⌛ Expired: the login stopped waiting for a code</b>';
  if (ap.status === 'approved') return decisionLine({ ...ap, ceo_note: null }, tz).replace('✅ Approved', '🔐 Code sent');
  return decisionLine({ ...ap, ceo_note: null }, tz);
}

export const isQuestion = (ap: Pick<BotApproval, 'kind' | 'payload'>) =>
  ap.kind === 'external_action' && (ap.payload as { type?: string } | null)?.type === 'question';

/** A Vault 2FA question: the answer is a one-time code (never echoed back). */
export const is2fa = (ap: Pick<BotApproval, 'kind' | 'payload'>) =>
  ap.kind === 'external_action' && (ap.payload as { vault?: { kind?: string } } | null)?.vault?.kind === '2fa';

// ---------- reports ----------
interface Line { title: string; agent_id?: string | null; client?: string | null; note?: string }
function bullets(lines: Line[] | undefined, names: Names, max = 8): string {
  const xs = lines ?? [];
  const out = xs.slice(0, max).map((l) => `• ${esc(l.title)}${l.client ? ` · ${esc(l.client)}` : ''}${l.agent_id ? ` · ${esc(nameOf(names, l.agent_id))}` : ''}${l.note ? ` <i>(${esc(l.note)})</i>` : ''}`);
  if (xs.length > max) out.push(`…and ${xs.length - max} more`);
  return out.join('\n');
}
const section = (title: string, lines: Line[] | undefined, names: Names, max?: number) =>
  lines?.length ? `${title} (${lines.length})\n${bullets(lines, names, max)}` : '';

/** Markdown fallback for reports without structured data. */
export function mdToText(md: string): string {
  return esc(md).replace(/^#+\s*(.*)$/gm, '<b>$1</b>').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/^- /gm, '• ');
}

export function formatReport(r: BotReport, names: Names, dashboardUrl: string): string {
  const d = (r.data ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const link = `${dashboardUrl.replace(/\/+$/, '')}/reports?date=${r.report_date}${r.kind === 'weekly' ? '&tab=weekly' : ''}`;
  let parts: string[];
  if (r.kind === 'daily_digest' && d.counts) {
    const qa = d.qa?.pass_rate === null || d.qa?.pass_rate === undefined ? 'no QA reviews' : `QA pass rate ${d.qa.pass_rate}% (${d.qa.passed}/${d.qa.reviews})`;
    parts = [
      `🌆 <b>CEO digest · ${prettyDate(r.report_date)}</b>`,
      esc(d.headline ?? ''),
      section('✅ Done', d.done, names),
      section('⏳ In progress', d.in_progress, names, 6),
      section('🚧 Blocked / needs you', d.blocked, names, 6),
      d.counts.approvals_waiting ? `📥 ${d.counts.approvals_waiting} approval${d.counts.approvals_waiting === 1 ? '' : 's'} waiting · /approvals` : '📥 Inbox zero',
      `🧪 ${qa} · 💸 Spend ${usd(d.spend_usd)}`,
      d.clients?.length ? `👥 <b>Clients</b>\n${(d.clients as { name: string; done: number; in_progress: number; spend_usd: number }[]).slice(0, 8)
        .map((c) => `• ${esc(c.name)}: ${c.done} done, ${c.in_progress} in progress, ${usd(c.spend_usd)}`).join('\n')}` : '',
    ];
  } else if (r.kind === 'morning_brief' && d.headline) {
    parts = [
      `☀️ <b>Morning brief · ${prettyDate(r.report_date)}</b>`,
      esc(d.headline),
      section('📥 Approvals waiting', d.approvals, names, 6),
      d.due_soon?.length ? `📅 Due soon\n${(d.due_soon as { title: string; due_date: string; client: string | null }[]).slice(0, 6)
        .map((x) => `• ${esc(x.title)}${x.client ? ` · ${esc(x.client)}` : ''} · ${prettyDate(x.due_date)}`).join('\n')}` : '',
      section('⏳ In progress', d.in_progress, names, 6),
      section("🗂 Today's queue", d.queue, names, 6),
      section('🚧 Blocked', d.blocked, names, 4),
      d.yesterday ? `Yesterday: ${d.yesterday.done} done, ${usd(d.yesterday.spend_usd)} spent.` : '',
    ];
  } else if (r.kind === 'weekly' && d.range) {
    parts = [
      `📊 <b>Weekly summary · ${prettyDate(d.range.from)} → ${prettyDate(d.range.to)}</b>`,
      esc(d.headline ?? ''),
      d.by_department?.length ? `🏢 By department\n${(d.by_department as { department: string; done: number }[]).map((x) => `• ${esc(x.department)}: ${x.done}`).join('\n')}` : '',
      d.cost_by_client?.length ? `💸 Cost by client\n${(d.cost_by_client as { name: string; usd: number }[]).slice(0, 6).map((x) => `• ${esc(x.name)}: ${usd(x.usd)}`).join('\n')}` : '',
      d.bottlenecks?.length ? `🚧 Bottlenecks\n${(d.bottlenecks as string[]).map((b) => `• ${esc(b)}`).join('\n')}` : '✨ No bottlenecks this week',
    ];
  } else {
    parts = [mdToText(r.body_md ?? `${r.kind} ${r.report_date}`)];
  }
  parts.push(`🔗 ${esc(link)}`);
  return truncate(parts.filter(Boolean).join('\n\n'));
}

/** /report when today's digest has not been written yet. */
export function formatQuickSummary(f: QuickFacts, names: Names, timeLabel: string): string {
  const rate = f.qa.reviews ? `${Math.round((f.qa.passed / f.qa.reviews) * 100)}% (${f.qa.passed}/${f.qa.reviews})` : 'no reviews yet';
  return truncate([
    `⚡ <b>Live summary · ${esc(timeLabel)}</b>`,
    `${f.done.length} done · ${f.in_progress.length} in progress · ${f.blocked.length} blocked · ${f.approvals_waiting.length} approvals waiting`,
    section('✅ Done today', f.done.map((t) => ({ title: t.title, agent_id: t.agent_id, client: t.client_name ?? null })), names),
    section('⏳ In progress', f.in_progress.map((t) => ({ title: t.title, agent_id: t.agent_id })), names, 6),
    section('🚧 Blocked', f.blocked.map((t) => ({ title: t.title, agent_id: t.agent_id, note: t.reason })), names, 5),
    `🧪 QA ${rate} · 💸 Spend today ${usd(f.spend_usd)}`,
    '<i>The full digest is written at the digest time (default 18:00).</i>',
  ].filter(Boolean).join('\n\n'));
}

export function formatBudget(s: SpendSummary, monthlyBudget: number, dailyBudget: number | null, names: Names): string {
  const pct = (a: number, b: number) => (b > 0 ? ` (${Math.round((a / b) * 100)}%)` : '');
  const lines = [
    '💸 <b>Budget</b>',
    `Today: ${usd(s.today)}${dailyBudget ? ` of ${usd(dailyBudget)} daily${pct(s.today, dailyBudget)}` : ''}`,
    `This month: ${usd(s.month)}${monthlyBudget > 0 ? ` of ${usd(monthlyBudget)}${pct(s.month, monthlyBudget)}` : ' · no paid budget set (free models only)'}`,
  ];
  if (monthlyBudget > 0 && s.month >= monthlyBudget) lines.push('🛑 Monthly budget reached: paid models are off until next month.');
  else if (monthlyBudget > 0 && s.month >= monthlyBudget * 0.8) lines.push('⚠️ Over 80% of the monthly budget.');
  if (s.topToday.length) lines.push(`Top today: ${s.topToday.map((t) => `${esc(nameOf(names, t.actor))} ${usd(t.usd)}`).join(' · ')}`);
  return lines.join('\n');
}

export function formatStatus(agents: AgentLite[], paused: boolean): string {
  const by = (s: string) => agents.filter((a) => a.status === s).map((a) => esc(a.name));
  const working = by('working'), idle = by('idle'), needs = [...by('waiting'), ...by('blocked')];
  return [
    paused ? '⏸ <b>Paused</b>: nothing new starts until /resume' : '',
    `🟢 Working (${working.length}): ${working.join(', ') || 'nobody'}`,
    `☕ On break (${idle.length}): ${idle.join(', ') || 'nobody'}`,
    `🙋 Need you (${needs.length}): ${needs.join(', ') || 'nobody'}`,
  ].filter(Boolean).join('\n');
}
