// When reports are due (docs/05 "Scheduled work"). Pure: given "now", the settings and the reports
// that already exist, returns the jobs to run. Catch-up is built in: a job stays due until its row
// exists, so a worker that was down at 18:00 writes the digest as soon as it is back.

export type ScheduledKind = 'daily_digest' | 'morning_brief' | 'weekly';
export interface ReportJob {
  kind: ScheduledKind;
  /** reports.report_date (Monday of the week for weekly). */
  date: string;
  /** Facts window: [from, from + days). */
  from: string;
  days: number;
}
export interface ScheduleSettings { tz: string; digestMin: number; morningMin: number; weeklyMin: number }

export function parseHhmm(v: unknown, fallback: string): number {
  const s = typeof v === 'string' ? v : fallback;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return parseHhmm(fallback, '00:00');
  return Number(m[1]) * 60 + Number(m[2]);
}

export function scheduleSettings(raw: Record<string, unknown>): ScheduleSettings {
  const tz = typeof raw.timezone === 'string' && raw.timezone ? raw.timezone : 'Asia/Manila';
  return {
    tz,
    digestMin: parseHhmm(raw.digest_time, '18:00'),
    morningMin: parseHhmm(raw.morning_brief_time, '08:00'),
    weeklyMin: parseHhmm(raw.weekly_time, '08:00'),
  };
}

/** Local calendar date, minute of day and weekday (0 = Sunday) in `tz`. */
export function localParts(now: Date, tz: string): { date: string; minutes: number; weekday: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(now).map((p) => [p.type, p.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute), weekday };
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const reportKey = (kind: string, date: string) => `${kind}:${date}`;

/**
 * Jobs due now, oldest first.
 * - daily digest: today from digest_time on; yesterday's too if it is missing (catch-up after downtime).
 * - morning brief: today between morning_brief_time and digest_time (a brief written at 21:00 is useless).
 * - weekly: Monday from weekly_time on, or any later day that week if it was missed; covers the previous Mon–Sun.
 */
export function dueJobs(now: Date, s: ScheduleSettings, existing: Set<string>): ReportJob[] {
  const { date, minutes, weekday } = localParts(now, s.tz);
  const jobs: ReportJob[] = [];
  const add = (j: ReportJob) => { if (!existing.has(reportKey(j.kind, j.date))) jobs.push(j); };

  const yesterday = addDays(date, -1);
  add({ kind: 'daily_digest', date: yesterday, from: yesterday, days: 1 });
  if (minutes >= s.morningMin && minutes < s.digestMin) add({ kind: 'morning_brief', date, from: date, days: 1 });
  if (minutes >= s.digestMin) add({ kind: 'daily_digest', date, from: date, days: 1 });

  const sinceMonday = (weekday + 6) % 7;
  const monday = addDays(date, -sinceMonday);
  if (sinceMonday > 0 || minutes >= s.weeklyMin) add({ kind: 'weekly', date: monday, from: addDays(monday, -7), days: 7 });
  return jobs;
}
