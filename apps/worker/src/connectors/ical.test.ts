import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { loadKeyring, open, seal } from '../vault/crypto';
import { connectorContext, type ConnectorFull, type ConnectorStore, type NewConnector } from './store';
import {
  checkIcalUrl, createIcalCache, createIcsFetcher, eventsInWindow, formatEvents, IcalError, meetingLinkOf, parseIcs,
  resolveRange, zonedTime, type IcsFetcher,
} from './ical';
import { createCalendarTools, NO_CALENDAR } from '../tools/calendar';
import { createConnectorRoutes } from '../routes/connectors';
import type { NetEnv } from '../research/net';

const here = path.dirname(fileURLToPath(import.meta.url));
const ICS = fs.readFileSync(path.join(here, 'fixtures', 'google-calendar.ics'), 'utf8');
const SECRET = 'https://calendar.google.com/calendar/ical/ceo%40gmail.com/private-0123456789abcdef0123456789abcdef/basic.ics';
const TZ = 'Asia/Manila';
const OLD = '0c0c0c0c-0000-4000-8000-000000000009';
const kr = loadKeyring({ VAULT_MASTER_KEY: randomBytes(32).toString('base64') })!;

/** A Manila wall-clock day as a window. */
const manilaDay = (ymd: string) => {
  const r = resolveRange({ from: ymd }, new Date(), TZ);
  assert.notEqual(typeof r, 'string');
  return r as { from: Date; to: Date };
};

test('ical address: https secret address only; webcal becomes https; public/embed links and logins refused', () => {
  assert.equal(checkIcalUrl(SECRET), SECRET);
  assert.equal(checkIcalUrl(SECRET.replace('https://', 'webcal://')), SECRET);
  assert.match((checkIcalUrl(SECRET.replace('https://', 'http://')) as { error: string }).error, /https address/);
  assert.match((checkIcalUrl('https://calendar.google.com/calendar/embed?src=ceo%40gmail.com') as { error: string }).error, /\.ics/);
  assert.match((checkIcalUrl('https://calendar.google.com/calendar/ical/ceo%40gmail.com/public/basic.ics') as { error: string }).error, /public address/);
  assert.match((checkIcalUrl('https://user:pw@example.com/cal.ics') as { error: string }).error, /login/);
  assert.match((checkIcalUrl('https://localhost/cal.ics') as { error: string }).error, /public calendar address/);
  assert.match((checkIcalUrl('https://127.0.0.1/cal.ics') as { error: string }).error, /public calendar address/);
  for (const bad of ['', 'not a url', 'https://metadata.google.internal/x.ics']) {
    const r = checkIcalUrl(bad);
    assert.equal(typeof r, 'object', bad);
  }
});

test('ical parser: a Manila day shows the moved recurring instance, the all-day event and other-zone events; cancelled ones are gone', () => {
  const cal = parseIcs(ICS);
  assert.equal(cal.name, 'RizeHub CEO');
  assert.equal(cal.timezone, 'Asia/Manila');
  const { from, to } = manilaDay('2026-09-28');
  const { events, more } = eventsInWindow(cal, from, to, TZ);
  assert.equal(more, 0);
  assert.deepEqual(events.map((e) => [e.start, e.end, e.title]), [
    ['2026-09-28', '2026-09-29', 'Office closed (holiday)'],
    ['2026-09-28T10:30:00+08:00', '2026-09-28T11:00:00+08:00', 'Team standup (moved)'], // RECURRENCE-ID override
    ['2026-09-28T13:00:00+08:00', '2026-09-28T13:30:00+08:00', 'Lunch with designer'], // UTC in the feed
    ['2026-09-28T20:00:00+08:00', '2026-09-28T21:00:00+08:00', 'Client discovery call (New York)'], // 08:00 EDT
  ]);
  assert.ok(!events.some((e) => /Cancelled lunch/.test(e.title)), 'a cancelled event is left out');
  const [holiday, standup, lunch, client] = events;
  assert.equal(holiday!.allDay, true);
  assert.equal(standup!.recurring, true);
  assert.equal(standup!.meetingLink, 'https://meet.google.com/abc-defg-hij');
  assert.deepEqual(standup!.organizer, { name: 'Julev Ajeto', email: 'ceo@example.com', response: null });
  assert.equal(lunch!.location, 'Cafe, BGC Taguig');
  assert.equal(client!.meetingLink, 'https://us02web.zoom.us/j/81234567890?pwd=abc123');
  assert.deepEqual(client!.attendees.map((a) => [a.name, a.email, a.response]), [['Alex Client', 'alex@client.example', 'accepted'], [null, 'ceo@example.com', 'tentative']]);

  const text = formatEvents(events, from, to, TZ);
  assert.match(text, /^- all day · Office closed \(holiday\)$/m);
  assert.match(text, /^- 10:30–11:00 · Team standup \(moved\) · recurring · join: https:\/\/meet\.google\.com\/abc-defg-hij · organizer: Julev Ajeto <ceo@example\.com>$/m);
  assert.match(text, /guests: Julev Ajeto <ceo@example\.com> \(accepted\), Maria Santos <maria@example\.com>/);
});

