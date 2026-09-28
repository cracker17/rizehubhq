import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capForDay, FOLLOW_UP_DAYS, inQuietHours, manilaClock, nextFollowUpAt, NO_RESPONSE_DAY } from './schedule';
import { maybeCreateDailyBatch } from './background';
import { draftFirstTouch, fakeDb, seedLead, T0, testConfig } from './testKit';

const DAY = 86_400_000;

test('follow-ups: day 3 / 7 / 14 after the first touch, then close as no-response on day 21', () => {
  const first = new Date('2026-09-01T02:00:00Z');
  assert.deepEqual([...FOLLOW_UP_DAYS], [3, 7, 14]);
  assert.deepEqual(nextFollowUpAt(first, 0), { at: new Date(first.getTime() + 3 * DAY), kind: 'follow_up', number: 1 });
  assert.deepEqual(nextFollowUpAt(first, 1), { at: new Date(first.getTime() + 7 * DAY), kind: 'follow_up', number: 2 });
  assert.deepEqual(nextFollowUpAt(first, 2), { at: new Date(first.getTime() + 14 * DAY), kind: 'follow_up', number: 3 });
  assert.deepEqual(nextFollowUpAt(first, 3), { at: new Date(first.getTime() + NO_RESPONSE_DAY * DAY), kind: 'close_no_response' });
});

test('daily cap: warm-up ramp (+step every 7 days) never above the configured cap; cap 0 = nothing', () => {
  const from = new Date('2026-09-01T00:00:00+08:00');
  const o = { cap: 20, warmupStart: 10, warmupStepPerWeek: 5, warmupFrom: from };
  assert.deepEqual(capForDay(o, new Date('2026-09-01T09:00:00+08:00')), { cap: 10, warmupDay: 1, ramp: 10 });
  assert.equal(capForDay(o, new Date('2026-09-08T09:00:00+08:00')).cap, 15);
  assert.equal(capForDay(o, new Date('2026-09-15T09:00:00+08:00')).cap, 20);
  assert.equal(capForDay(o, new Date('2026-12-01T09:00:00+08:00')).cap, 20, 'capped');
  assert.equal(capForDay({ ...o, warmupFrom: null }, T0).cap, 10, 'not started yet: day 1 of the ramp');
  assert.equal(capForDay({ ...o, cap: 0 }, T0).cap, 0);
});

test('manilaClock: Manila date and hour regardless of the server time zone', () => {
  assert.deepEqual(manilaClock(new Date('2026-09-28T02:00:00Z')), { day: '2026-09-28', hour: 10 });
  assert.deepEqual(manilaClock(new Date('2026-09-28T16:30:00Z')), { day: '2026-09-29', hour: 0 });
  assert.deepEqual(manilaClock(new Date('2026-09-28T15:59:00Z')), { day: '2026-09-28', hour: 23 });
});

test('quiet hours: [start, end) in Manila time, wrapping midnight', () => {
  const at = (h: number) => new Date(Date.UTC(2026, 8, 28, (h - 8 + 24) % 24, 30)); // h:30 Manila
  const night = { start: 22, end: 7 };
  assert.equal(inQuietHours(night, at(23)), true);
  assert.equal(inQuietHours(night, at(3)), true);
  assert.equal(inQuietHours(night, at(7)), false);
  assert.equal(inQuietHours(night, at(21)), false);
  const lunch = { start: 12, end: 13 };
  assert.equal(inQuietHours(lunch, at(12)), true);
  assert.equal(inQuietHours(lunch, at(13)), false);
  assert.equal(inQuietHours(null, at(3)), false);
});

test('daily batch: nothing before OUTREACH_BATCH_HOUR; then ONE approval for all drafts, once per Manila day', async () => {
  const db = fakeDb();
  const a = await seedLead(db); const b = await seedLead(db);
  const e1 = await draftFirstTouch(db, a); const e2 = await draftFirstTouch(db, b);
  const cfg = testConfig({ OUTREACH_BATCH_HOUR: '17' });
  const logs: string[] = [];
  assert.equal(await maybeCreateDailyBatch({ db, cfg }, new Date('2026-09-28T08:59:00Z')), null, '16:59 Manila');
  assert.equal(db.approvals.size, 0);
  const id = await maybeCreateDailyBatch({ db, cfg }, new Date('2026-09-28T09:00:00Z'), (m) => logs.push(m));
  assert.ok(id);
  assert.deepEqual(db.approvals.get(id)!.emailIds.sort(), [e1, e2].sort());
  assert.equal(db.approvals.get(id)!.batchDate, '2026-09-28');
  assert.equal(db.emails.get(e1)!.status, 'pending_approval');
  assert.match(logs[0]!, /daily outreach batch 2026-09-28 is waiting for approval/);
  // a new draft later the same day waits for tomorrow's batch
  await draftFirstTouch(db, await seedLead(db));
  assert.equal(await maybeCreateDailyBatch({ db, cfg }, new Date('2026-09-28T12:00:00Z')), null);
  assert.ok(await maybeCreateDailyBatch({ db, cfg }, new Date('2026-09-29T09:30:00Z')), 'next Manila day');
});
