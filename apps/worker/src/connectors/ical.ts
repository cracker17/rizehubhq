// Google Calendar, read-only, through the calendar's "Secret address in iCal format" (docs/15 §5b). No OAuth: Google's
// Calendar OAuth for personal accounts expires weekly unless the app is verified, and App Passwords don't cover Calendar.
// The secret address is a credential (anyone holding it reads the calendar): it is sealed in the connector row, never
// logged, and never put in an error message. Fetches go through the SSRF-safe research transport (public hosts only).
import ical, { type CalendarResponse, type VEvent } from 'node-ical';
import { BlockedUrlError, checkUrlShape, defaultNetEnv, safeFetch, type NetEnv } from '../research/net';

export const ICAL_MAX_BYTES = 5 * 1024 * 1024;
export const ICAL_TIMEOUT_MS = 20_000;
export const ICAL_CACHE_MS = 5 * 60_000;
export const DEFAULT_CALENDAR_TZ = 'Asia/Manila';
const DAY = 86_400_000;

/** A calendar problem in plain words. `reauth` = the stored address stopped working (reset in Google, or deleted). */
export class IcalError extends Error {
  constructor(message: string, readonly reauth = false) { super(message); }
}

export interface Person { name: string | null; email: string | null; response?: string | null }
export interface CalEvent {
  /** ISO with the zone's offset, e.g. 2026-09-28T09:00:00+08:00; all-day: the date (2026-09-28). */
  start: string;
  /** Exclusive end, same format. */
  end: string;
  allDay: boolean;
  title: string;
  location: string | null;
  meetingLink: string | null;
  attendees: Person[];
  organizer: Person | null;
  status: 'confirmed' | 'tentative';
  recurring: boolean;
  /** For sorting and overlap. */
  startMs: number;
  endMs: number;
}
export interface ParsedCalendar { name: string | null; timezone: string | null; data: CalendarResponse; eventCount: number }
export type IcsFetcher = (url: string) => Promise<string>;

// ---------- the address ----------
/**
 * Checks the pasted address without any network: https (webcal:// becomes https://), no embedded login, a public-looking
 * host, and a path ending in .ics (Google: /calendar/ical/<id>/private-<key>/basic.ics). Returns the https URL or a
 * reason. Never echoes the address back.
 */
export function checkIcalUrl(raw: unknown): string | { error: string } {
  let s = String(raw ?? '').trim();
  if (/^webcals?:\/\//i.test(s)) s = s.replace(/^webcals?:\/\//i, 'https://');
  if (!/^https:\/\//i.test(s)) return { error: 'Paste the https address Google shows under "Secret address in iCal format".' };
  let u: URL;
  try { u = checkUrlShape(s); } catch (e) { return { error: e instanceof BlockedUrlError && /embedded credentials/.test(e.message) ? 'The address must not contain a login.' : 'That is not a public calendar address.' }; }
  if (u.protocol !== 'https:') return { error: 'Only https calendar addresses are allowed.' };
  if (!/\.ics$/i.test(u.pathname)) {
    return { error: 'That does not look like an iCal feed (it should end in .ics). In Google Calendar copy the "Secret address in iCal format", not the public or embed link.' };
  }
  if (u.hostname.toLowerCase() === 'calendar.google.com' && /\/public\/basic\.ics$/i.test(u.pathname)) {
    return { error: 'That is the public address (it only works for public calendars). Copy the "Secret address in iCal format" instead.' };
  }
  return u.toString();
}

/** A short, non-secret label for the address (its host). */
export const icalHost = (url: string) => { try { return new URL(url).hostname.toLowerCase(); } catch { return 'calendar'; } };

/** GET the feed: SSRF-checked on every hop, https only, 20 s, 5 MB. Errors never contain the address. */
export function createIcsFetcher(net: NetEnv = defaultNetEnv()): IcsFetcher {
  return async (url) => {
    const ok = checkIcalUrl(url);
    if (typeof ok !== 'string') throw new IcalError(ok.error);
    let res: Awaited<ReturnType<typeof safeFetch>>;
    try {
      res = await safeFetch(ok, net, {
        timeoutMs: ICAL_TIMEOUT_MS, maxBytes: ICAL_MAX_BYTES, maxRedirects: 3,
        headers: { accept: 'text/calendar, text/plain;q=0.8, */*;q=0.5' },
      });
    } catch (e) {
      // The underlying messages can include the path (= the secret): replace them all.
      const m = e instanceof Error ? e.message : '';
      if (e instanceof BlockedUrlError) throw new IcalError('That calendar address points to a private or blocked host.');
      if (/timed out/i.test(m)) throw new IcalError(`The calendar did not answer within ${ICAL_TIMEOUT_MS / 1000} s. Try again.`);
      if (/too many redirects/i.test(m)) throw new IcalError('The calendar address redirects too many times.');
      if (/too large/i.test(m)) throw new IcalError('The calendar feed is larger than 5 MB.');
      throw new IcalError('Could not reach the calendar (network). Try again.');
    }
    if (!/^https:/i.test(res.url)) throw new IcalError('The calendar redirected to a non-https address; refused.');
    if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 410) {
      throw new IcalError('Google no longer accepts this secret address (it was reset, or the calendar was removed). Add the new address in Admin → Connectors.', true);
    }
    if (res.status < 200 || res.status >= 300) throw new IcalError(`The calendar server answered HTTP ${res.status}. Try again later.`);
    if (res.truncated) throw new IcalError('The calendar feed is larger than 5 MB.');
    return res.body.toString('utf8');
  };
}

// ---------- parsing ----------
export function parseIcs(text: string): ParsedCalendar {
  if (!/^﻿?\s*BEGIN:VCALENDAR/i.test(text) || !/END:VCALENDAR/i.test(text)) {
    throw new IcalError('That address did not return a calendar (no VCALENDAR). Copy the "Secret address in iCal format" again.');
  }
  let data: CalendarResponse;
  try { data = ical.sync.parseICS(text); } catch { throw new IcalError('The calendar feed could not be read (malformed iCal).'); }
  const cal = data.vcalendar;
  const eventCount = Object.values(data).filter((v) => (v as { type?: string } | undefined)?.type === 'VEVENT').length;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null);
  return { name: str(cal?.['WR-CALNAME']), timezone: str(cal?.['WR-TIMEZONE']), data, eventCount };
}

