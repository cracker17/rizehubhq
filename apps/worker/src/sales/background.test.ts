import { test } from 'node:test';
import assert from 'node:assert/strict';
import { salesJobs, startSalesBackground, stopSalesBackground } from './background';
import type { SalesRuntime } from './runtime';
import type { InboxSource } from './inbox';
import { fakeDb, recordingMailer, testConfig } from './testKit';
import { makeDeps, mockModel } from '../testing';

const noInbox: InboxSource = { fetchNew: async (s) => ({ messages: [], state: s }) };
const tick = () => new Promise((r) => setImmediate(r));
const SLOW = { batchEveryMs: 3_600_000, followUpsEveryMs: 3_600_000, statusEveryMs: 3_600_000 };

test('salesJobs: off unless OUTREACH_ENABLED; without sending keys only status (+ inbox if IMAP is set)', () => {
  assert.deepEqual(salesJobs(testConfig({ OUTREACH_ENABLED: 'false' }), true, true), []);
  assert.deepEqual(salesJobs(testConfig({ OUTREACH_SMTP_HOST: '' }), false, false), ['status']);
  assert.deepEqual(salesJobs(testConfig({ OUTREACH_PHYSICAL_ADDRESS: '' }), true, true), ['status', 'inbox']);
  assert.deepEqual(salesJobs(testConfig(), false, false), ['status'], 'config ok but no transport');
  assert.deepEqual(salesJobs(testConfig(), true, false), ['status', 'send', 'batch', 'follow_ups']);
  assert.deepEqual(salesJobs(testConfig(), true, true), ['status', 'inbox', 'send', 'batch', 'follow_ups']);
});

test('startSalesBackground: disabled → no timers, the runtime (Supabase / SMTP / IMAP) is never even built', () => {
  const deps = makeDeps({ model: mockModel([]) });
  const timers = startSalesBackground(deps, { cfg: testConfig({ OUTREACH_ENABLED: '' }) });
  assert.deepEqual(timers, []);
  assert.match(deps.logs.join(), /outreach background off/);
});

test('startSalesBackground: enabled without mail keys → only the status row (sending OFF + why); timers are cleaned up', async () => {
  const db = fakeDb();
  const cfg = testConfig({ OUTREACH_SMTP_HOST: '', OUTREACH_SMTP_USER: '', OUTREACH_SMTP_PASS: '' });
  const rt: SalesRuntime = { db, mailer: null, inbox: null, cfg };
  const deps = makeDeps({ model: mockModel([]) });
  const timers = startSalesBackground(deps, { runtime: rt, ...SLOW });
  try {
    assert.equal(timers.length, 1);
    await tick();
    const status = db.settings.get('outreach_status') as { sending_enabled: boolean; problems: string[]; cap_today: number };
    assert.equal(status.sending_enabled, false);
    assert.match(status.problems.join(), /OUTREACH_SMTP_HOST/);
    assert.match(deps.logs.join('\n'), /outreach sending is OFF/);
    assert.equal(db.approvals.size, 0);
  } finally { stopSalesBackground(timers); }
  assert.equal(timers.length, 0);
});

test('startSalesBackground: fully configured → send, inbox, batch, follow-ups and status jobs; stop clears them all', async () => {
  const db = fakeDb();
  const rt: SalesRuntime = { db, mailer: recordingMailer(), inbox: noInbox, cfg: testConfig() };
  const deps = makeDeps({ model: mockModel([]) });
  const timers = startSalesBackground(deps, { runtime: rt, ...SLOW });
  try {
    assert.equal(timers.length, 5);
    await tick();
    assert.equal((db.settings.get('outreach_status') as { sending_enabled: boolean }).sending_enabled, true);
    assert.ok(db.settings.get('sales_imap'), 'inbox polled right away');
    assert.match(deps.logs.join('\n'), /outreach from julev@getrizehub\.test · cap 20\/day/);
  } finally { stopSalesBackground(timers); }
  stopSalesBackground(timers); // idempotent
});