test('ical parser: weekly RRULE expands across weeks, skipping the EXDATE and the cancelled instance', () => {
  const cal = parseIcs(ICS);
  const r = resolveRange({ from: '2026-09-07', to: '2026-10-12' }, new Date(), TZ) as { from: Date; to: Date };
  const standups = eventsInWindow(cal, r.from, r.to, TZ).events.filter((e) => e.title.startsWith('Team standup'));
  assert.deepEqual(standups.map((e) => e.start), [
    '2026-09-07T09:00:00+08:00', '2026-09-14T09:00:00+08:00', // 21 Sep is an EXDATE
    '2026-09-28T10:30:00+08:00', // moved
    '2026-10-12T09:00:00+08:00', // 5 Oct was cancelled
  ]);
  const text = formatEvents(standups, r.from, r.to, TZ);
  assert.match(text, /^- Mon 2026-09-07 09:00–09:30 · Team standup/m);
});

test('ical parser: all-day dates do not shift with the worker\'s own clock zone', () => {
  const saved = process.env.TZ;
  try {
    for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Manila', 'Pacific/Kiritimati']) {
      process.env.TZ = zone;
      const cal = parseIcs(ICS);
      const on = (ymd: string) => { const { from, to } = manilaDay(ymd); return eventsInWindow(cal, from, to, TZ).events.filter((e) => e.allDay).map((e) => e.start); };
      assert.deepEqual(on('2026-09-28'), ['2026-09-28'], zone);
      assert.deepEqual(on('2026-09-27'), [], zone);
      assert.deepEqual(on('2026-09-29'), [], zone);
    }
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
});