// ---------- time zones (Intl only) ----------
export function validTimeZone(tz: unknown): string | null {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return null; }
}

const partsFmt = new Map<string, Intl.DateTimeFormat>();
function zonedParts(d: Date, tz: string) {
  let f = partsFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
    partsFmt.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value])) as Record<string, string>;
  return { y: +p.year!, m: +p.month!, d: +p.day!, hh: +p.hour! % 24, mm: +p.minute!, ss: +p.second!, wd: p.weekday! };
}
/** Minutes east of UTC for `tz` at instant `d`. */
function offsetMin(d: Date, tz: string): number {
  const p = zonedParts(d, tz);
  return Math.round((Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(d.getTime() / 1000) * 1000) / 60_000);
}
/** The instant when the wall clock in `tz` shows y-m-d hh:mm. */
export function zonedTime(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const o1 = offsetMin(new Date(guess), tz);
  const t = guess - o1 * 60_000;
  const o2 = offsetMin(new Date(t), tz);
  return new Date(o2 === o1 ? t : guess - o2 * 60_000);
}
const pad = (n: number) => String(n).padStart(2, '0');
export function zonedIso(d: Date, tz: string): string {
  const p = zonedParts(d, tz);
  const o = offsetMin(d, tz);
  const sign = o < 0 ? '-' : '+';
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.hh)}:${pad(p.mm)}:${pad(p.ss)}${sign}${pad(Math.floor(Math.abs(o) / 60))}:${pad(Math.abs(o) % 60)}`;
}
export const zonedDate = (d: Date, tz: string) => { const p = zonedParts(d, tz); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; };
const dayLabel = (d: Date, tz: string) => { const p = zonedParts(d, tz); return `${p.wd} ${p.y}-${pad(p.m)}-${pad(p.d)}`; };
const clock = (d: Date, tz: string) => { const p = zonedParts(d, tz); return `${pad(p.hh)}:${pad(p.mm)}`; };

/** node-ical builds date-only values (all-day events) at local midnight of the worker's clock: read them back that way. */
const floatingDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (ymd: string, n: number) => { const [y, m, d] = ymd.split('-').map(Number); const t = new Date(Date.UTC(y!, m! - 1, d! + n)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; };
const midnight = (ymd: string, tz: string) => { const [y, m, d] = ymd.split('-').map(Number); return zonedTime(y!, m!, d!, 0, 0, tz); };

// ---------- range ----------
export const MAX_RANGE_DAYS = 62;
/**
 * `from` / `to`: "YYYY-MM-DD" (a whole day in `tz`; `to` is inclusive) or an ISO date-time (without an offset it is read
 * in `tz`). Defaults: today in `tz`; `to` alone ends that day, `from` alone covers that one day.
 */
export function resolveRange(input: { from?: string | null; to?: string | null }, now: Date, tz: string): { from: Date; to: Date } | string {
  const parse = (v: string, edge: 'start' | 'end'): Date | null => {
    const s = v.trim();
    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (day) {
      const ymd = `${day[1]}-${day[2]}-${day[3]}`;
      const d = midnight(edge === 'end' ? addDays(ymd, 1) : ymd, tz);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(s);
    if (local) return zonedTime(+local[1]!, +local[2]!, +local[3]!, +local[4]!, +local[5]!, tz);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const today = zonedDate(now, tz);
  const from = input.from?.trim() ? parse(input.from, 'start') : midnight(today, tz);
  if (!from) return 'from must be a date (YYYY-MM-DD) or an ISO date-time.';
  let to: Date | null;
  if (input.to?.trim()) to = parse(input.to, 'end');
  else if (input.from?.trim() && /^\d{4}-\d{2}-\d{2}$/.test(input.from.trim())) to = midnight(addDays(input.from.trim(), 1), tz);
  else if (input.from?.trim()) to = new Date(from.getTime() + DAY);
  else to = midnight(addDays(today, 1), tz);
  if (!to) return 'to must be a date (YYYY-MM-DD) or an ISO date-time.';
  if (to.getTime() <= from.getTime()) return '"to" must be after "from".';
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY) return `Ask for at most ${MAX_RANGE_DAYS} days at a time.`;
  return { from, to };
}

// ---------- events ----------
const text = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && 'val' in v) return String((v as { val: unknown }).val ?? '');
  return '';
};
const oneLine = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);

function person(v: unknown): Person | null {
  if (!v) return null;
  const raw = text(v).trim();
  const params = (typeof v === 'object' && v && 'params' in v ? (v as { params?: Record<string, unknown> }).params : undefined) ?? {};
  const email = raw.replace(/^mailto:/i, '').trim();
  const cn = typeof params.CN === 'string' ? params.CN.replace(/^"|"$/g, '').trim() : '';
  const name = cn && cn.toLowerCase() !== email.toLowerCase() ? cn : null;
  const ps = typeof params.PARTSTAT === 'string' ? params.PARTSTAT.toLowerCase() : null;
  return { name: name ? name.slice(0, 80) : null, email: /@/.test(email) ? email.slice(0, 120) : null, response: ps };
}

const MEETING_RE = /https:\/\/(?:meet\.google\.com\/[a-z0-9-]+|(?:[a-z0-9-]+\.)*zoom\.us\/(?:j|my|w|s)\/[^\s<>"')\]]+|teams\.microsoft\.com\/l\/meetup-join\/[^\s<>"')\]]+|teams\.live\.com\/meet\/[^\s<>"')\]]+|(?:[a-z0-9-]+\.)*webex\.com\/(?:meet|join|[a-z0-9-]+\/j\.php)[^\s<>"')\]]*)/i;
/** Google Meet / Zoom / Teams / Webex link from X-GOOGLE-CONFERENCE, the location, the description or the URL. */
export function meetingLinkOf(ev: Record<string, unknown>): string | null {
  for (const k of ['GOOGLE-CONFERENCE', 'X-GOOGLE-CONFERENCE', 'location', 'description', 'url']) {
    const m = MEETING_RE.exec(text(ev[k]));
    if (m) return m[0].replace(/[.,;:]+$/, '');
  }
  return null;
}

function toEvent(inst: { start: Date & { dateOnly?: true }; end: Date & { dateOnly?: true }; isFullDay: boolean; isRecurring: boolean; event: VEvent }, tz: string): CalEvent {
  const ev = inst.event as VEvent & Record<string, unknown>;
  const attendees = (Array.isArray(ev.attendee) ? ev.attendee : ev.attendee ? [ev.attendee] : []).map(person).filter((p): p is Person => !!p && !!(p.name || p.email));
  const common = {
    title: oneLine(text(ev.summary), 200) || '(no title)',
    location: oneLine(text(ev.location), 200) || null,
    meetingLink: meetingLinkOf(ev),
    attendees,
    organizer: person(ev.organizer),
    status: ev.status === 'TENTATIVE' ? 'tentative' as const : 'confirmed' as const,
    recurring: inst.isRecurring || !!ev.recurrenceid,
  };
  if (inst.isFullDay) {
    const s = floatingDate(inst.start);
    let e = inst.end ? floatingDate(inst.end) : addDays(s, 1);
    if (e <= s) e = addDays(s, 1);
    return { ...common, allDay: true, start: s, end: e, startMs: midnight(s, tz).getTime(), endMs: midnight(e, tz).getTime() };
  }
  const startMs = inst.start.getTime();
  const endMs = Math.max(startMs, inst.end?.getTime() ?? startMs);
  return { ...common, allDay: false, start: zonedIso(new Date(startMs), tz), end: zonedIso(new Date(endMs), tz), startMs, endMs };
}

/**
 * Every event instance overlapping [from, to): recurring events expanded (RRULE, EXDATE, RECURRENCE-ID overrides),
 * cancelled events and cancelled instances left out, sorted by start, at most `max`.
 */
export function eventsInWindow(cal: ParsedCalendar, from: Date, to: Date, tz: string, max = 200): { events: CalEvent[]; more: number } {
  const lo = from.getTime();
  const hi = to.getTime();
  // Padded so all-day and multi-day events are found whatever the worker's own clock zone; filtered exactly below.
  const opts = { from: new Date(lo - 2 * DAY), to: new Date(hi + 2 * DAY), expandOngoing: true };
  const out: CalEvent[] = [];
  for (const v of Object.values(cal.data)) {
    const ev = v as VEvent | undefined;
    if (!ev || ev.type !== 'VEVENT' || !ev.start) continue;
    let instances: ReturnType<typeof ical.expandRecurringEvent>;
    try { instances = ical.expandRecurringEvent(ev, opts); } catch { continue; }
    for (const inst of instances) {
      if (inst.event?.status === 'CANCELLED') continue;
      const e = toEvent(inst, tz);
      const overlaps = e.endMs > e.startMs ? e.startMs < hi && e.endMs > lo : e.startMs >= lo && e.startMs < hi;
      if (overlaps) out.push(e);
    }
  }
  const seen = new Set<string>();
  const unique = out.sort((a, b) => a.startMs - b.startMs || a.title.localeCompare(b.title)).filter((e) => {
    const k = `${e.startMs}|${e.endMs}|${e.title}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { events: unique.slice(0, max), more: Math.max(0, unique.length - max) };
}

