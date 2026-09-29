// The sender: nothing leaves without an APPROVED external_action; daily cap + warm-up, quiet hours, CAN-SPAM refusal,
// suppression and SMTP failures. FakeSalesDb mirrors the SQL claim rules (sales_claim_send); fake mailer, no sockets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSendTick } from './sender';
import { draftFirstTouch, fakeDb, recordingMailer, seedLead, T0, testConfig } from './testKit';

const DAY = 86_400_000;

test('never sends a draft or an email still waiting for the CEO (no approved external_action)', async () => {
  const db = fakeDb();
  const e = await draftFirstTouch(db, await seedLead(db));
  const mailer = recordingMailer();
  const cfg = testConfig();
  assert.equal((await runSendTick({ db, mailer, cfg, now: T0 })).status, 'idle', 'draft');
  const batch = (await db.createDailyBatch('2026-09-28', false))!;
  assert.equal(db.emails.get(e)!.status, 'pending_approval');
  assert.equal((await runSendTick({ db, mailer, cfg, now: T0 })).status, 'idle', 'pending approval');
  db.decide(batch, 'reject');
  assert.equal((await runSendTick({ db, mailer, cfg, now: T0 })).status, 'idle', 'rejected');
  assert.equal(mailer.sent.length, 0);
  assert.equal(db.emails.get(e)!.send_attempts, 0, 'never even claimed');
});

test('approved → sent once, with footer; lead contacted with the day-3 follow-up scheduled', async () => {
  const db = fakeDb();
  const lead = await seedLead(db);
  const e = await draftFirstTouch(db, lead);
  db.decide((await db.createDailyBatch(null, false))!, 'approve');
  const mailer = recordingMailer();
  const logs: string[] = [];
  const r = await runSendTick({ db, mailer, cfg: testConfig(), now: T0, log: (m) => logs.push(m) });
  assert.deepEqual({ status: r.status, sent: r.sent, sentToday: r.sentToday, cap: r.cap }, { status: 'sent', sent: 1, sentToday: 1, cap: 10 });
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0]!.to, db.leads.get(lead)!.email);
  assert.match(mailer.sent[0]!.text, /123 Example Street/);
  assert.match(mailer.sent[0]!.text, /Reply "unsubscribe"/);
  assert.equal(db.emails.get(e)!.status, 'sent');
  const l = db.leads.get(lead)!;
  assert.equal(l.stage, 'contacted');
  assert.equal(Date.parse(l.next_follow_up_at!), T0.getTime() + 3 * DAY);
  assert.match(logs[0]!, /sent first_touch to Biz \d+ \(1\/10 today\)/);
  // idempotent: the next tick has nothing to do
  assert.equal((await runSendTick({ db, mailer, cfg: testConfig(), now: T0 })).status, 'idle');
  assert.equal(mailer.sent.length, 1);
});

test('flagged emails (prices / dates) are held by "approve all" and only go out after an explicit per-email OK', async () => {
  const db = fakeDb();
  const flagged = await draftFirstTouch(db, await seedLead(db), 'We fix this for $300 and can deliver by Friday.');
  const clean = await draftFirstTouch(db, await seedLead(db));
  const batch = (await db.createDailyBatch(null, false))!;
  db.decide(batch, 'approve');
  const mailer = recordingMailer();
  await runSendTick({ db, mailer, cfg: testConfig(), now: T0 });
  assert.deepEqual(mailer.sent.map((m) => m.messageId.split('.')[0]), [`<${clean}`]);
  assert.equal(db.emails.get(flagged)!.status, 'draft');
  assert.match(db.emails.get(flagged)!.ceo_note ?? '', /explicit per-email approval/);
  const ap = await db.requestEmailApproval(flagged);
  assert.equal(ap.auto_approved, false, 'auto-approve never covers a flagged email or a first touch');
  db.decide(ap.approval_id, 'approve');
  await runSendTick({ db, mailer, cfg: testConfig(), now: T0 });
  assert.equal(mailer.sent.length, 2);
});

test('daily cap: warm-up ramp limits today\'s sends; the rest wait for tomorrow', async () => {
  let now = T0;
  const db = fakeDb(() => now);
  for (let i = 0; i < 4; i++) await draftFirstTouch(db, await seedLead(db));
  db.decide((await db.createDailyBatch(null, false))!, 'approve');
  const cfg = testConfig({ OUTREACH_WARMUP_START_PER_DAY: '2', OUTREACH_WARMUP_STEP_PER_WEEK: '1' });
  const mailer = recordingMailer();
  const r1 = await runSendTick({ db, mailer, cfg, now });
  assert.deepEqual({ sent: r1.sent, cap: r1.cap, status: r1.status }, { sent: 2, cap: 2, status: 'sent' });
  const r2 = await runSendTick({ db, mailer, cfg, now });
  assert.deepEqual({ sent: r2.sent, status: r2.status, sentToday: r2.sentToday }, { sent: 0, status: 'cap_reached', sentToday: 2 });
  now = new Date(T0.getTime() + DAY); // next Manila day, warm-up day 2 (still 2/day)
  const r3 = await runSendTick({ db, mailer, cfg, now });
  assert.equal(r3.sent, 2);
  assert.equal(r3.warmupDay, 2);
  assert.equal(mailer.sent.length, 4);
});

