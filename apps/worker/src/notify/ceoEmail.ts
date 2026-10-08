// "Email me updates" (docs/08 "Email", docs/15 §5c): every ~30 s the worker emails the CEO a copy of new results
// (QA-passed deliverables), questions, plans and failures, FROM the Gmail account chosen in Admin → Connectors (its
// sealed App Password, opened only here) TO the one address stored in settings.ceo_email. The recipient never comes
// from an agent, an approval or a task: only from that settings row, which only the CEO changes (2FA). Approving still
// happens in HQ or Telegram; the email carries no buttons that act. Action approvals (send / publish / app calls) and
// Vault 2FA questions are never emailed.
//
// Once per approval (ceo_email_log key `approval:<id>`); a failed send is retried at most 3 times (ceo_email_pending).
// Nothing created before the emails were turned on (settings.ceo_email.enabled_at) is ever sent.
import nodemailer from 'nodemailer';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CEO_EMAIL_EVENTS, CEO_EMAIL_SETTING_KEY, ceoEmailReady, isEmailAddress, parseCeoEmailSettings,
  type CeoEmailEvent, type CeoEmailSettings,
} from '@rizehubhq/shared';
import { open, type Keyring } from '../vault/crypto';
import { connectorContext, type ConnectorStore } from '../connectors/store';
import { GMAIL_SMTP, friendlyGmailError } from '../connectors/gmail';
import { esc, markdownToHtml, safeUrl, S } from './markdown';

export const CEO_EMAIL_EVERY_MS = 30_000;
export const MAX_PER_TICK = 10;
export const MAX_ATTEMPTS = 3;
/** A QA-passed deliverable waits up to this long for its storage links (the upload runs right after QA). */
export const STORAGE_SETTLE_MS = 2 * 60_000;
/** Deliverable content in the email is cut at this many characters (the full version is in HQ / storage). */
export const MAX_CONTENT_CHARS = 50_000;
export const FAILURE_TYPES = ['task_failed', 'planning_failed', 'qa_escalation', 'qa_stuck'] as const;

/** One row of ceo_email_pending(). */
export interface CeoEmailItem {
  id: string;
  event: string | null;
  kind: 'plan' | 'deliverable' | 'external_action' | string;
  title: string;
  summary: string | null;
  payload: Record<string, unknown> | null;
  preview_url: string | null;
  agent_id: string | null;
  status: string;
  decided_via: string | null;
  created_at: string;
  request_title: string | null;
  request_text: string | null;
  request_priority: string | null;
  client_name: string | null;
  task_storage: unknown;
  attempts: number;
}

export interface CeoMail { to: string; subject: string; text: string; html: string }
export type CeoSmtpSend = (account: string, appPassword: string, mail: CeoMail) => Promise<{ messageId: string }>;

export interface CeoEmailDeps {
  /** settings.ceo_email (raw) and the office time zone. */
  settings(): Promise<{ value: unknown; timezone?: string | null }>;
  pending(sinceIso: string, events: CeoEmailEvent[], limit: number): Promise<CeoEmailItem[]>;
  record(key: string, ok: boolean, error: string | null): Promise<void>;
  agentNames(): Promise<Map<string, string>>;
  store: Pick<ConnectorStore, 'get' | 'mark'>;
  keyring: Keyring | null;
  dashboardUrl: string;
  send?: CeoSmtpSend;
  now?: () => Date;
  settleMs?: number;
  log?: (msg: string) => void;
}

export interface CeoEmailTickResult { sent: number; failed: number; waiting: number; skipped?: 'off' | 'account' | 'no_keyring' | 'decrypt' }

export const smtpSendCeo: CeoSmtpSend = async (account, pass, m) => {
  const t = nodemailer.createTransport({ ...GMAIL_SMTP, auth: { user: account, pass } });
  // Exactly one recipient: no cc, no bcc, no reply-to taken from content.
  const info = await t.sendMail({ from: { name: 'RizeHub HQ', address: account }, to: m.to, subject: m.subject, text: m.text, html: m.html });
  return { messageId: String(info.messageId ?? '') };
};