const who = (p: Person) => (p.name && p.email ? `${p.name} <${p.email}>` : p.name ?? p.email ?? '');

/** One compact line (plus a guest line) per event, times in `tz`. */
export function formatEvents(events: CalEvent[], from: Date, to: Date, tz: string): string {
  const multiDay = zonedDate(from, tz) !== zonedDate(new Date(to.getTime() - 1), tz);
  return events.map((e) => {
    const s = new Date(e.startMs);
    const end = new Date(e.endMs);
    let when: string;
    if (e.allDay) {
      const days = Math.round((e.endMs - e.startMs) / DAY);
      when = `${multiDay ? `${dayLabel(s, tz)} · ` : ''}all day${days > 1 ? ` (${days} days, until ${addDays(e.end, -1)})` : ''}`;
    } else {
      const sameDay = zonedDate(s, tz) === zonedDate(end, tz);
      when = `${multiDay || !sameDay ? `${dayLabel(s, tz)} ` : ''}${clock(s, tz)}–${sameDay ? clock(end, tz) : `${dayLabel(end, tz)} ${clock(end, tz)}`}`;
    }
    const bits = [when, e.title];
    if (e.status === 'tentative') bits.push('tentative');
    if (e.recurring) bits.push('recurring');
    if (e.location) bits.push(`where: ${e.location}`);
    if (e.meetingLink) bits.push(`join: ${e.meetingLink}`);
    if (e.organizer) bits.push(`organizer: ${who(e.organizer)}`);
    let line = `- ${bits.join(' · ')}`;
    if (e.attendees.length) {
      const shown = e.attendees.slice(0, 12).map((p) => `${who(p)}${p.response && p.response !== 'needs-action' ? ` (${p.response})` : ''}`);
      line += `\n  guests: ${shown.join(', ')}${e.attendees.length > 12 ? `, +${e.attendees.length - 12} more` : ''}`;
    }
    return line;
  }).join('\n');
}

