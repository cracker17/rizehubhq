import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueJobs, localParts, parseHhmm, reportKey, scheduleSettings } from './reportsSchedule';

const S = scheduleSettings({ digest_time: '18:00' });
// Manila = UTC+8. 2026-09-28 is a Monday.
const at = (iso: string) => new Date(iso);
const keys = (jobs: { kind: string; date: string }[]) => jobs.map((j) => reportKey(j.kind, j.date));
const have = (...k: string[]) => new Set(k);

test('localParts uses the HQ timezone, not UTC', () => {
  assert.deepEqual(localParts(at('2026-09-27T16:30:00Z'), 'Asia/Manila'), { date: '2026-09-28', minutes: 30, weekday: 1 });
});

test('parseHhmm falls back on bad values; settings default to 18:00 / 08:00', () => {
  assert.equal(parseHhmm('7:05', '18:00'), 425);
  assert.equal(parseHhmm('25:00', '18:00'), 1080);
  assert.equal(parseHhmm(42, '08:00'), 480);
  assert.deepEqual(scheduleSettings({}), { tz: 'Asia/Manila', digestMin: 1080, morningMin: 480, weeklyMin: 480 });
});

test('Monday 08:00 → morning brief + weekly (previous Mon–Sun, by the COO window)', () => {
  const jobs = dueJobs(at('2026-09-28T00:00:00Z'), S, have('daily_digest:2026-09-27'));
  assert.deepEqual(keys(jobs), ['morning_brief:2026-09-28', 'weekly:2026-09-28']);
  assert.deepEqual(jobs[1], { kind: 'weekly', date: '2026-09-28', from: '2026-09-21', days: 7 });
});

test('before 08:00 nothing is due (yesterday already written)', () => {
  assert.deepEqual(dueJobs(at('2026-09-27T23:59:00Z'), S, have('daily_digest:2026-09-27')), []);
});

test('18:00 → digest for today; the morning brief window has closed', () => {
  const now = at('2026-09-28T10:00:00Z');
  assert.deepEqual(keys(dueJobs(now, S, have('daily_digest:2026-09-27', 'weekly:2026-09-28'))), ['daily_digest:2026-09-28']);
  assert.deepEqual(keys(dueJobs(at('2026-09-28T09:59:00Z'), S, have('daily_digest:2026-09-27', 'weekly:2026-09-28', 'morning_brief:2026-09-28'))), []);
});

test('idempotent: nothing is due once the rows exist', () => {
  const all = have('daily_digest:2026-09-27', 'daily_digest:2026-09-28', 'morning_brief:2026-09-28', 'weekly:2026-09-28');
  assert.deepEqual(dueJobs(at('2026-09-28T12:00:00Z'), S, all), []);
});

test('catch-up: worker down from 17:00 to 07:30 next day → yesterday\'s digest is written at 07:30', () => {
  const jobs = dueJobs(at('2026-09-29T23:30:00Z'), S, have('daily_digest:2026-09-28', 'weekly:2026-09-28'));
  assert.deepEqual(keys(jobs), ['daily_digest:2026-09-29']);
  assert.deepEqual(jobs[0], { kind: 'daily_digest', date: '2026-09-29', from: '2026-09-29', days: 1 });
});

test('catch-up: weekly missed on Monday is written on Tuesday for the same week', () => {
  const jobs = dueJobs(at('2026-09-29T02:00:00Z'), S, have('daily_digest:2026-09-28', 'morning_brief:2026-09-29'));
  assert.deepEqual(keys(jobs), ['weekly:2026-09-28']);
});

test('custom digest_time is respected', () => {
  const s = scheduleSettings({ digest_time: '20:30' });
  const base = have('daily_digest:2026-09-27', 'weekly:2026-09-28', 'morning_brief:2026-09-28');
  assert.deepEqual(dueJobs(at('2026-09-28T12:29:00Z'), s, base), []);
  assert.deepEqual(keys(dueJobs(at('2026-09-28T12:30:00Z'), s, base)), ['daily_digest:2026-09-28']);
});
