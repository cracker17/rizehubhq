// Julev Operator on Telegram (docs/17-OPERATOR.md "Telegram"): reply drafts arrive as normal approvals with
// payload.type 'operator_reply' and get ✅ Send / ✏️ Edit / ⏭ Skip; auto-sends, failures and blocks arrive as notices
// (operator_actions rows the bot marks sent); /inbox, /pause [client], /resume [client] and /status <client>.
// Phase 2 (worker mode): client updates of finished jobs ('operator_update', Send / Edit / Skip like replies), outside-
// world actions of a job ('operator_action'), job memories ('operator_memory' / 'brain_proposal'); notices for jobs,
// actions, client updates and logins; /task, /jobs, /logins.
// Pure formatting here (tested); index.ts wires the commands.
import { esc, hhmmIn, truncate } from './format';
import type { BotApproval } from './types';

export interface OperatorReplyPayload {
  type: 'operator_reply';
  client?: string; client_name?: string; channel?: string; space?: string | null; sender?: string; message?: string;
  message_url?: string | null; draft?: string; category?: string; action_types?: string[]; confidence?: number | string;
  summary?: string | null; task_plan?: string[] | null; project?: string | null;
}

const typeOf = (ap: Pick<BotApproval, 'payload'>) => String((ap.payload as { type?: string } | null)?.type ?? '');
const isTaskDraft = (ap: Pick<BotApproval, 'payload'>) => typeOf(ap) === 'operator_reply' && (ap.payload as { category?: string } | null)?.category === 'task';

/** Text the operator posts in a client chat (a reply draft or a client update): ✏️ Edit = the exact text to post. */
export const isOperatorReply = (ap: Pick<BotApproval, 'kind' | 'payload'>) =>
  ap.kind === 'external_action' && ['operator_reply', 'operator_update'].includes(typeOf(ap));

export const OPERATOR_LABELS = { approve: '✅ Send', changes: '✏️ Edit', reject: '⏭ Skip' } as const;

/** Button labels per operator approval type (null: the default Approve / Changes / Reject). */
export function operatorLabels(ap: Pick<BotApproval, 'kind' | 'payload'>): { approveLabel: string; changesLabel: string; rejectLabel: string } | null {
  if (ap.kind !== 'external_action') return null;
  switch (typeOf(ap)) {
    case 'operator_reply':
      return { approveLabel: isTaskDraft(ap) ? '✅ Send + start' : OPERATOR_LABELS.approve, changesLabel: OPERATOR_LABELS.changes, rejectLabel: OPERATOR_LABELS.reject };
    case 'operator_update':
      return { approveLabel: OPERATOR_LABELS.approve, changesLabel: OPERATOR_LABELS.changes, rejectLabel: OPERATOR_LABELS.reject };
    case 'operator_action':
      return { approveLabel: '✅ Do it', changesLabel: '✏️ Not like this', rejectLabel: '❌ Don’t' };
    case 'operator_memory': case 'brain_proposal':
      return { approveLabel: '✅ Save', changesLabel: '✏️ Not like this', rejectLabel: '❌ Drop' };
    default: return null;
  }
}

/** Toast after a tap on an operator approval (decide_approval's result: action_approved / …); null = not an operator one. */
export function operatorToast(ap: Pick<BotApproval, 'kind' | 'payload'>, result: string): string | null {
  const t = typeOf(ap);
  const by: Record<string, Record<string, string>> = {
    operator_reply: { action_approved: isTaskDraft(ap) ? 'Posting the draft + starting the task' : 'Posting the draft', action_changes_requested: 'Posting your text', action_rejected: 'Skipped' },
    operator_update: { action_approved: 'Sending the update', action_changes_requested: 'Sending your text', action_rejected: 'Skipped' },
    operator_action: { action_approved: 'Approved: the operator does it now', action_changes_requested: 'Not done: the job reads your note', action_rejected: 'Not done' },
    operator_memory: { action_approved: 'Saved to memory', action_changes_requested: 'Dropped (your note is kept)', action_rejected: 'Dropped' },
  };
  return (by[t === 'brain_proposal' ? 'operator_memory' : t] ?? {})[result] ?? null;
}

const clip = (s: unknown, max: number) => { const t = String(s ?? '').trim(); return t.length > max ? `${t.slice(0, max)}…` : t; };