// ---------- selection (pure) ----------
type Payload = Record<string, unknown>;
const obj = (v: unknown): Payload => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Payload) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Which switch an approval belongs to; null = never emailed (actions, Vault 2FA questions, unknown kinds). */
export function classifyApproval(ap: Pick<CeoEmailItem, 'kind' | 'payload'>): CeoEmailEvent | null {
  const p = obj(ap.payload);
  if (ap.kind === 'deliverable') return 'results';
  if (ap.kind === 'plan') return 'plans';
  if (ap.kind !== 'external_action') return null;
  if (obj(p.vault).kind === '2fa') return null;
  if (p.type === 'question') return 'questions';
  if ((FAILURE_TYPES as readonly string[]).includes(str(p.type))) return 'failures';
  return null;
}

export function storageOf(item: Pick<CeoEmailItem, 'payload' | 'task_storage'>): { folder_url: string | null; files: { name: string; url: string }[] } | null {
  const s = obj(obj(obj(item.payload).output).storage);
  const src = Object.keys(s).length ? s : obj(item.task_storage);
  const files = (Array.isArray(src.files) ? src.files : []).map(obj)
    .filter((f) => typeof f.url === 'string').map((f) => ({ name: str(f.name) || 'File', url: str(f.url) }));
  const folder = typeof src.folder_url === 'string' ? src.folder_url : null;
  return files.length || folder ? { folder_url: folder, files } : null;
}

/** The items to send now, oldest first, at most MAX_PER_TICK. */
export function selectDue(items: CeoEmailItem[], s: CeoEmailSettings, now: Date, settleMs = STORAGE_SETTLE_MS): { due: CeoEmailItem[]; waiting: number } {
  if (!ceoEmailReady(s)) return { due: [], waiting: 0 };
  const since = Date.parse(s.enabled_at!);
  let waiting = 0;
  const due = items.filter((it) => {
    const ev = classifyApproval(it);
    if (!ev || !s.events[ev]) return false;
    const at = Date.parse(it.created_at);
    if (!Number.isFinite(at) || at < since) return false;
    if (Number(it.attempts ?? 0) >= MAX_ATTEMPTS) return false;
    if (ev === 'results' && !storageOf(it) && now.getTime() - at < settleMs) { waiting++; return false; }
    return true;
  }).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  return { due: due.slice(0, MAX_PER_TICK), waiting };
}

// ---------- content (pure) ----------
export interface BuildContext { agentName: (id: string | null) => string; dashboardUrl: string; timezone?: string }