test('the configured cap is clamped (never above 30 without OUTREACH_ALLOW_HIGHER_CAP) and SQL stops at 50', async () => {
  const db = fakeDb();
  const cfg = testConfig({ OUTREACH_DAILY_SEND_CAP: '500', OUTREACH_WARMUP_START_PER_DAY: '500' });
  assert.equal((await runSendTick({ db, mailer: recordingMailer(), cfg, now: T0 })).cap, 30);
  assert.equal((await db.claimSend(500)).cap, 50);
});

test('quiet hours: nothing is claimed or sent inside the window; sending resumes after it', async () => {
  const db = fakeDb();
  const e = await draftFirstTouch(db, await seedLead(db));
  db.decide((await db.createDailyBatch(null, false))!, 'approve');
  const cfg = testConfig({ OUTREACH_QUIET_HOURS: '22-7' });
  const mailer = recordingMailer();
  const night = new Date('2026-09-28T15:00:00Z'); // 23:00 Manila
  assert.equal((await runSendTick({ db, mailer, cfg, now: night })).status, 'quiet_hours');
  assert.equal(db.emails.get(e)!.send_attempts, 0);
  assert.equal(mailer.sent.length, 0);
  assert.equal((await runSendTick({ db, mailer, cfg, now: new Date('2026-09-28T23:00:00Z') })).status, 'sent', '07:00 Manila');
});

test('fail safe: no SMTP transport or a CAN-SPAM problem → disabled before anything is claimed', async () => {
  const db = fakeDb();
  const e = await draftFirstTouch(db, await seedLead(db));
  db.decide((await db.createDailyBatch(null, false))!, 'approve');
  const noMailer = await runSendTick({ db, mailer: null, cfg: testConfig(), now: T0 });
  assert.deepEqual({ status: noMailer.status, problems: noMailer.problems }, { status: 'disabled', problems: ['no SMTP transport'] });
  const mailer = recordingMailer();
  const noAddress = await runSendTick({ db, mailer, cfg: testConfig({ OUTREACH_PHYSICAL_ADDRESS: '' }), now: T0 });
  assert.equal(noAddress.status, 'disabled');
  assert.match(noAddress.problems.join(), /PHYSICAL_ADDRESS/);
  const noKeys = await runSendTick({ db, mailer, cfg: testConfig({ OUTREACH_SMTP_PASS: '' }), now: T0 });
  assert.equal(noKeys.status, 'disabled');
  assert.equal(db.emails.get(e)!.send_attempts, 0);
  assert.equal(mailer.sent.length, 0);
});

test('an address that opted out after approval is never sent', async () => {
  const db = fakeDb();
  const lead = await seedLead(db);
  const e = await draftFirstTouch(db, lead);
  db.decide((await db.createDailyBatch(null, false))!, 'approve');
  await db.suppress(db.leads.get(lead)!.email!, 'Replied: stop', 'reply', null);
  const mailer = recordingMailer();
  assert.equal((await runSendTick({ db, mailer, cfg: testConfig(), now: T0 })).status, 'idle');
  assert.equal(db.emails.get(e)!.status, 'cancelled');
  assert.equal(mailer.sent.length, 0);
});

test('SMTP trouble: a temporary error keeps the email for the next tick; a permanent one (5xx / rejected) fails it', async () => {
  const db = fakeDb();
  const a = await draftFirstTouch(db, await seedLead(db));
  const b = await draftFirstTouch(db, await seedLead(db));
  db.decide((await db.createDailyBatch(null, false))!, 'approve');
  const mailer = recordingMailer({ fail: Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' }) });
  const r = await runSendTick({ db, mailer, cfg: testConfig(), now: T0 });
  assert.deepEqual({ sent: r.sent, failed: r.failed }, { sent: 0, failed: 1 });
  assert.equal(db.emails.get(a)!.status, 'approved', 'retried next tick');
  assert.match(db.emails.get(a)!.last_error ?? '', /timeout/);
  assert.equal(db.emails.get(b)!.send_attempts, 0, 'the tick stops on server trouble');
  await runSendTick({ db, mailer, cfg: testConfig(), now: T0 });
  assert.equal(db.emails.get(a)!.status, 'sent');
  assert.equal(db.emails.get(b)!.status, 'sent');

  const db2 = fakeDb();
  const c = await draftFirstTouch(db2, await seedLead(db2));
  db2.decide((await db2.createDailyBatch(null, false))!, 'approve');
  await runSendTick({ db: db2, mailer: recordingMailer({ reject: true }), cfg: testConfig(), now: T0 });
  assert.equal(db2.emails.get(c)!.status, 'failed');
  assert.equal(db2.leads.get(db2.emails.get(c)!.lead_id)!.stage, 'researched', 'not marked contacted');
});
