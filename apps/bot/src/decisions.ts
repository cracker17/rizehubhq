// Button + "What should change?" flow (docs/08 "Approval messages"). Framework-free so it is testable:
// index.ts adapts grammY contexts to these calls.
import type { BotDb } from './db';
import { is2fa } from './format';
import { renderApproval } from './notifier';
import type { PendingNotes } from './pending';
import type { Decision } from './types';
import type { InlineMarkup } from './keyboard';

export interface DecisionDeps { db: BotDb; pending: PendingNotes; names: () => Map<string, string>; dashboardUrl: string; tz: () => string }

export type ButtonOutcome =
  | { kind: 'edit'; text: string; markup: InlineMarkup; toast: string }
  | { kind: 'ask_note'; prompt: string; toast: string }
  | { kind: 'toast'; toast: string };

const TOAST: Record<string, string> = {
  plan_approved: 'Plan approved: tasks are queued', replan: 'Sent back to the COO', plan_rejected: 'Plan rejected',
  task_done: 'Approved: marked done', task_revision: 'Sent back for changes', task_cancelled: 'Rejected: task cancelled',
  action_approved: 'Approved', action_changes_requested: 'Sent back with your note', action_rejected: 'Rejected',
};

/** A one-time code as typed ("482 913" → "482913"); null when it doesn't look like one. */
export function normalizeOtp(text: string): string | null {
  const code = text.replace(/\s+/g, '');
  return /^[A-Za-z0-9-]{4,12}$/.test(code) ? code : null;
}

/** A tap on ✅ / ✏️ / ❌. Re-checks the approval is still pending before applying. */
export async function onButton(d: DecisionDeps, chatId: number, messageId: number, approvalId: string, action: Decision, now = Date.now()): Promise<ButtonOutcome> {
  const ap = await d.db.getApproval(approvalId);
  if (!ap) return { kind: 'toast', toast: 'This approval no longer exists' };
  if (ap.status !== 'pending') {
    const { text, markup } = renderApproval(ap, d.names(), d.dashboardUrl, d.tz());
    return { kind: 'edit', text, markup, toast: 'Already decided' };
  }
  // Vault 2FA: ✅ and ✏️ both mean "here is the code", which must be typed; ❌ declines.
  if (is2fa(ap) && action !== 'reject') {
    d.pending.set(chatId, approvalId, messageId, now, 'approve');
    return { kind: 'ask_note', toast: 'Type the code', prompt: `Reply with the one-time code for “${ap.title}” (digits only). It is passed to the agent's login and never shown or logged. /cancel to stop.` };
  }
  if (action === 'changes') {
    d.pending.set(chatId, approvalId, messageId, now);
    const question = ap.kind === 'external_action' && (ap.payload as { type?: string } | null)?.type === 'question';
    return { kind: 'ask_note', toast: question ? 'Type your answer' : 'What should change?',
      prompt: `${question ? 'Your answer' : 'What should change'} for “${ap.title}”? Reply within 10 minutes (/cancel to stop).` };
  }
  try {
    return await apply(d, approvalId, action, null);
  } catch (e) {
    // 2FA is on and this is a high-risk external action: approving needs a fresh TOTP code, which only the dashboard can
    // ask for (decide_approval → ceo_step_up_guard). Reject / request changes still work here.
    if (isStepUpError(e)) return { kind: 'toast', toast: 'Needs your 2FA code: approve this one in the dashboard' };
    throw e;
  }
}

/** decide_approval refused because the approval needs a fresh 2FA step-up (docs/09 "Two-factor (TOTP)"). */
export function isStepUpError(e: unknown): boolean {
  return /step_up_required/i.test(e instanceof Error ? e.message : String(e ?? ''));
}

async function apply(d: DecisionDeps, approvalId: string, action: Decision, note: string | null): Promise<ButtonOutcome & { kind: 'edit' }> {
  const result = await d.db.decide(approvalId, action, note);
  const ap = await d.db.getApproval(approvalId);
  if (!ap) throw new Error('approval disappeared');
  const { text, markup } = renderApproval(ap, d.names(), d.dashboardUrl, d.tz());
  return { kind: 'edit', text, markup, toast: result.startsWith('already_') ? 'Already decided' : TOAST[result] ?? 'Done' };
}

/**
 * A text message while a note is pending: it becomes the change note (or, for a Vault 2FA question, the code, applied
 * as 'approve'). Returns null when nothing was pending. `secret` = the CEO's message holds a code: delete it from the chat.
 */
export async function onNoteText(d: DecisionDeps, chatId: number, text: string, now = Date.now()):
  Promise<{ messageId: number; edit: { text: string; markup: InlineMarkup }; reply: string; secret?: boolean } | null> {
  const p = d.pending.peek(chatId, now);
  if (!p) return null;
  if (p.decision === 'approve') {
    const code = normalizeOtp(text);
    const ap = await d.db.getApproval(p.approvalId);
    if (!code && ap?.status === 'pending') {
      // Keep waiting for the code (the entry stays pending); nothing is decided.
      const { text: t, markup } = renderApproval(ap, d.names(), d.dashboardUrl, d.tz());
      return { messageId: p.messageId, edit: { text: t, markup }, reply: 'That doesn\'t look like a one-time code (4–12 letters/digits). Send just the code, or /cancel.', secret: true };
    }
    d.pending.take(chatId, now);
    const out = await apply(d, p.approvalId, 'approve', code ?? text.trim());
    const already = out.toast === 'Already decided';
    return { messageId: p.messageId, edit: { text: out.text, markup: out.markup }, secret: true,
      reply: already ? 'That request was already closed, so the code was not used.' : '🔐 Code sent to the agent\'s login. I deleted your message.' };
  }
  d.pending.take(chatId, now);
  const note = text.trim();
  const out = await apply(d, p.approvalId, 'changes', note);
  return { messageId: p.messageId, edit: { text: out.text, markup: out.markup }, reply: out.toast === 'Already decided' ? 'That one was already decided, so your note was not applied.' : `✏️ ${out.toast}.` };
}