/** One line, no control characters, at most n characters (subjects and headers). */
export function oneLine(s: unknown, n = 140): string {
  // eslint-disable-next-line no-control-regex
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

export function capContent(md: string, max = MAX_CONTENT_CHARS): { text: string; cut: boolean } {
  if (md.length <= max) return { text: md, cut: false };
  const part = md.slice(0, max);
  const nl = part.lastIndexOf('\n');
  return { text: nl > max * 0.8 ? part.slice(0, nl) : part, cut: true };
}

const strip = (title: string, ...prefixes: RegExp[]) => prefixes.reduce((t, p) => t.replace(p, ''), title).trim() || title;

export function approvalLink(dashboardUrl: string, id: string): string {
  return `${dashboardUrl.replace(/\/+$/, '')}/approvals?id=${encodeURIComponent(id)}`;
}

export function subjectFor(it: CeoEmailItem, ctx: BuildContext): string {
  const p = obj(it.payload);
  const ev = classifyApproval(it);
  const urgent = it.request_priority === 'urgent' && it.status === 'pending' ? '🔴 URGENT · ' : '';
  let s: string;
  if (ev === 'results') s = `✅ Result ready: ${it.title}`;
  else if (ev === 'plans') s = `📋 Plan to approve: ${strip(it.title, /^Plan:\s*/i)}`;
  else if (ev === 'questions') s = `❓ ${ctx.agentName(it.agent_id)} asks: ${str(p.question) || it.summary || strip(it.title, /^Question:\s*/i)}`;
  else if (p.type === 'task_failed') s = `⚠️ Task failed: ${strip(it.title, /^Stuck:\s*/i)}`;
  else if (p.type === 'qa_escalation') s = `⚠️ QA keeps failing: ${strip(it.title, /^QA keeps failing:\s*/i)}`;
  else if (p.type === 'qa_stuck') s = `⚠️ QA can't review: ${strip(it.title, /^QA can't review:\s*/i)}`;
  else s = `⚠️ Request failed: ${it.request_title || oneLine(it.request_text, 80) || strip(it.title, /^COO couldn't plan this:\s*/i)}`;
  return oneLine(`${urgent}${s}`, 150);
}

function statusLine(it: CeoEmailItem): string {
  const ev = classifyApproval(it);
  if (it.status === 'pending') {
    if (ev === 'questions') return 'Waiting for your answer in HQ or Telegram';
    if (ev === 'failures') return 'Waiting for your decision in HQ or Telegram';
    return 'Waiting for your approval in HQ or Telegram';
  }
  if (it.decided_via === 'auto') return 'Auto-approved';
  return it.status === 'approved' ? 'Approved' : it.status === 'rejected' ? 'Rejected' : it.status === 'changes_requested' ? 'Changes requested' : it.status;
}

interface Section { title?: string; md?: string; html?: string; text?: string }

function sectionsFor(it: CeoEmailItem, ctx: BuildContext): { heading: string; meta: [string, string][]; sections: Section[] } {
  const p = obj(it.payload);
  const ev = classifyApproval(it);
  const meta: [string, string][] = [];
  const agent = it.agent_id ? ctx.agentName(it.agent_id) : '';
  if (agent) meta.push(['Agent', agent]);
  if (it.client_name) meta.push(['Client', it.client_name]);
  const sections: Section[] = [];

  if (ev === 'results') {
    const out = obj(p.output);
    const qa = obj(p.qa);
    if (typeof qa.score === 'number' || typeof qa.score === 'string') meta.push(['QA score', `${qa.score}/100`]);
    meta.push(['Status', statusLine(it)]);
    const summary = str(out.summary) || str(it.summary);
    if (summary) sections.push({ title: 'Summary', md: summary });
    if (str(qa.summary)) sections.push({ title: 'QA notes', md: str(qa.summary) });
    const content = str(out.content).trim();
    if (content) {
      const c = capContent(content);
      sections.push({ title: 'Content', md: c.text });
      if (c.cut) sections.push({ text: `The content was cut at ${MAX_CONTENT_CHARS.toLocaleString('en-US')} characters. The full version is in HQ and in your storage.` });
    }
    const links = [...new Set([it.preview_url, str(out.preview_url), ...(Array.isArray(out.links) ? out.links : [])]
      .filter((l): l is string => typeof l === 'string' && !!l.trim()))];
    if (links.length) sections.push({ title: 'Links', md: links.map((l) => `- ${l}`).join('\n') });
    const st = storageOf(it);
    if (st) {
      const lines = st.files.map((f) => ({ label: f.name, url: f.url }));
      if (st.folder_url) lines.push({ label: 'Open the folder', url: st.folder_url });
      sections.push({ title: 'Saved files', html: linkList(lines), text: lines.map((l) => `- ${l.label}: ${l.url}`).join('\n') });
    }
    return { heading: `Result ready: ${it.title}`, meta, sections };
  }

  if (ev === 'plans') {
    const tasks = (Array.isArray(p.tasks) ? p.tasks : []).map(obj);
    const cost = typeof p.estimated_cost_usd === 'number' ? `$${p.estimated_cost_usd.toFixed(2)}` : '';
    meta.push(['Tasks', String(tasks.length)]);
    if (cost) meta.push(['Estimated cost', cost]);
    if (str(p.due_date)) meta.push(['Due', str(p.due_date)]);
    meta.push(['Status', statusLine(it)]);
    if (str(p.summary)) sections.push({ title: 'Summary', md: str(p.summary) });
    if (tasks.length) sections.push({ title: 'Tasks', md: tasks.slice(0, 30).map((t, i) => `${i + 1}. **${ctx.agentName(str(t.agent_id) || null)}**: ${str(t.title)}`).join('\n') + (tasks.length > 30 ? `\n\n…and ${tasks.length - 30} more` : '') });
    const qs = (Array.isArray(p.questions_for_ceo) ? p.questions_for_ceo : []).filter((q): q is string => typeof q === 'string');
    if (qs.length) sections.push({ title: 'Questions for you', md: qs.map((q) => `- ${q}`).join('\n') });
    return { heading: `Plan to approve: ${strip(it.title, /^Plan:\s*/i)}`, meta, sections };
  }

  if (ev === 'questions') {
    meta.push(['Status', statusLine(it)]);
    sections.push({ title: 'Question', md: str(p.question) || str(it.summary) || it.title });
    const options = (Array.isArray(p.options) ? p.options : []).filter((o): o is string => typeof o === 'string');
    if (options.length) sections.push({ title: 'Options', md: options.map((o) => `- ${o}`).join('\n') });
    return { heading: `${agent || 'An agent'} asks you`, meta, sections };
  }

  // failures
  meta.push(['Status', statusLine(it)]);
  const reason = str(p.reason) || str(it.summary);
  if (reason) sections.push({ title: 'What happened', md: reason });
  const next = p.type === 'task_failed' ? 'In HQ or Telegram: Approve = retry with your note, Reject = cancel the task.'
    : p.type === 'qa_stuck' ? 'In HQ or Telegram: Approve = try QA again, Reject = cancel the task.'
      : p.type === 'planning_failed' ? 'Rephrase the request in HQ or Telegram, or cancel it.' : 'Decide in HQ or Telegram what happens next.';
  sections.push({ title: 'What you can do', md: next });
  return { heading: subjectFor(it, ctx).replace(/^(🔴 URGENT · )?⚠️\s*/, ''), meta, sections };
}

function linkList(items: { label: string; url: string }[]): string {
  return `<ul style="${S.list}">${items.map((l) => {
    const href = safeUrl(l.url);
    return `<li style="${S.li}">${href ? `<a href="${esc(href)}" style="${S.a}">${esc(l.label)}</a>` : `${esc(l.label)} (${esc(l.url)})`}</li>`;
  }).join('')}</ul>`;
}

function when(iso: string, tz: string): string {
  try {
    return new Date(iso).toLocaleString('en-GB', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  } catch {
    return iso;
  }
}

/** Subject, plain text and HTML of one email. Pure: every dynamic string is escaped or rendered by markdown.ts. */
export function buildCeoEmail(it: CeoEmailItem, ctx: BuildContext): Omit<CeoMail, 'to'> {
  const subject = subjectFor(it, ctx);
  const { heading, meta, sections } = sectionsFor(it, ctx);
  const link = approvalLink(ctx.dashboardUrl, it.id);
  const href = safeUrl(link);
  const tz = ctx.timezone || 'Asia/Manila';
  const request = (it.request_text || it.request_title || '').trim();
  const requestShown = request.length > 2000 ? `${request.slice(0, 2000)}…` : request;
  const footer = 'Approve, reject or answer in RizeHub HQ or on Telegram. This email is a copy for your records: it has no buttons that act.';
  const sentBy = `Sent by RizeHub HQ · ${when(it.created_at, tz)} (${tz}) · Change or stop these emails in Admin → Connectors → Email me updates.`;

  const text = [
    'RizeHub HQ',
    '',
    heading,
    ...meta.map(([k, v]) => `${k}: ${v}`),
    requestShown ? `\nYour request:\n${requestShown}` : '',
    ...sections.map((s) => `\n${s.title ? `${s.title}\n${'-'.repeat(Math.min(s.title.length, 40))}\n` : ''}${s.text ?? s.md ?? ''}`),
    `\nOpen in HQ: ${link}`,
    '',
    footer,
    sentBy,
  ].filter((l) => l !== '').join('\n');

  const metaHtml = meta.length ? `<table role="presentation" style="border-collapse:collapse;margin:0 0 16px;font-size:14px;">${meta.map(([k, v]) =>
    `<tr><td style="padding:2px 12px 2px 0;color:#667085;white-space:nowrap;vertical-align:top;">${esc(k)}</td><td style="padding:2px 0;color:#1f2328;vertical-align:top;">${esc(v)}</td></tr>`).join('')}</table>` : '';
  const requestHtml = requestShown
    ? `<div style="margin:0 0 18px;padding:10px 12px;background:#f8f9fb;border:1px solid #e4e7ec;border-radius:8px;"><div style="font-size:12px;color:#667085;margin:0 0 4px;text-transform:uppercase;letter-spacing:.04em;">Your request</div><div style="white-space:pre-wrap;word-break:break-word;">${esc(requestShown)}</div></div>`
    : '';
  const sectionsHtml = sections.map((s) => `${s.title ? `<h3 style="font-size:13px;margin:20px 0 8px;color:#667085;text-transform:uppercase;letter-spacing:.04em;">${esc(s.title)}</h3>` : ''}`
    + (s.html ?? (s.md !== undefined ? markdownToHtml(s.md) : `<p style="${S.p}color:#667085;font-size:13px;">${esc(s.text ?? '')}</p>`))).join('\n');
  const button = href
    ? `<p style="margin:24px 0 8px;"><a href="${esc(href)}" style="display:inline-block;background:#2f54eb;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px;">Open in HQ</a></p>`
    : '';

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>`
    + '<body style="margin:0;padding:0;background:#f2f4f7;">'
    + '<table role="presentation" width="100%" style="border-collapse:collapse;background:#f2f4f7;"><tr><td style="padding:16px 8px;">'
    + '<table role="presentation" width="100%" style="border-collapse:collapse;max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e4e7ec;border-radius:12px;">'
    + '<tr><td style="padding:14px 20px;border-bottom:1px solid #e4e7ec;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;color:#1f2328;letter-spacing:.02em;">RizeHub HQ</td></tr>'
    + `<tr><td style="padding:20px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1f2328;">`
    + `<h1 style="font-size:20px;line-height:1.35;margin:0 0 12px;color:#101828;">${esc(heading)}</h1>`
    + metaHtml + requestHtml + sectionsHtml + button
    + `<p style="margin:20px 0 0;font-size:13px;color:#475467;">${esc(footer)}</p>`
    + '</td></tr>'
    + `<tr><td style="padding:12px 20px;border-top:1px solid #e4e7ec;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:12px;color:#667085;">${esc(sentBy)}</td></tr>`
    + '</table></td></tr></table></body></html>';
  return { subject, text, html };
}

export function buildTestEmail(ctx: { dashboardUrl: string; from: string }): Omit<CeoMail, 'to'> {
  const subject = '✅ Test: RizeHub HQ can email you';
  const msg = `This is a test from RizeHub HQ, sent from ${ctx.from}. When "Email me updates" is on, results, questions, plans and failures you chose arrive here. Approving still happens in HQ or on Telegram.`;
  const href = safeUrl(`${ctx.dashboardUrl.replace(/\/+$/, '')}/admin/connectors`);
  return {
    subject,
    text: `RizeHub HQ\n\n${msg}\n${href ? `\nSettings: ${href}\n` : ''}`,
    html: '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:16px 8px;background:#f2f4f7;">'
      + '<table role="presentation" width="100%" style="border-collapse:collapse;max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e4e7ec;border-radius:12px;"><tr><td style="padding:20px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1f2328;">'
      + `<div style="font-weight:700;margin:0 0 12px;">RizeHub HQ</div><p style="${S.p}">${esc(msg)}</p>`
      + (href ? `<p style="margin:16px 0 0;"><a href="${esc(href)}" style="${S.a}">Open Email me updates in HQ</a></p>` : '')
      + '</td></tr></table></body></html>',
  };
}

// ---------- sending ----------
interface Account { id: string; email: string; pass: string }

async function openAccount(d: Pick<CeoEmailDeps, 'store' | 'keyring' | 'log'>, connectorId: string): Promise<Account | { skip: 'account' | 'no_keyring' | 'decrypt'; error: string }> {
  const c = await d.store.get(connectorId);
  if (!c || c.kind !== 'gmail' || c.status !== 'active' || !c.account_email || !c.sealed) {
    return { skip: 'account', error: 'The Gmail account chosen to send from is not connected and active. Check Admin → Connectors.' };
  }
  if (!d.keyring) return { skip: 'no_keyring', error: 'VAULT_MASTER_KEY is not set on the worker.' };
  try {
    return { id: c.id, email: c.account_email, pass: open(c.sealed, d.keyring, connectorContext(c.id)) };
  } catch {
    return { skip: 'decrypt', error: 'The stored App Password could not be decrypted. Replace it in Admin → Connectors.' };
  }
}

/** One pass: send what is due (at most MAX_PER_TICK). Never throws for a single email; stops on a rejected App Password. */
export async function ceoEmailTick(d: CeoEmailDeps): Promise<CeoEmailTickResult> {
  const now = (d.now ?? (() => new Date()))();
  const { value, timezone } = await d.settings();
  const s = parseCeoEmailSettings(value);
  const r: CeoEmailTickResult = { sent: 0, failed: 0, waiting: 0 };
  if (!ceoEmailReady(s) || !isEmailAddress(s.to)) return { ...r, skipped: 'off' };
  const events = CEO_EMAIL_EVENTS.filter((k) => s.events[k]);
  const items = await d.pending(s.enabled_at!, events, 50);
  const { due, waiting } = selectDue(items, s, now, d.settleMs);
  r.waiting = waiting;
  if (!due.length) return r;

  const acc = await openAccount(d, s.connector_id!);
  if ('skip' in acc) { d.log?.(`[ceo-email] not sending: ${acc.error}`); return { ...r, skipped: acc.skip }; }
  const names = await d.agentNames().catch(() => new Map<string, string>());
  const ctx: BuildContext = { agentName: (id) => (id ? names.get(id) ?? id : 'Someone'), dashboardUrl: d.dashboardUrl, timezone: timezone ?? undefined };
  const send = d.send ?? smtpSendCeo;
  for (const it of due) {
    const key = `approval:${it.id}`;
    let mail: CeoMail;
    try {
      mail = { to: s.to!, ...buildCeoEmail(it, ctx) };
    } catch (e) {
      r.failed++;
      await d.record(key, false, `Could not build the email: ${e instanceof Error ? e.message.slice(0, 200) : 'error'}`).catch(() => undefined);
      continue;
    }
    try {
      await send(acc.email, acc.pass, mail);
      await d.record(key, true, null);
      r.sent++;
    } catch (e) {
      const f = friendlyGmailError(e);
      r.failed++;
      await d.record(key, false, f.message).catch(() => undefined);
      d.log?.(`[ceo-email] ${key} not sent: ${f.message}`);
      if (f.reauth) { await d.store.mark(acc.id, 'needs_reauth', f.message).catch(() => undefined); break; }
    }
  }
  if (r.sent) {
    await d.store.mark(acc.id, 'active', null, true).catch(() => undefined);
    d.log?.(`[ceo-email] sent ${r.sent} update(s) from ${acc.email}`);
  }
  return r;
}

/** "Send test email" (Admin → Connectors): one email to the SAVED address, from the SAVED account (on or off). */
export async function sendCeoTestEmail(d: Omit<CeoEmailDeps, 'pending' | 'agentNames'>): Promise<{ ok: true; to: string; from: string } | { ok: false; error: string }> {
  const s = parseCeoEmailSettings((await d.settings()).value);
  if (!s.connector_id) return { ok: false, error: 'Save a Gmail account to send from first.' };
  if (!s.to || !isEmailAddress(s.to)) return { ok: false, error: 'Save the address to send to first.' };
  const acc = await openAccount(d, s.connector_id);
  if ('skip' in acc) return { ok: false, error: acc.error };
  const key = `test:${(d.now ?? (() => new Date()))().toISOString()}`;
  try {
    await (d.send ?? smtpSendCeo)(acc.email, acc.pass, { to: s.to, ...buildTestEmail({ dashboardUrl: d.dashboardUrl, from: acc.email }) });
    await d.record(key, true, null).catch(() => undefined);
    await d.store.mark(acc.id, 'active', null, true).catch(() => undefined);
    return { ok: true, to: s.to, from: acc.email };
  } catch (e) {
    const f = friendlyGmailError(e);
    await d.record(key, false, f.message).catch(() => undefined);
    if (f.reauth) await d.store.mark(acc.id, 'needs_reauth', f.message).catch(() => undefined);
    return { ok: false, error: f.message };
  }
}

// ---------- production wiring ----------
export function supabaseCeoEmailDeps(sb: SupabaseClient): Pick<CeoEmailDeps, 'settings' | 'pending' | 'record' | 'agentNames'> {
  return {
    settings: async () => {
      const { data, error } = await sb.from('settings').select('key,value').in('key', [CEO_EMAIL_SETTING_KEY, 'timezone']);
      if (error) throw new Error(`settings: ${error.message}`);
      const rows = (data ?? []) as { key: string; value: unknown }[];
      const tz = rows.find((x) => x.key === 'timezone')?.value;
      return { value: rows.find((x) => x.key === CEO_EMAIL_SETTING_KEY)?.value ?? null, timezone: typeof tz === 'string' ? tz : null };
    },
    pending: async (since, events, limit) => {
      const { data, error } = await sb.rpc('ceo_email_pending', { p_since: since, p_events: events, p_limit: limit });
      if (error) throw new Error(`ceo_email_pending: ${error.message}`);
      return (data ?? []) as CeoEmailItem[];
    },
    record: async (key, ok, err) => {
      const { error } = await sb.rpc('ceo_email_record', { p_key: key, p_ok: ok, p_error: err });
      if (error) throw new Error(`ceo_email_record: ${error.message}`);
    },
    agentNames: async () => {
      const { data, error } = await sb.from('agents').select('id,name');
      if (error) throw new Error(`agents: ${error.message}`);
      return new Map(((data ?? []) as { id: string; name: string }[]).map((a) => [a.id, a.name]));
    },
  };
}

/** Production timer (index.ts): every 30 s, skipped while the CEO has paused HQ (settings.paused), like the other senders. */
export function startCeoEmailSender(o: { deps: CeoEmailDeps; paused: () => Promise<boolean>; everyMs?: number }): NodeJS.Timeout {
  let busy = false;
  const t = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => { if (!(await o.paused())) await ceoEmailTick(o.deps); })()
      .catch((e) => o.deps.log?.(`[ceo-email] loop failed: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`))
      .finally(() => { busy = false; });
  }, o.everyMs ?? CEO_EMAIL_EVERY_MS);
  t.unref?.();
  return t;
}