test('ical parser: refuses things that are not a calendar; meeting links from description, location or the Google field', () => {
  assert.throws(() => parseIcs('<html>Sign in</html>'), (e: unknown) => e instanceof IcalError && /VCALENDAR/.test(e.message));
  assert.equal(parseIcs('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n').eventCount, 0);
  assert.equal(meetingLinkOf({ location: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0?context=y' }), 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0?context=y');
  assert.equal(meetingLinkOf({ description: 'Join: https://meet.google.com/xyz-abcd-efg.' }), 'https://meet.google.com/xyz-abcd-efg');
  assert.equal(meetingLinkOf({ 'GOOGLE-CONFERENCE': 'https://meet.google.com/aaa-bbbb-ccc', description: 'https://zoom.us/j/1' }), 'https://meet.google.com/aaa-bbbb-ccc');
  assert.equal(meetingLinkOf({ description: 'https://example.com/zoom.us/j/1 no' }), null);
});

test('ical range: default = today in Manila; whole days; limits', () => {
  const now = new Date('2026-09-28T20:00:00Z'); // 04:00 on 29 Sep in Manila
  const today = resolveRange({}, now, TZ) as { from: Date; to: Date };
  assert.deepEqual([today.from.toISOString(), today.to.toISOString()], ['2026-09-28T16:00:00.000Z', '2026-09-29T16:00:00.000Z']);
  const week = resolveRange({ from: '2026-09-28', to: '2026-10-04' }, now, TZ) as { from: Date; to: Date };
  assert.equal(week.to.toISOString(), '2026-10-04T16:00:00.000Z', 'to is inclusive');
  const local = resolveRange({ from: '2026-09-29T13:00', to: '2026-09-29T15:00:00+08:00' }, now, TZ) as { from: Date; to: Date };
  assert.deepEqual([local.from.toISOString(), local.to.toISOString()], ['2026-09-29T05:00:00.000Z', '2026-09-29T07:00:00.000Z']);
  assert.match(resolveRange({ from: 'tomorrow' }, now, TZ) as string, /from must be/);
  assert.match(resolveRange({ from: '2026-09-29', to: '2026-09-28' }, now, TZ) as string, /after/);
  assert.match(resolveRange({ from: '2026-01-01', to: '2026-12-31' }, now, TZ) as string, /62 days/);
  assert.equal(zonedTime(2026, 3, 8, 12, 0, 'America/New_York').toISOString(), '2026-03-08T16:00:00.000Z', 'DST-aware');
});

// ---------- fetching ----------
function fakeNet(respond: (url: string) => Response | Promise<Response>, addr = '142.250.1.1'): NetEnv & { hits: string[] } {
  const hits: string[] = [];
  return {
    hits, allowPrivateHosts: [],
    lookup: async () => [{ address: addr, family: 4 }],
    transport: async (url, init) => { hits.push(url); if (init.signal.aborted) throw new Error('aborted'); return respond(url); },
  };
}

test('ical fetch: reads the feed; 404 = the address was reset (reauth); errors never contain the secret address', async () => {
  const ok = fakeNet(() => new Response(ICS, { status: 200, headers: { 'content-type': 'text/calendar' } }));
  assert.match(await createIcsFetcher(ok)(SECRET), /BEGIN:VCALENDAR/);
  assert.deepEqual(ok.hits, [SECRET]);

  const cases: [NetEnv, RegExp, boolean][] = [
    [fakeNet(() => new Response('Not Found', { status: 404 })), /no longer accepts this secret address/, true],
    [fakeNet(() => new Response('oops', { status: 500 })), /HTTP 500/, false],
    [fakeNet(() => new Response(ICS), '10.0.0.5'), /private or blocked host/, false],
    [fakeNet(() => { throw new Error(`connect ECONNREFUSED for ${SECRET}`); }), /Could not reach the calendar/, false],
    [fakeNet((u) => (u.startsWith('http:') ? new Response(ICS) : new Response(null, { status: 302, headers: { location: 'http://calendar.google.com/x.ics' } }))), /non-https/, false],
    [fakeNet(() => new Response('x'.repeat(5 * 1024 * 1024 + 10))), /larger than 5 MB/, false],
  ];
  for (const [net, re, reauth] of cases) {
    const err = await createIcsFetcher(net)(SECRET).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof IcalError, String(err));
    assert.match(err.message, re);
    assert.equal(err.reauth, reauth, err.message);
    assert.ok(!err.message.includes('private-0123456789abcdef'), 'secret never in the message');
  }
});

test('ical cache: one fetch per connector per 5 minutes; refresh forces; failures are not cached', async () => {
  let clock = 0;
  let calls = 0;
  let fail = false;
  const f: IcsFetcher = async () => { calls++; if (fail) throw new IcalError('down'); return ICS; };
  const cache = createIcalCache(f, { now: () => clock });
  await Promise.all([cache.get('a', SECRET), cache.get('a', SECRET)]);
  assert.equal(calls, 1);
  clock = 4 * 60_000; await cache.get('a', SECRET); assert.equal(calls, 1);
  clock = 6 * 60_000; await cache.get('a', SECRET); assert.equal(calls, 2);
  await cache.refresh('a', SECRET); assert.equal(calls, 3);
  await cache.get('b', SECRET); assert.equal(calls, 4, 'per connector');
  fail = true;
  await assert.rejects(cache.refresh('c', SECRET), /down/);
  fail = false;
  await cache.get('c', SECRET); assert.equal(calls, 6, 'a failure is fetched again next time');
});

// ---------- the tool ----------
function fakeStore(rows: ConnectorFull[] = [], grants: Record<string, string[]> = {}) {
  const marks: { id: string; status: string; error: string | null; used: boolean }[] = [];
  const inserted: NewConnector[] = [];
  const store: ConnectorStore = {
    forAgent: async (agent, kind) => rows.filter((r) => r.kind === kind && r.status === 'active' && (grants[r.id] ?? []).includes(agent)),
    get: async (id) => rows.find((r) => r.id === id) ?? null,
    insert: async (c) => {
      inserted.push(c);
      rows.push({ id: c.id, kind: c.kind, status: 'active', name: c.name, account_email: c.accountEmail, url: c.url, auth_type: c.authType, settings: c.settings, sealed: c.sealed });
      grants[c.id] = c.grants;
      return c.id;
    },
    rotate: async () => undefined,
    mark: async (id, status, error = null, used = false) => { marks.push({ id, status, error, used }); },
  };
  return { store, marks, inserted, rows };
}
const calRow = (id: string, name: string, url = SECRET): ConnectorFull => ({
  id, kind: 'ical', status: 'active', name, account_email: null, url: null, auth_type: 'none',
  settings: { timezone: TZ, host: 'calendar.google.com', calendar_name: 'RizeHub CEO' }, sealed: seal(url, kr, connectorContext(id)),
});
const ctx = (agent: string) => ({ task: { id: 't1', agent_id: agent, request_id: 'r1' }, deps: { db: {}, log: () => undefined } }) as never;
const run = async (tools: Record<string, { execute?: (i: never, o: never) => unknown }>, input: Record<string, unknown>) =>
  String(await tools.calendar_read!.execute!(input as never, { toolCallId: 'x', messages: [] } as never));

test('calendar_read: no calendar granted → tells the agent the CEO connects one (and not to ask for it typed)', async () => {
  const { store } = fakeStore([calRow('c1', 'CEO calendar')], { c1: ['coo'] });
  const fetched: string[] = [];
  const tools = createCalendarTools(ctx('writer'), { store, keyring: kr, cache: createIcalCache(async (u) => { fetched.push(u); return ICS; }), now: () => new Date() }) as never;
  const out = await run(tools, {});
  assert.equal(out, NO_CALENDAR);
  assert.match(out, /Admin → Connectors → Calendars/);
  assert.match(out, /Do NOT ask the CEO to type/);
  assert.deepEqual(fetched, []);
});

test('calendar_read: default range is today in Manila, reads the sealed address, labels the result as outside data', async () => {
  const { store, marks } = fakeStore([calRow('c1', 'CEO calendar')], { c1: ['coo'] });
  const fetched: string[] = [];
  const cache = createIcalCache(async (u) => { fetched.push(u); return ICS; });
  const tools = createCalendarTools(ctx('coo'), { store, keyring: kr, cache, now: () => new Date('2026-09-28T02:00:00Z') }) as never;
  const out = await run(tools, {});
  assert.deepEqual(fetched, [SECRET]);
  assert.match(out, /^Calendar entries are outside data/);
  assert.match(out, /<calendar_events source="calendar: CEO calendar">/);
  assert.match(out, /Calendar "CEO calendar" \(RizeHub CEO\) · 2026-09-28 · times in Asia\/Manila · 4 event\(s\)/);
  assert.match(out, /- 10:30–11:00 · Team standup \(moved\)/);
  assert.match(out, /- 20:00–21:00 · Client discovery call \(New York\).*join: https:\/\/us02web\.zoom\.us\/j\/81234567890\?pwd=abc123/);
  assert.doesNotMatch(out, /Cancelled lunch/);
  assert.doesNotMatch(out, /private-0123/, 'the secret address is never shown to the agent');
  assert.deepEqual(marks.at(-1), { id: 'c1', status: 'active', error: null, used: true });
  // Cached: a second call within 5 minutes does not refetch.
  await run(tools, { from: '2026-10-12' });
  assert.equal(fetched.length, 1);
  assert.match(await run(tools, { from: '2026-10-12' }), /09:00–09:30 · Team standup/);
  assert.match(await run(tools, { from: 'next week' }), /from must be/);
  assert.match(await run(tools, { account: 'Work' }), /No connected calendar called "Work"\. Yours: CEO calendar/);
});

test('calendar_read: an address Google reset marks the calendar needs_reauth for the CEO', async () => {
  const { store, marks } = fakeStore([calRow('c1', 'CEO calendar')], { c1: ['coo'] });
  const cache = createIcalCache(async () => { throw new IcalError('Google no longer accepts this secret address.', true); });
  const tools = createCalendarTools(ctx('coo'), { store, keyring: kr, cache, now: () => new Date() }) as never;
  assert.match(await run(tools, {}), /CEO calendar: Google no longer accepts this secret address/);
  assert.equal(marks.at(-1)!.status, 'needs_reauth');
});

// ---------- the route ----------
test('/connectors/ical/add: validates before fetching, test-reads the feed, seals the address (url column stays null)', async () => {
  const s = fakeStore();
  const fetched: string[] = [];
  let feed = ICS;
  const routes = createConnectorRoutes({
    store: () => s.store, keyring: () => kr,
    ical: (() => { const c = createIcalCache(async (u) => { fetched.push(u); return feed; }); return () => c; })(),
  });
  const call = (p: string, body: unknown) => routes.find((r) => r.path === p)!.handle({} as never, Buffer.from(JSON.stringify(body)));

  assert.equal((await call('/connectors/ical/add', {}))[0], 400);
  assert.match(JSON.stringify((await call('/connectors/ical/add', { url: SECRET.replace('https', 'http') }))[1]), /https address/);
  assert.match(JSON.stringify((await call('/connectors/ical/add', { url: 'https://calendar.google.com/calendar/u/0/r' }))[1]), /\.ics/);
  assert.deepEqual(fetched, [], 'nothing is fetched before the address looks right');

  feed = '<html>Sign in</html>';
  const [st, body] = await call('/connectors/ical/add', { url: SECRET });
  assert.equal(st, 400);
  assert.match(JSON.stringify(body), /did not return a calendar/);
  assert.equal(s.inserted.length, 0);

  feed = ICS;
  const [status, res] = await call('/connectors/ical/add', { url: SECRET.replace('https://', 'webcal://') });
  assert.equal(status, 200);
  assert.doesNotMatch(JSON.stringify(res), /private-0123/, 'the answer never repeats the address');
  const c = s.inserted[0]!;
  assert.equal(c.id, (res as { id: string }).id);
  assert.deepEqual([c.kind, c.name, c.url, c.accountEmail, c.authType, c.catalogKey, c.grants], ['ical', 'RizeHub CEO', null, null, 'none', 'google_calendar', ['coo']]);
  assert.deepEqual(c.settings, { timezone: 'Asia/Manila', host: 'calendar.google.com', calendar_name: 'RizeHub CEO' });
  assert.equal(open(c.sealed, kr, connectorContext(c.id)), SECRET);
  assert.throws(() => open(c.sealed, kr, 'connector:other'), 'bound to its own id');

  // Test button: re-fetches (not the cache) and reports the feed.
  const before = fetched.length;
  assert.deepEqual(await call('/connectors/test', { id: c.id }), [200, { ok: true, message: 'Read the calendar "RizeHub CEO": 5 event(s) in the feed.' }]);
  assert.equal(fetched.length, before + 1);
  assert.equal(s.marks.at(-1)!.status, 'active');

  const s2 = fakeStore([calRow(OLD, 'Old')]);
  const gone = createConnectorRoutes({
    store: () => s2.store, keyring: () => kr,
    ical: () => createIcalCache(async () => { throw new IcalError('Google no longer accepts this secret address.', true); }),
  });
  const [, t] = await gone.find((r) => r.path === '/connectors/test')!.handle({} as never, Buffer.from(JSON.stringify({ id: OLD })));
  assert.deepEqual(t, { ok: false, error: 'Google no longer accepts this secret address.' });
  assert.equal(s2.marks.at(-1)!.status, 'needs_reauth');
});

test('/connectors/ical/add: needs the vault key; custom name, agents and a valid time zone are kept', async () => {
  const s = fakeStore();
  const routes = createConnectorRoutes({ store: () => s.store, keyring: () => null, ical: () => createIcalCache(async () => ICS) });
  const call = (body: unknown) => routes.find((r) => r.path === '/connectors/ical/add')!.handle({} as never, Buffer.from(JSON.stringify(body)));
  assert.equal((await call({ url: SECRET }))[0], 503);
  const ok = createConnectorRoutes({ store: () => s.store, keyring: () => kr, ical: () => createIcalCache(async () => ICS) });
  const [st] = await ok.find((r) => r.path === '/connectors/ical/add')!.handle({} as never, Buffer.from(JSON.stringify({ url: SECRET, name: 'Meetings', agents: ['coo', 'sales'], timezone: 'Not/AZone' })));
  assert.equal(st, 200);
  assert.deepEqual([s.inserted[0]!.name, s.inserted[0]!.grants, s.inserted[0]!.settings.timezone], ['Meetings', ['coo', 'sales'], 'Asia/Manila']);
});