/** The approval message for a reply draft: who said what, where, the draft, and why it needs you. */
export function operatorReplyBody(ap: BotApproval): string[] {
  const p = (ap.payload ?? {}) as unknown as OperatorReplyPayload;
  const conf = Number(p.confidence);
  const types = (p.action_types ?? []).filter(Boolean);
  const lines = [
    `💬 <b>REPLY</b> · ${esc(p.client_name ?? p.client ?? 'client')} · ${esc(p.channel ?? p.space ?? 'chat')}`,
    `<b>${esc(p.sender || 'Someone')}:</b> ${esc(clip(p.message, 700))}`,
    '',
    `<b>Draft</b>${p.category === 'task' ? ' (new task)' : ''}:`,
    `<blockquote>${esc(clip(p.draft ?? ap.summary, 1500))}</blockquote>`,
  ];
  const why = [types.length ? types.join(', ') : '', Number.isFinite(conf) ? `confidence ${Math.round(conf * 100)}%` : ''].filter(Boolean).join(' · ');
  if (why) lines.push(`<i>${esc(why)}</i>`);
  const plan = (p.task_plan ?? []).filter(Boolean).slice(0, 6);
  if (plan.length) lines.push(`Plan: ${plan.map((s, i) => `${i + 1}. ${esc(clip(s, 120))}`).join(' ')}`);
  if (p.message_url) lines.push(`<a href="${esc(p.message_url)}">Open the chat</a>`);
  if (ap.status === 'pending') lines.push('✏️ Edit = reply with the exact text to post instead.');
  return lines;
}

