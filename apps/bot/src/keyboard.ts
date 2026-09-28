// Inline keyboards as plain Bot API objects (no grammY needed → easy to test).
import { callbackData } from './callbacks';

export type InlineButton = { text: string; callback_data: string } | { text: string; url: string };
export interface InlineMarkup { inline_keyboard: InlineButton[][] }

/** Telegram refuses URL buttons that point at localhost / private hosts. */
export function isPublicUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    return !/^(localhost|127\.|10\.|192\.168\.|0\.0\.0\.0|\[::1\])/.test(u.hostname) && u.hostname.includes('.');
  } catch { return false; }
}

export function approvalUrl(dashboardUrl: string, approvalId: string): string {
  return `${dashboardUrl.replace(/\/+$/, '')}/approvals?id=${encodeURIComponent(approvalId)}`;
}

/** [✅ Approve] [✏️ Changes] [❌ Reject] [🔗 Open]; "Open" is dropped when the dashboard URL is not public. */
export function approvalKeyboard(approvalId: string, dashboardUrl: string, opts: { changesLabel?: string } = {}): InlineMarkup {
  const row: InlineButton[] = [
    { text: '✅ Approve', callback_data: callbackData(approvalId, 'approve') },
    { text: opts.changesLabel ?? '✏️ Changes', callback_data: callbackData(approvalId, 'changes') },
    { text: '❌ Reject', callback_data: callbackData(approvalId, 'reject') },
  ];
  const url = approvalUrl(dashboardUrl, approvalId);
  if (isPublicUrl(url)) row.push({ text: '🔗 Open', url });
  return { inline_keyboard: [row] };
}

/** After a decision: only the Open button (or nothing). */
export function decidedKeyboard(approvalId: string, dashboardUrl: string): InlineMarkup {
  const url = approvalUrl(dashboardUrl, approvalId);
  return { inline_keyboard: isPublicUrl(url) ? [[{ text: '🔗 Open', url }]] : [] };
}
