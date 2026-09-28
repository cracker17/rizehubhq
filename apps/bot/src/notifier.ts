// Outbound notifier (docs/08 "Notifications"): polls Supabase (no realtime needed) and pushes
// new approvals (with buttons), reports, and dashboard decisions (edits the Telegram message).
import type { BotDb } from './db';
import { formatApproval, formatReport, isQuestion } from './format';
import { approvalKeyboard, decidedKeyboard, type InlineMarkup } from './keyboard';
import { inQuietHours, parseQuietHours, shouldSendApproval } from './quiet';
import type { BotApproval } from './types';

export interface Sender {
  send(chatId: number, html: string, markup?: InlineMarkup): Promise<number>;
  edit(chatId: number, messageId: number, html: string, markup?: InlineMarkup): Promise<void>;
}

export interface NotifierDeps {
  db: BotDb;
  sender: Sender;
  chatId: number;
  dashboardUrl: string;
  names: () => Map<string, string>;
  now?: () => Date;
  log?: (msg: string) => void;
}

export interface NotifierState { lastDecisionSync: string }
export interface TickResult { sent: number; held: number; reports: number; synced: number; errors: number; quiet: boolean }

export const REPORT_LOOKBACK_MS = 36 * 3600_000;

export function tzOf(settings: Record<string, unknown>): string {
  return typeof settings.timezone === 'string' && settings.timezone ? settings.timezone : 'Asia/Manila';
}

/** Text + keyboard for an approval in its current state. */
export function renderApproval(ap: BotApproval, names: Map<string, string>, dashboardUrl: string, tz: string): { text: string; markup: InlineMarkup } {
  const text = formatApproval(ap, names, tz);
  const markup = ap.status === 'pending'
    ? approvalKeyboard(ap.id, dashboardUrl, { changesLabel: isQuestion(ap) ? '✏️ Answer' : undefined })
    : decidedKeyboard(ap.id, dashboardUrl);
  return { text, markup };
}

export async function notifierTick(deps: NotifierDeps, state: NotifierState): Promise<TickResult> {
  const now = (deps.now ?? (() => new Date()))();
  const log = deps.log ?? ((m: string) => console.log(m));
  const settings = await deps.db.getSettings();
  const tz = tzOf(settings);
  const quiet = inQuietHours(now, parseQuietHours(settings.quiet_hours), tz);
  const r: TickResult = { sent: 0, held: 0, reports: 0, synced: 0, errors: 0, quiet };
  const names = deps.names();

  // 1. new approvals → one message each (sent once: telegram_message_id is stored)
  for (const ap of await deps.db.unsentApprovals(20)) {
    if (!shouldSendApproval(ap, quiet)) { r.held++; continue; }
    try {
      const { text, markup } = renderApproval(ap, names, deps.dashboardUrl, tz);
      const messageId = await deps.sender.send(deps.chatId, text, markup);
      await deps.db.setApprovalMessageId(ap.id, messageId);
      r.sent++;
    } catch (e) {
      r.errors++;
      log(`[bot] could not send approval ${ap.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 2. digest / morning brief / weekly (held during quiet hours)
  if (!quiet) {
    for (const rep of await deps.db.unsentReports(new Date(now.getTime() - REPORT_LOOKBACK_MS).toISOString())) {
      try {
        await deps.sender.send(deps.chatId, formatReport(rep, names, deps.dashboardUrl));
        await deps.db.markReportSent(rep.id);
        r.reports++;
      } catch (e) {
        r.errors++;
        log(`[bot] could not send report ${rep.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // 3. decided in the dashboard → update the Telegram message so it is never actioned twice
  for (const ap of await deps.db.decidedSince(state.lastDecisionSync)) {
    if (ap.decided_at && ap.decided_at > state.lastDecisionSync) state.lastDecisionSync = ap.decided_at;
    if (ap.decided_via === 'telegram' || !ap.telegram_message_id) continue; // telegram decisions are edited on the spot
    try {
      const { text, markup } = renderApproval(ap, names, deps.dashboardUrl, tz);
      await deps.sender.edit(deps.chatId, ap.telegram_message_id, text, markup);
      r.synced++;
    } catch (e) {
      log(`[bot] could not update message for approval ${ap.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return r;
}