/** Result line after a decision on a reply draft or a client update. */
export function operatorDecisionLine(ap: Pick<BotApproval, 'status' | 'decided_at' | 'decided_via' | 'ceo_note'> & Partial<Pick<BotApproval, 'payload'>>, tz: string): string {
  if (ap.status === 'pending') return '';
  const at = ap.decided_at ? ` ${hhmmIn(ap.decided_at, tz)}` : '';
  const via = ap.decided_via === 'dashboard' ? ' (dashboard)' : '';
  const update = typeOf({ payload: ap.payload ?? null }) === 'operator_update';
  const task = isTaskDraft({ payload: ap.payload ?? null }) ? ' + starting the task' : '';
  if (ap.status === 'approved') return `<b>✅ Approved${at}: ${update ? 'sending the update' : `posting the draft${task}`}</b>${via}`;
  if (ap.status === 'changes_requested') return `<b>✏️ Edited${at}: ${update ? 'sending' : 'posting'} your text${task}</b>${via}${ap.ceo_note ? `\n“${esc(clip(ap.ceo_note, 600))}”` : ''}`;
  return `<b>⏭ Skipped${at}</b>${via}`;
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []);
const linkList = (links: string[], max = 4) => links.slice(0, max)
  .map((u) => (/^https:\/\//.test(u) ? `<a href="${esc(u)}">${esc(clip(u.replace(/^https:\/\//, ''), 60))}</a>` : esc(clip(u, 60)))).join(' · ');

/** A finished job's update for the client's chat. */
export function operatorUpdateBody(ap: BotApproval): string[] {
  const p = (ap.payload ?? {}) as { client?: string; client_name?: string; channel?: string; job_title?: string; sender?: string | null; message?: string | null;
    message_url?: string | null; draft?: string; links?: unknown };
  const lines = [
    `📣 <b>CLIENT UPDATE</b> · ${esc(p.client_name ?? p.client ?? 'client')} · ${esc(p.channel ?? 'chat')}`,
    `Job done: ${esc(clip(p.job_title, 160))}`,
  ];
  if (p.message) lines.push(`<b>${esc(p.sender || 'They')} asked:</b> ${esc(clip(p.message, 400))}`);
  lines.push('', '<b>Update</b>:', `<blockquote>${esc(clip(p.draft ?? ap.summary, 1500))}</blockquote>`);
  const links = strs(p.links);
  if (links.length) lines.push(`Links: ${linkList(links)}`);
  if (p.message_url) lines.push(`<a href="${esc(p.message_url)}">Open the chat</a>`);
  if (ap.status === 'pending') lines.push('✏️ Edit = reply with the exact text to post instead.');
  return lines;
}

const ACTION_KIND: Record<string, string> = { webflow_cms: 'Webflow CMS change', webflow_publish: 'Publish (Webflow)', airtable_write: 'Airtable change',
  browser_click: 'Click in the browser', delete: 'Delete' };

/** An outside-world change a job wants to make: nothing happens before ✅. */
export function operatorActionBody(ap: BotApproval): string[] {
  const p = (ap.payload ?? {}) as { client?: string; client_name?: string; job_title?: string; action_kind?: string; spec?: Record<string, unknown> };
  const kind = String(p.action_kind ?? '');
  const lines = [
    `🚀 <b>${esc(ACTION_KIND[kind] ?? 'Action')}</b> · ${esc(p.client_name ?? p.client ?? 'client')}${kind === 'delete' || kind === 'webflow_publish' ? ' ⚠️' : ''}`,
    `Job: ${esc(clip(p.job_title, 160))}`,
    esc(clip(ap.summary ?? ap.title, 800)),
  ];
  const spec = p.spec ?? {};
  if (kind === 'browser_click') {
    const s = spec as { url?: string; text?: string; selector?: string; type_text?: string; press?: string };
    lines.push(`On ${esc(clip(s.url, 120))}: ${s.type_text ? `type “${esc(clip(s.type_text, 200))}” into` : 'click'} “${esc(clip(s.text ?? s.selector, 120))}”${s.press ? ` + ${esc(s.press)}` : ''}`);
  } else if (Object.keys(spec).length) {
    lines.push(`<pre>${esc(clip(JSON.stringify(spec, null, 1), 700))}</pre>`);
  }
  if (ap.status === 'pending') lines.push('<i>Runs exactly as shown, only after ✅. ✏️ = not done, the job reads your note.</i>');
  return lines;
}

const APP_NAME: Record<string, string> = { gmail: 'Gmail', slack: 'Slack', teams: 'Teams', google_chat: 'Google Chat', whatsapp: 'WhatsApp' };

const MEMORY_KIND: Record<string, string> = { session_note: 'session note', decision: 'decision', next_step: 'next step' };

/** A job's memory for the client's project (an HQ Brain proposal, or kept by the operator until the Brain has it). */
export function operatorMemoryBody(ap: BotApproval): string[] {
  const p = (ap.payload ?? {}) as { kind?: string; project?: string; project_name?: string | null; client_name?: string; text?: string };
  return [
    `🧠 <b>MEMORY</b> · ${esc(MEMORY_KIND[String(p.kind)] ?? p.kind ?? 'note')} · ${esc(p.project_name ?? p.client_name ?? p.project ?? 'project')}`,
    `<blockquote>${esc(clip(p.text ?? ap.summary, 1500))}</blockquote>`,
    ...(ap.status === 'pending' ? ['<i>✅ saves it to the project memory (the operator and the team recall it next time).</i>'] : []),
  ];
}

// ---------- notices (operator_actions) ----------

export interface OperatorNotice {
  id: number;
  created_at: string;
  client_slug: string | null;
  inbox_id: string | null;
  job_id?: string | null;
  /** Filled in by the db layer from operator_jobs (operator_actions.job_id has no FK to embed). */
  job_title?: string | null;
  action: string;
  ok: boolean;
  detail: Record<string, unknown> | null;
  /** Embedded inbox row (PostgREST operator_inbox(...)). */
  operator_inbox?: { sender_name: string | null; final_text: string | null; mode: string | null; error: string | null; url: string | null } | null;
}

/** Notice kinds sent to Telegram (mirrors the operator_actions_notify index of 20261016000000_operator_worker.sql). */
export const NOTICE_ACTIONS = ['send.done', 'send.failed', 'send.blocked', 'message.classify_failed', 'watch.failed',
  'update.done', 'update.failed', 'update.blocked', 'job.started', 'job.done', 'job.escalated', 'job.failed',
  'action.done', 'action.failed', 'login.lost', 'login.restored', 'reply.manual', 'update.manual', 'posting.tested'] as const;

/** Every posted reply is announced (you always know the client got an answer); classify failures only after 3 tries. */
export function shouldNotify(n: Pick<OperatorNotice, 'action' | 'operator_inbox' | 'detail'>): boolean {
  if (n.action === 'message.classify_failed') return Number((n.detail as { attempts?: number } | null)?.attempts ?? 0) >= 3;
  return (NOTICE_ACTIONS as readonly string[]).includes(n.action);
}

/** QA screenshot ids of a job.done notice (sent as a photo album after the text). */
export function noticeEvidence(n: Pick<OperatorNotice, 'action' | 'detail'>, max = 4): number[] {
  if (n.action !== 'job.done') return [];
  const ids = (n.detail as { qa?: { evidence?: unknown } } | null)?.qa?.evidence;
  return (Array.isArray(ids) ? ids : []).map(Number).filter((x) => Number.isInteger(x) && x > 0).slice(0, max);
}

const usd = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? ` · $${n.toFixed(2)}` : ''; };

export function formatOperatorNotice(n: OperatorNotice, dashboardUrl?: string): string {
  const d = (n.detail ?? {}) as { error?: string; reason?: string; channel?: string; action_types?: string[]; mode?: string; text?: string; url?: string;
    title?: string; summary?: string; links?: unknown; qa?: { pass?: boolean; errors?: unknown }; cost_usd?: unknown; may_have_posted?: boolean;
    kind?: string; label?: string; site?: string; detail?: string; sender?: string };
  const who = n.operator_inbox?.sender_name ? ` to ${esc(n.operator_inbox.sender_name)}` : '';
  const client = esc(n.client_slug ?? 'operator');
  const job = esc(clip(n.job_title ?? d.title ?? 'a job', 160));
  const page = dashboardUrl && /^https:\/\//.test(dashboardUrl) ? `\n<a href="${esc(dashboardUrl.replace(/\/+$/, ''))}/operator">Open /operator</a>` : '';
  const chatLink = (u: string | null | undefined) => (u && /^https:\/\//.test(u) ? `\n<a href="${esc(u)}">Open the chat</a>` : '');
  switch (n.action) {
    case 'send.done': {
      const auto = (n.operator_inbox?.mode ?? d.mode) === 'auto';
      return truncate(`${auto ? '⚡ <b>Auto-replied</b>' : '✅ <b>Reply posted</b>'}${who} · ${client}\n<blockquote>${esc(clip(n.operator_inbox?.final_text, 800))}</blockquote>${chatLink(n.operator_inbox?.url)}${auto ? '\n/pause stops all sends.' : ''}`);
    }
    case 'update.done':
      return truncate(`📣 <b>Client informed</b> · ${client}${d.channel ? ` · ${esc(d.channel)}` : ''}\nJob: ${job}\n<blockquote>${esc(clip(d.text, 800))}</blockquote>${chatLink(d.url)}`);
    case 'update.failed':
      return truncate(`⚠️ <b>Client update not posted</b> · ${client}\nJob: ${job}\n${esc(clip(d.error, 400))}${d.may_have_posted ? '\nIt may have posted: check the chat before sending it again.' : ''}`);
    case 'update.blocked':
      return truncate(`🛑 <b>Client update blocked</b> by a "never" rule · ${client}\nJob: ${job}\nNothing was sent. Tell them yourself if needed.`);
    case 'job.started':
      return truncate(`🛠 <b>Started</b> · ${client}\n${job}`);
    case 'job.done': {
      const links = strs(d.links);
      const errs = strs(d.qa?.errors);
      const qa = d.qa?.pass === false ? `QA ❌ ${errs.length} issue(s)` : 'QA ✅ 375 / 1366 px · console · requests · links';
      return truncate([`✅ <b>Done</b> · ${client}${usd(d.cost_usd)}`, job, d.summary ? esc(clip(d.summary, 1200)) : '',
        links.length ? `Links: ${linkList(links)}` : '', qa].filter(Boolean).join('\n') + page);
    }
    case 'job.escalated':
      return truncate(`🙋 <b>Needs you</b> · ${client}\n${job}\n${esc(clip(d.reason ?? d.error ?? d.summary, 600))}${page}`);
    case 'job.failed':
      return truncate(`❌ <b>Job failed</b> · ${client}\n${job}\n${esc(clip(d.error, 500))}${page}`);
    case 'action.done':
      return truncate(`☑️ <b>Done: ${esc(ACTION_KIND[String(d.kind)] ?? 'action')}</b> · ${client}\n${esc(clip(d.summary, 400))}`);
    case 'action.failed':
      return truncate(`⚠️ <b>Action failed: ${esc(ACTION_KIND[String(d.kind)] ?? 'action')}</b> · ${client}\n${esc(clip(d.summary, 300))}\n${esc(clip(d.error, 400))}\nNot retried (it may have half-happened): check before asking again.`);
    case 'login.lost':
      return truncate(`🔑 <b>Signed out of ${esc(d.label ?? d.site ?? 'a site')}</b> · ${client}\n${esc(clip(d.detail, 200))}\nLog in once through the workspace viewer; jobs that need it wait meanwhile.`);
    case 'reply.manual': case 'update.manual': {
      const app = APP_NAME[String(d.kind)] ?? 'the chat';
      const what = n.action === 'update.manual' ? `client update for “${job}”` : `reply${d.sender ? ` to ${esc(d.sender)}` : ''}`;
      return truncate(`📋 <b>Post this yourself</b> in ${esc(app)} · ${client}${d.channel ? ` · ${esc(d.channel)}` : ''}
Your approved ${what} (the operator only reads ${esc(app)}):
<pre>${esc(clip(d.text, 3000))}</pre>${chatLink(d.url)}`);
    }
    case 'posting.tested': {
      const app = APP_NAME[String(d.kind)] ?? String(d.kind ?? 'the app');
      return truncate(n.ok
        ? `🧪 <b>${esc(app)} send test passed</b> · ${client}
${esc(clip(d.detail, 200))}
Switch posting on for ${esc(app)} on /operator (Unread sweep → Posting) when you're ready.`
        : `🧪 <b>${esc(app)} send test failed</b> · ${client}
${esc(clip(d.detail, 300))}
Replies there stay "you post it".`);
    }
    case 'login.restored':
      return truncate(`🔓 <b>Logged in again: ${esc(d.label ?? d.site ?? 'site')}</b> · ${client}`);
    case 'send.failed':
      return truncate(`⚠️ <b>Reply not posted</b>${who} · ${client}\n${esc(clip(d.error ?? n.operator_inbox?.error, 400))}`);
    case 'send.blocked':
      return truncate(`🛑 <b>Blocked by a "never" rule</b>${who} · ${client}\n${esc((d.action_types ?? []).join(', ') || d.reason || '')}\nNothing was sent. Answer it yourself if needed.`);
    case 'watch.failed':
      return truncate(`👀 <b>Can't read ${esc(d.channel ?? 'a chat')}</b> · ${client}\n${esc(clip(d.error, 300))}\nLog in again through the workspace viewer if it says signed out.`);
    default:
      return truncate(`⚠️ <b>Operator couldn't handle a message</b> · ${client}\n${esc(clip(d.error, 300))}`);
  }
}

// ---------- /status <client>, /inbox ----------

export interface OperatorStatus {
  client: { slug: string; name: string; paused: boolean; enabled: boolean };
  blocker: string | null;
  auto_send: boolean;
  counts: Record<string, number>;
  channels: { name: string; enabled: boolean; last_polled_at: string | null; last_error: string | null }[];
  last_action: { action: string; at: string; ok: boolean } | null;
  /** Phase 2 (operator_client_status after 20261016000000_operator_worker.sql): open + recent jobs, login checks. */
  jobs?: { id: string; title: string; status: string; updated_at: string }[];
  logins?: { site: string; label: string; state: string; last_checked_at: string | null }[];
}

export function formatOperatorStatus(s: OperatorStatus, heartbeatAt: string | null, now: Date, tz: string): string {
  const online = heartbeatAt && now.getTime() - new Date(heartbeatAt).getTime() < 3 * 60_000;
  const c = s.counts ?? {};
  const n = (k: string) => Number(c[k] ?? 0);
  const lines = [
    `🤖 <b>Operator · ${esc(s.client.name)}</b> ${online ? '🟢 online' : '⚪ offline'}`,
    s.blocker ? `⏸ Sends stopped: ${esc(s.blocker)}` : `▶️ Sending${s.auto_send ? ' (auto-send on for acks / status / thanks)' : ' (every reply waits for you)'}`,
    `7 days: ${n('sent')} sent · ${n('drafted')} waiting for you · ${n('fyi')} FYI · ${n('skipped')} skipped${n('failed') + n('blocked') ? ` · ${n('failed') + n('blocked')} failed/blocked` : ''}`,
  ];
  for (const ch of s.channels ?? []) {
    const when = ch.last_polled_at ? `read ${hhmmIn(ch.last_polled_at, tz)}` : 'never read';
    lines.push(`• ${esc(ch.name)}: ${ch.enabled ? when : 'off'}${ch.last_error ? ` ⚠️ ${esc(clip(ch.last_error, 120))}` : ''}`);
  }
  if (!s.channels?.length) lines.push('• no chats watched yet (add one on /operator)');
  for (const j of (s.jobs ?? []).slice(0, 5)) lines.push(`${JOB_ICON[j.status] ?? '•'} ${esc(clip(j.title, 80))} · ${esc(j.status)} · ${hhmmIn(j.updated_at, tz)}`);
  if (s.logins?.length) lines.push(`Logins: ${s.logins.map((l) => `${LOGIN_ICON[l.state] ?? '•'} ${esc(l.label)}`).join(' · ')}`);
  return lines.join('\n');
}

// ---------- morning / evening digests (reports kind operator_morning / operator_evening) ----------

export interface OperatorDigestClient {
  slug: string; name: string; paused: boolean; messages: number; replies_sent: number; auto_sent: number; updates_sent: number; waiting: number;
  jobs_done: { title: string; links: string[]; cost_usd: number | string }[]; jobs_open: { title: string; status: string }[];
  jobs_stuck: { title: string; status: string; why: string }[]; logins_bad: string[]; failures: number;
}
export interface OperatorDigestData {
  kind: 'operator_morning' | 'operator_evening'; kill_switch: boolean; office_paused: boolean; auto_send: boolean; online: boolean;
  spend_usd: number | string; clients: OperatorDigestClient[];
}

export function formatOperatorDigest(d: OperatorDigestData, dashboardUrl: string): string {
  const morning = d.kind === 'operator_morning';
  const head = morning ? '☀️ <b>Operator · morning</b>' : '🌙 <b>Operator · evening</b>';
  const state = d.kill_switch ? '🛑 Sends stopped (kill switch)' : d.office_paused ? '⏸ Office paused: no sends'
    : !d.online ? '⚪ The operator is offline' : d.auto_send ? '▶️ Live · auto-send on' : '▶️ Live · every reply asks';
  const lines = [`${head} · ${state}${usd(d.spend_usd)}`];
  const totalWaiting = d.clients.reduce((n, c) => n + Number(c.waiting || 0), 0);
  if (totalWaiting) lines.push(`📥 <b>${totalWaiting} waiting for you</b> · /inbox · /approvals`);
  for (const c of d.clients) {
    const quiet = !c.messages && !c.replies_sent && !c.updates_sent && !c.jobs_done.length && !c.jobs_open.length && !c.jobs_stuck.length && !c.logins_bad.length && !c.failures && !c.waiting;
    if (quiet) { lines.push(`\n<b>${esc(c.name)}</b>: quiet${morning ? ' overnight' : ' today'}.`); continue; }
    const counts = [
      `${c.messages} message${c.messages === 1 ? '' : 's'}`,
      `${c.replies_sent} repl${c.replies_sent === 1 ? 'y' : 'ies'} sent${c.auto_sent ? ` (${c.auto_sent} auto)` : ''}`,
      c.updates_sent ? `${c.updates_sent} client update${c.updates_sent === 1 ? '' : 's'}` : '',
      c.waiting ? `${c.waiting} waiting for you` : '',
    ].filter(Boolean).join(' · ');
    lines.push(`\n<b>${esc(c.name)}</b>${c.paused ? ' (paused)' : ''}: ${counts}`);
    for (const j of c.jobs_done.slice(0, 5)) {
      const link = (j.links ?? []).find((l) => /^https:\/\//.test(l));
      lines.push(`✅ ${esc(clip(j.title, 90))}${link ? ` · <a href="${esc(link)}">link</a>` : ''}`);
    }
    for (const j of c.jobs_stuck.slice(0, 3)) lines.push(`🙋 ${esc(clip(j.title, 80))}${j.why ? `: ${esc(clip(j.why, 120))}` : ''}`);
    for (const j of c.jobs_open.slice(0, 4)) lines.push(`${JOB_ICON[j.status] ?? '•'} ${esc(clip(j.title, 90))} · ${esc(j.status)}`);
    if (c.logins_bad.length) lines.push(`🔑 Signed out: ${c.logins_bad.map(esc).join(', ')}`);
    if (c.failures) lines.push(`⚠️ ${c.failures} thing${c.failures === 1 ? '' : 's'} failed: /status ${esc(c.slug)}`);
  }
  if (!d.clients.length) lines.push('No operator clients are enabled.');
  if (/^https:\/\//.test(dashboardUrl)) lines.push(`\n<a href="${esc(dashboardUrl.replace(/\/+$/, ''))}/operator">Open /operator</a>`);
  return truncate(lines.join('\n'));
}

// ---------- /task, /jobs, /logins ----------

/** "/task lvlup Add Sam to the team page" → { client, brief }; null when either part is missing. */
export function parseTaskArgs(match: string | undefined | null): { client: string; brief: string } | null {
  const m = /^\s*@?([A-Za-z0-9][A-Za-z0-9-]{0,63})\s+([\s\S]+)$/.exec(match ?? '');
  const brief = m?.[2]?.trim() ?? '';
  return m && brief.length >= 3 ? { client: m[1]!.toLowerCase(), brief: brief.slice(0, 8000) } : null;
}

export interface OperatorJobLite { id: string; client_slug: string; title: string; status: string; cost_usd: number | string; updated_at: string; error: string | null }

const JOB_ICON: Record<string, string> = { queued: '⏳', running: '🛠', waiting: '✋', verifying: '🧪', done: '✅', escalated: '🙋', failed: '❌', cancelled: '🚫' };

export function formatJobs(jobs: OperatorJobLite[], client: string | null, tz: string): string {
  if (!jobs.length) return `🛠 No operator jobs${client ? ` for ${esc(client)}` : ''} yet. /task &lt;client&gt; &lt;what to do&gt; adds one.`;
  const lines = [`🛠 <b>Operator jobs${client ? ` · ${esc(client)}` : ''}</b>`];
  for (const j of jobs) {
    const extra = j.status === 'waiting' ? ' (approve its actions)' : (j.status === 'escalated' || j.status === 'failed') && j.error ? `: ${esc(clip(j.error, 100))}` : '';
    lines.push(`${JOB_ICON[j.status] ?? '•'} ${esc(clip(j.title, 90))}${client ? '' : ` · ${esc(j.client_slug)}`} · ${esc(j.status)}${extra} · ${hhmmIn(j.updated_at, tz)}${usd(j.cost_usd)}`);
  }
  return lines.join('\n');
}

export interface OperatorLoginLite { client_slug: string; site: string; label: string; state: string; last_checked_at: string | null; detail: string | null }

const LOGIN_ICON: Record<string, string> = { ok: '🟢', signed_out: '🔴', error: '🟠', unknown: '⚪' };

export function formatLogins(rows: OperatorLoginLite[], tz: string): string {
  if (!rows.length) return '🔑 No logins to check yet (none set up for these clients).';
  const lines = ['🔑 <b>Workspace logins</b>'];
  for (const l of rows) {
    const when = l.last_checked_at ? `checked ${hhmmIn(l.last_checked_at, tz)}` : 'not checked yet';
    const state = l.state === 'signed_out' ? 'signed out' : l.state === 'ok' ? 'logged in' : l.state;
    lines.push(`${LOGIN_ICON[l.state] ?? '•'} ${esc(l.client_slug)} · ${esc(l.label)}: ${state} · ${when}${l.state !== 'ok' && l.detail ? `\n   ${esc(clip(l.detail, 140))}` : ''}`);
  }
  if (rows.some((l) => l.state === 'signed_out')) lines.push('Log in once through the workspace viewer; the next check (or an operator restart) confirms it.');
  return lines.join('\n');
}

/** Splits "/pause lvlup" style arguments: a client slug or nothing. */
export function clientArg(match: string | undefined | null): string | null {
  const a = (match ?? '').trim().toLowerCase().replace(/^@/, '');
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(a) ? a : null;
}
