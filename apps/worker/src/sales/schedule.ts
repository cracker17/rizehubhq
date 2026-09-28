// Follow-up schedule + daily send cap with warm-up. Pure functions (mirrored in SQL where SQL enforces them).

const DAY = 86_400_000;
/** Days after the FIRST touch for follow-up #1, #2, #3; after #3 the lead is closed as no-response on day 21. */
export const FOLLOW_UP_DAYS = [3, 7, 14] as const;
export const NO_RESPONSE_DAY = 21;
export const MAX_FOLLOW_UPS = FOLLOW_UP_DAYS.length;

/** When the next step is due, given how many follow-ups were sent. Mirrors sales_next_follow_up(). */
export function nextFollowUpAt(firstTouch: Date, sentFollowUps: number): { at: Date; kind: 'follow_up' | 'close_no_response'; number?: number } {
  if (sentFollowUps < MAX_FOLLOW_UPS) {
    return { at: new Date(firstTouch.getTime() + FOLLOW_UP_DAYS[Math.max(0, sentFollowUps)]! * DAY), kind: 'follow_up', number: sentFollowUps + 1 };
  }
  return { at: new Date(firstTouch.getTime() + NO_RESPONSE_DAY * DAY), kind: 'close_no_response' };
}

export interface CapOptions {
  /** OUTREACH_DAILY_SEND_CAP (default 20). */
  cap: number;
  /** OUTREACH_WARMUP_START_PER_DAY (default 10). */
  warmupStart: number;
  /** OUTREACH_WARMUP_STEP_PER_WEEK (default 5). */
  warmupStepPerWeek: number;
  /** First day the outreach domain sent (OUTREACH_WARMUP_START or the first email in the DB). null = not started. */
  warmupFrom: Date | null;
}

/** Hard ceilings: 30/day without OUTREACH_ALLOW_HIGHER_CAP, 50 with it (SQL refuses above 50 regardless). */
export const CAP_DEFAULT_MAX = 30;
export const CAP_ABSOLUTE_MAX = 50;

/** Emails allowed today: the warm-up ramp (start, +step every 7 days) up to the configured cap. */
export function capForDay(o: CapOptions, now: Date): { cap: number; warmupDay: number; ramp: number } {
  const start = o.warmupFrom ?? now;
  const days = Math.max(0, Math.floor((now.getTime() - start.getTime()) / DAY));
  const ramp = o.warmupStart + o.warmupStepPerWeek * Math.floor(days / 7);
  return { cap: Math.max(0, Math.min(o.cap, ramp)), warmupDay: days + 1, ramp };
}

/** Manila date (YYYY-MM-DD) + hour (0–23): the daily batch, the send-cap day and quiet hours all run on Manila time. */
export function manilaClock(now: Date): { day: string; hour: number } {
  const day = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  const hour = Number(now.toLocaleString('en-GB', { timeZone: 'Asia/Manila', hour: '2-digit', hourCycle: 'h23' }));
  return { day, hour };
}

/** True inside OUTREACH_QUIET_HOURS ([start, end) Manila hours; start > end wraps midnight). null = never quiet. */
export function inQuietHours(q: { start: number; end: number } | null, now: Date): boolean {
  if (!q) return false;
  const { hour } = manilaClock(now);
  return q.start < q.end ? hour >= q.start && hour < q.end : hour >= q.start || hour < q.end;
}
