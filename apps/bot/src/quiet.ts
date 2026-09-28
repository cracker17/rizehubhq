// Quiet hours (docs/08): settings.quiet_hours = {"start":"22:00","end":"07:00"} in the HQ timezone.
// During quiet hours only urgent-request approvals and task failures go out; the rest wait for morning.
import type { BotApproval } from './types';

export interface QuietHours { start: number; end: number; enabled: boolean }
export const DEFAULT_QUIET: QuietHours = { start: 22 * 60, end: 7 * 60, enabled: true };

function hhmm(v: unknown): number | null {
  const m = typeof v === 'string' ? /^(\d{1,2}):(\d{2})$/.exec(v.trim()) : null;
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function parseQuietHours(v: unknown): QuietHours {
  if (v === false || v === null || v === 'off') return { ...DEFAULT_QUIET, enabled: false };
  if (!v || typeof v !== 'object') return DEFAULT_QUIET;
  const o = v as { start?: unknown; end?: unknown; enabled?: unknown };
  const start = hhmm(o.start), end = hhmm(o.end);
  if (start === null || end === null) return DEFAULT_QUIET;
  return { start, end, enabled: o.enabled !== false && start !== end };
}

export function minutesIn(now: Date, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map((x) => [x.type, x.value]));
  return Number(p.hour) * 60 + Number(p.minute);
}

/** True inside [start, end), wrapping past midnight when start > end. */
export function inQuietHours(now: Date, q: QuietHours, tz = 'Asia/Manila'): boolean {
  if (!q.enabled) return false;
  const m = minutesIn(now, tz);
  return q.start < q.end ? m >= q.start && m < q.end : m >= q.start || m < q.end;
}

/** Goes out even in quiet hours: approvals of urgent requests, and "task failed" alerts. */
export function isUrgentApproval(ap: Pick<BotApproval, 'payload' | 'requests'>): boolean {
  return ap.requests?.priority === 'urgent' || (ap.payload as { type?: string } | null)?.type === 'task_failed';
}

export function shouldSendApproval(ap: Pick<BotApproval, 'payload' | 'requests'>, quiet: boolean): boolean {
  return !quiet || isUrgentApproval(ap);
}
