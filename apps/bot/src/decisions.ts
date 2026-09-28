// Button + "What should change?" flow (docs/08 "Approval messages"). Framework-free so it is testable:
// index.ts adapts grammY contexts to these calls.
import type { BotDb } from './db';
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

/** A tap on ✅ / ✏️ / ❌. Re-checks the approval is still pending before applying. */
export async function onButton(d: DecisionDeps, chatId: number, messageId: number, approvalId: string, action: Decision, now = Date.now()): Promise<ButtonOutcome> {
  const ap = await d.db.getApproval(approvalId);
  if (!ap) return { kind: 'toast', toast: 'This approval no longer exists' };
  if (ap.status !== 'pending') {
    const { text, markup } = renderApproval(ap, d.names(), d.dashboardUrl, d.tz());
    return { kind: 'edit', text, markup, toast: 'Already decided' };
  }
  if (action === 'changes') {
    d.pending.set(chatId, approvalId, messageId, now);
    const question = ap.kind === 'external_action' && (ap.payload as { type?: string } | null)?.type === 'question';
    return { kind: 'ask_note', toast: question ? 'Type your answer' : 'What should change?',
      prompt: `${question ? 'Your answer' : 'What should change'} for “${ap.title}”? Reply within 10 minutes (/cancel to stop).` };
  }
  return apply(d, approvalId, action, null);
}

async function apply(d: DecisionDeps, approvalId: string, action: Decision, note: string | null): Promise<ButtonOutcome & { kind: 'edit' }> {
  const result = await d.db.decide(approvalId, action, note);
  const ap = await d.db.getApproval(approvalId);
  if (!ap) throw new Error('approval disappeared');
  const { text, markup } = renderApproval(ap, d.names(), d.dashboardUrl, d.tz());
  return { kind: 'edit', text, markup, toast: result.startsWith('already_') ? 'Already decided' : TOAST[result] ?? 'Done' };
}

/** A text message while a note is pending: it becomes the change note. Returns null when nothing was pending. */
export async function onNoteText(d: DecisionDeps, chatId: number, text: string, now = Date.now()):
  Promise<{ messageId: number; edit: { text: string; markup: InlineMarkup }; reply: string } | null> {
  const p = d.pending.take(chatId, now);
  if (!p) return null;
  const note = text.trim();
  const out = await apply(d, p.approvalId, 'changes', note);
  return { messageId: p.messageId, edit: { text: out.text, markup: out.markup }, reply: out.toast === 'Already decided' ? 'That one was already decided, so your note was not applied.' : `✏️ ${out.toast}.` };
}
