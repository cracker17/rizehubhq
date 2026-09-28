import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_QUIET, inQuietHours, isUrgentApproval, parseQuietHours, shouldSendApproval } from './quiet';
import { PendingNotes } from './pending';
import { summarizeSpend } from './budget';

// Manila = UTC+8
const manila = (hhmm: string) => new Date(`2026-09-28T${hhmm}:00+08:00`);

test('default quiet hours 22:00–07:00 wrap past midnight', () => {
  const q = parseQuietHours(undefined);
  assert.deepEqual(q, DEFAULT_QUIET);
  assert.equal(inQuietHours(manila('21:59'), q), false);
  assert.equal(inQuietHours(manila('22:00'), q), true);
  assert.equal(inQuietHours(manila('03:00'), q), true);
  assert.equal(inQuietHours(manila('06:59'), q), true);
  assert.equal(inQuietHours(manila('07:00'), q), false);
  assert.equal(inQuietHours(manila('18:00'), q), false);
});

test('custom and disabled quiet hours', () => {
  const q = parseQuietHours({ start: '12:00', end: '13:30' });
  assert.equal(inQuietHours(manila('12:45'), q), true);
  assert.equal(inQuietHours(manila('13:30'), q), false);
  assert.equal(inQuietHours(manila('23:00'), parseQuietHours(false)), false);
  assert.equal(inQuietHours(manila('23:00'), parseQuietHours({ start: '22:00', end: '07:00', enabled: false })), false);
  assert.equal(parseQuietHours({ start: 'late', end: '07:00' }), DEFAULT_QUIET);
});

test('quiet hours use the HQ timezone, not the server clock', () => {
  const q = parseQuietHours(undefined);
  const utc2300 = new Date('2026-09-28T23:00:00Z'); // 07:00 in Manila
  assert.equal(inQuietHours(utc2300, q, 'Asia/Manila'), false);
  assert.equal(inQuietHours(utc2300, q, 'UTC'), true);
});

test('only urgent requests and task failures break quiet hours', () => {
  const urgent = { payload: { type: 'question' }, requests: { priority: 'urgent', title: null, due_date: null } };
  const failed = { payload: { type: 'task_failed' }, requests: { priority: 'normal', title: null, due_date: null } };
  const normal = { payload: {}, requests: { priority: 'high', title: null, due_date: null } };
  const escalation = { payload: { type: 'qa_escalation' }, requests: null };
  assert.ok(isUrgentApproval(urgent) && isUrgentApproval(failed));
  assert.ok(!isUrgentApproval(normal) && !isUrgentApproval(escalation));
  assert.equal(shouldSendApproval(normal, true), false);
  assert.equal(shouldSendApproval(normal, false), true);
  assert.equal(shouldSendApproval(failed, true), true);
});

test('pending change note: one per chat, consumed once, expires after 10 minutes', () => {
  const p = new PendingNotes();
  p.set(1, 'ap-1', 100, 0);
  p.set(2, 'ap-2', 200, 0);
  assert.equal(p.peek(1, 60_000)?.approvalId, 'ap-1');
  assert.deepEqual(p.take(1, 9 * 60_000), { approvalId: 'ap-1', messageId: 100, at: 0, decision: 'changes' });
  assert.equal(p.take(1, 9 * 60_000), null);
  assert.equal(p.take(2, 10 * 60_000 + 1), null); // expired
  assert.equal(p.size, 0);
  p.set(3, 'ap-3', 300, 0);
  p.set(3, 'ap-4', 301, 1000); // a newer tap replaces the older one
  assert.equal(p.take(3, 2000)?.approvalId, 'ap-4');
  p.set(4, 'ap-5', 400, 0);
  assert.equal(p.clear(4), true);
  assert.equal(p.clear(4), false);
});

test('spend: today and month-to-date in Manila, top spenders today', () => {
  const now = new Date('2026-09-28T10:00:00+08:00');
  const s = summarizeSpend([
    { actor: 'seo-1', cost_usd: '0.40', created_at: '2026-09-28T01:00:00+08:00' },
    { actor: 'coo', cost_usd: 0.1, created_at: '2026-09-28T00:10:00+08:00' },
    { actor: 'seo-1', cost_usd: 0.2, created_at: '2026-09-27T23:50:00+08:00' },   // yesterday (still this month)
    { actor: 'qa-lead', cost_usd: 5, created_at: '2026-08-31T23:00:00+08:00' },  // last month
    { actor: 'x', cost_usd: 0, created_at: '2026-09-28T01:00:00+08:00' },
  ], now);
  assert.equal(s.today.toFixed(2), '0.50');
  assert.equal(s.month.toFixed(2), '0.70');
  assert.deepEqual(s.topToday.map((t) => t.actor), ['seo-1', 'coo']);
});