// ---------- cache (per connector, 5 min) ----------
export interface IcalCache {
  /** Parsed feed for a connector, fetched at most once per `ttlMs` (concurrent callers share one fetch). */
  get(id: string, url: string): Promise<ParsedCalendar>;
  /** Fetch now (the Test button) and keep the result. */
  refresh(id: string, url: string): Promise<ParsedCalendar>;
  drop(id: string): void;
}
export function createIcalCache(fetchIcs: IcsFetcher, o: { ttlMs?: number; now?: () => number; maxEntries?: number } = {}): IcalCache {
  const ttl = o.ttlMs ?? ICAL_CACHE_MS;
  const now = o.now ?? Date.now;
  const max = o.maxEntries ?? 50;
  const entries = new Map<string, { at: number; value: Promise<ParsedCalendar> }>();
  const load = (id: string, url: string) => {
    const value = fetchIcs(url).then(parseIcs);
    value.catch(() => { if (entries.get(id)?.value === value) entries.delete(id); });
    entries.delete(id);
    entries.set(id, { at: now(), value });
    while (entries.size > max) entries.delete(entries.keys().next().value!);
    return value;
  };
  return {
    get: (id, url) => {
      const hit = entries.get(id);
      return hit && now() - hit.at < ttl ? hit.value : load(id, url);
    },
    refresh: load,
    drop: (id) => { entries.delete(id); },
  };
}

let shared: IcalCache | null = null;
/** One cache for the whole worker process (tools and the Test route share it). */
export const sharedIcalCache = () => (shared ??= createIcalCache(createIcsFetcher()));
