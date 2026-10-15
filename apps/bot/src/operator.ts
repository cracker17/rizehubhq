// Julev Operator on Telegram (docs/17-OPERATOR.md "Telegram"): reply drafts arrive as normal approvals with
// payload.type 'operator_reply' and get ✅ Send / ✏️ Edit / ⏭ Skip; auto-sends, failures and blocks arrive as notices
// (operator_actions rows the bot marks sent); /inbox, /pause [client], /resume [client] and /status <client>.
// Pure formatting here (tested); index.ts wires the commands.
import { esc, hhmmIn, truncate } from './format';
import type { BotApproval } from './types';

export interface OperatorReplyPayload {
  type: 'operator_reply';
  client?: string; client_name?: string; channel?: string; space?: string | null; sender?: string; message?: string;
  message_url?: string | null; draft?: string; category?: string; action_types?: string[]; confidence?: number | string;
  summary?: string | null; task_plan?: string[] | null; project?: string | null;
}

export const isOperatorReply = (ap: Pick<BotApproval, 'kind' | 'payload'>) =>
  ap.kind === 'external_action' && (ap.payload as { type?: string } | null)?.type === 'operator_reply';

export const OPERATOR_LABELS = { approve: '✅ Send', changes: '✏️ Edit', reject: '⏭ Skip' } as const;

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

/** Result line after a decision on a reply draft. */
export function operatorDecisionLine(ap: Pick<BotApproval, 'status' | 'decided_at' | 'decided_via' | 'ceo_note'>, tz: string): string {
  if (ap.status === 'pending') return '';
  const at = ap.decided_at ? ` ${hhmmIn(ap.decided_at, tz)}` : '';
  const via = ap.decided_via === 'dashboard' ? ' (dashboard)' : '';
  if (ap.status === 'approved') return `<b>✅ Approved${at}: posting the draft</b>${via}`;
  if (ap.status === 'changes_requested') return `<b>✏️ Edited${at}: posting your text</b>${via}${ap.ceo_note ? `\n“${esc(clip(ap.ceo_note, 600))}”` : ''}`;
  return `<b>⏭ Skipped${at}</b>${via}`;
}

// ---------- notices (operator_actions) ----------

export interface OperatorNotice {
  id: number;
  created_at: string;
  client_slug: string | null;
  inbox_id: string | null;
  action: string;
  ok: boolean;
  detail: Record<string, unknown> | null;
  /** Embedded inbox row (PostgREST operator_inbox(...)). */
  operator_inbox?: { sender_name: string | null; final_text: string | null; mode: string | null; error: string | null; url: string | null } | null;
}

/** Notice kinds sent to Telegram. send.done only for auto-sends (approved ones were already decided in the chat). */
export const NOTICE_ACTIONS = ['send.done', 'send.failed', 'send.blocked', 'message.classify_failed', 'watch.failed'] as const;

export function shouldNotify(n: Pick<OperatorNotice, 'action' | 'operator_inbox' | 'detail'>): boolean {
  if (n.action === 'send.done') return (n.operator_inbox?.mode ?? (n.detail as { mode?: string } | null)?.mode) === 'auto';
  if (n.action === 'message.classify_failed') return Number((n.detail as { attempts?: number } | null)?.attempts ?? 0) >= 3;
  return (NOTICE_ACTIONS as readonly string[]).includes(n.action);
}

export function formatOperatorNotice(n: OperatorNotice): string {
  const d = (n.detail ?? {}) as { error?: string; reason?: string; channel?: string; action_types?: string[] };
  const who = n.operator_inbox?.sender_name ? ` to ${esc(n.operator_inbox.sender_name)}` : '';
  const client = esc(n.client_slug ?? 'operator');
  switch (n.action) {
    case 'send.done':
      return truncate(`⚡ <b>Auto-replied</b>${who} · ${client}\n<blockquote>${esc(clip(n.operator_inbox?.final_text, 800))}</blockquote>\n/pause stops all sends.`);
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
  return lines.join('\n');
}

/** Splits "/pause lvlup" style arguments: a client slug or nothing. */
export function clientArg(match: string | undefined | null): string | null {
  const a = (match ?? '').trim().toLowerCase().replace(/^@/, '');
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(a) ? a : null;
}
