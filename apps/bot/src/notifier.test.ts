import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notifierTick, type Sender } from './notifier';
import { onButton, onNoteText, type DecisionDeps } from './decisions';
import { PendingNotes } from './pending';
import { approval, FakeBotDb } from './fakeBotDb';
import type { InlineMarkup } from './keyboard';
import type { BotApproval, BotReport } from './types';

class FakeSender implements Sender {
  sent: { chatId: number; text: string; markup?: InlineMarkup; id: number }[] = [];
  edits: { chatId: number; messageId: number; text: string; markup?: InlineMarkup }[] = [];
  failNext = false;
  private seq = 100;
  async send(chatId: number, text: string, markup?: InlineMarkup) {
    if (this.failNext) { this.failNext = false; throw new Error('Telegram down'); }
    const id = ++this.seq; this.sent.push({ chatId, text, markup, id }); return id;
  }
  async edit(chatId: number, messageId: number, text: string, markup?: InlineMarkup) { this.edits.push({ chatId, messageId, text, markup }); }
}

const DAY = new Date('2026-09-28T06:00:00Z');   // 14:00 Manila
const NIGHT = new Date('2026-09-28T15:00:00Z'); // 23:00 Manila
const names = () => new Map([['seo-1', 'SEO Writer 1']]);
function setup(now = DAY) {
  const db = new FakeBotDb();
  const sender = new FakeSender();
  const deps = { db, sender, chatId: 42, dashboardUrl: 'https://hq.rizehub.ph', names, now: () => now, log: () => {} };
  return { db, sender, deps, state: { lastDecisionSync: '2026-09-28T00:00:00Z' } };
}
const report = (p: Partial<BotReport> = {}): BotReport => ({
  id: `r-${Math.random()}`, agent_id: 'ea', report_date: '2026-09-28', kind: 'daily_digest', body_md: '# Digest', data: {},
  created_at: '2026-09-28T10:00:00Z', telegram_sent_at: null, ...p,
});

test('new approvals are sent once each, with buttons, and the message id is stored', async () => {
  const { db, sender, deps, state } = setup();
  db.approvals.push(approval(), approval({ title: 'Second' }));
  const r = await notifierTick(deps, state);
  assert.equal(r.sent, 2);
  assert.equal(sender.sent[0]!.chatId, 42);
  assert.equal(sender.sent[0]!.markup!.inline_keyboard[0]!.length, 4);
  assert.deepEqual(db.approvals.map((a) => a.telegram_message_id), [101, 102]);
  assert.equal((await notifierTick(deps, state)).sent, 0);
  assert.equal(sender.sent.length, 2);
});

test('a failed send is retried on the next tick', async () => {
  const { db, sender, deps, state } = setup();
  db.approvals.push(approval());
  sender.failNext = true;
  assert.equal((await notifierTick(deps, state)).errors, 1);
  assert.equal(db.approvals[0]!.telegram_message_id, null);
  assert.equal((await notifierTick(deps, state)).sent, 1);
});

test('quiet hours: only urgent requests and task failures go out; the rest are held until morning', async () => {
  const { db, sender, deps, state } = setup(NIGHT);
  db.approvals.push(
    approval({ title: 'Normal deliverable' }),
    approval({ title: 'Urgent one', requests: { priority: 'urgent', title: null, due_date: null } }),
    approval({ kind: 'external_action', title: 'Stuck: Build', payload: { type: 'task_failed', reason: 'x' } }),
  );
  db.reports.push(report());
  const r = await notifierTick(deps, state);
  assert.deepEqual([r.quiet, r.sent, r.held, r.reports], [true, 2, 1, 0]);
  assert.deepEqual(sender.sent.map((s) => s.text.split('\n')[0]), ['🔴 <b>URGENT</b> · ✅ <b>QA PASSED 92/100</b> · Urgent one (SEO Writer 1)', '⚠️ <b>TASK FAILED</b> · Build (SEO Writer 1)']);
  // morning: the held approval and the report go out
  const morning = { ...deps, now: () => new Date('2026-09-28T23:05:00Z') }; // 07:05 Manila
  const m = await notifierTick(morning, state);
  assert.deepEqual([m.quiet, m.sent, m.reports], [false, 1, 1]);
});

test('digest / brief / weekly are sent once; old or standup reports are not', async () => {
  const { db, sender, deps, state } = setup();
  db.reports.push(report(), report({ kind: 'morning_brief' }), report({ kind: 'standup' }), report({ created_at: '2026-09-20T10:00:00Z' }));
  assert.equal((await notifierTick(deps, state)).reports, 2);
  assert.equal((await notifierTick(deps, state)).reports, 0);
  assert.equal(sender.sent.length, 2);
});

test('approvals decided in the dashboard get their Telegram message updated (buttons removed)', async () => {
  const { db, sender, deps, state } = setup();
  db.approvals.push(approval({ status: 'approved', decided_at: '2026-09-28T05:00:00Z', decided_via: 'dashboard', telegram_message_id: 77 }));
  db.approvals.push(approval({ status: 'rejected', decided_at: '2026-09-28T05:01:00Z', decided_via: 'telegram', telegram_message_id: 78 }));
  const r = await notifierTick(deps, state);
  assert.equal(r.synced, 1);
  assert.equal(sender.edits[0]!.messageId, 77);
  assert.match(sender.edits[0]!.text, /✅ Approved by you 13:00<\/b> \(dashboard\)$/);
  assert.deepEqual(sender.edits[0]!.markup!.inline_keyboard, [[{ text: '🔗 Open', url: `https://hq.rizehub.ph/approvals?id=${db.approvals[0]!.id}` }]]);
  assert.equal(state.lastDecisionSync, '2026-09-28T05:01:00Z');
  assert.equal((await notifierTick(deps, state)).synced, 0);
});

function decisionDeps(db: FakeBotDb): DecisionDeps {
  return { db, pending: new PendingNotes(), names, dashboardUrl: 'https://hq.rizehub.ph', tz: () => 'Asia/Manila' };
}

test('✅ Approve applies via decide_approval and edits the message to "Approved by you 14:02"', async () => {
  const db = new FakeBotDb();
  const ap = approval(); db.approvals.push(ap);
  const out = await onButton(decisionDeps(db), 42, 500, ap.id, 'approve');
  assert.equal(out.kind, 'edit');
  if (out.kind !== 'edit') return;
  assert.equal(out.toast, 'Approved: marked done');
  assert.match(out.text, /✅ Approved by you 14:02/);
  assert.equal(out.markup.inline_keyboard[0]!.length, 1); // only Open
  assert.deepEqual(db.decisions, [{ id: ap.id, decision: 'approve', note: null }]);
});

test('tapping an already-decided approval shows the decision instead of applying again', async () => {
  const db = new FakeBotDb();
  const ap = approval({ status: 'rejected', decided_at: '2026-09-28T01:00:00Z', decided_via: 'dashboard' }); db.approvals.push(ap);
  const out = await onButton(decisionDeps(db), 42, 500, ap.id, 'approve');
  assert.equal(out.toast, 'Already decided');
  assert.equal(out.kind === 'edit' && /❌ Rejected by you 09:00/.test(out.text), true);
  assert.equal(db.decisions.length, 0);
  assert.equal((await onButton(decisionDeps(db), 42, 500, '00000000-0000-0000-0000-000000000000', 'approve')).kind, 'toast');
});

test('✏️ Changes asks for a note; the next text becomes the change note and edits the original message', async () => {
  const db = new FakeBotDb();
  const ap = approval(); db.approvals.push(ap);
  const d = decisionDeps(db);
  const ask = await onButton(d, 42, 500, ap.id, 'changes', 0);
  assert.equal(ask.kind, 'ask_note');
  assert.match(ask.kind === 'ask_note' ? ask.prompt : '', /What should change for “Landing copy”\?/);
  assert.equal(db.decisions.length, 0);
  assert.equal(await onNoteText(d, 99, 'wrong chat', 1000), null);
  const res = await onNoteText(d, 42, '  Make the hero shorter  ', 60_000);
  assert.ok(res);
  assert.equal(res!.messageId, 500);
  assert.deepEqual(db.decisions, [{ id: ap.id, decision: 'changes', note: 'Make the hero shorter' }]);
  assert.match(res!.edit.text, /✏️ Changes requested by you 14:02<\/b>\n“Make the hero shorter”/);
  assert.equal(res!.reply, '✏️ Sent back for changes.');
  assert.equal(await onNoteText(d, 42, 'a new request', 70_000), null); // consumed
});

test('a change note after 10 minutes is not applied (the text is treated as a normal message)', async () => {
  const db = new FakeBotDb();
  const ap = approval({ kind: 'external_action', payload: { type: 'question', question: 'A or B?' } }); db.approvals.push(ap);
  const d = decisionDeps(db);
  const ask = await onButton(d, 42, 500, ap.id, 'changes', 0);
  assert.equal(ask.toast, 'Type your answer');
  assert.equal(await onNoteText(d, 42, 'B', 10 * 60_000 + 1), null);
  assert.equal(db.decisions.length, 0);
});

const twofa = (p: Partial<BotApproval> = {}) => approval({
  kind: 'external_action', title: '2FA code needed: Madam Muse store', summary: 'Reply with the code only.',
  payload: { type: 'question', question: 'Reply with the code only.', options: [], vault: { kind: '2fa', credential_id: 'c1' } }, ...p,
});

test('2FA: ✅ with no code asks for the code (no decision, no crash); the typed code is applied as approve and hidden', async () => {
  const db = new FakeBotDb();
  const ap = twofa(); db.approvals.push(ap);
  const d = decisionDeps(db);
  const ask = await onButton(d, 42, 500, ap.id, 'approve', 0);
  assert.equal(ask.kind, 'ask_note');
  assert.equal(ask.toast, 'Type the code');
  assert.match(ask.kind === 'ask_note' ? ask.prompt : '', /one-time code/);
  assert.equal(db.decisions.length, 0);

  const bad = await onNoteText(d, 42, 'which code?', 1000);
  assert.match(bad!.reply, /doesn't look like a one-time code/);
  assert.equal(bad!.secret, true);
  assert.equal(db.decisions.length, 0, 'still waiting for the code');

  const res = await onNoteText(d, 42, ' 482 913 ', 2000);
  assert.deepEqual(db.decisions, [{ id: ap.id, decision: 'approve', note: '482913' }]);
  assert.equal(res!.secret, true, 'index.ts deletes the CEO message holding the code');
  assert.match(res!.reply, /Code sent/);
  assert.match(res!.edit.text, /🔐 Code sent by you 14:02/);
  assert.ok(!res!.edit.text.includes('482913'), 'the code is never echoed in the chat');
  assert.equal(await onNoteText(d, 42, 'a new request', 3000), null, 'consumed');
});

test('2FA: ✏️ Answer also records approve + code (never "changes"); ❌ declines without asking', async () => {
  const db = new FakeBotDb();
  const ap = twofa(); db.approvals.push(ap);
  const d = decisionDeps(db);
  assert.equal((await onButton(d, 42, 500, ap.id, 'changes', 0)).kind, 'ask_note');
  await onNoteText(d, 42, '111222', 1000);
  assert.deepEqual(db.decisions, [{ id: ap.id, decision: 'approve', note: '111222' }]);
  assert.equal(db.approvals[0]!.status, 'approved');

  const ap2 = twofa(); db.approvals.push(ap2);
  const out = await onButton(d, 42, 501, ap2.id, 'reject', 0);
  assert.equal(out.kind, 'edit');
  assert.equal(db.approvals[1]!.status, 'rejected');
});

test('2FA: a code typed after the request expired is not used', async () => {
  const db = new FakeBotDb();
  const ap = twofa(); db.approvals.push(ap);
  const d = decisionDeps(db);
  await onButton(d, 42, 500, ap.id, 'approve', 0);
  Object.assign(db.approvals[0]!, { status: 'rejected', ceo_note: '[2FA request expired]', decided_at: '2026-09-28T06:00:00Z' });
  const res = await onNoteText(d, 42, '123456', 1000);
  assert.match(res!.reply, /already closed/);
  assert.equal(db.decisions.length, 0);
  assert.match(res!.edit.text, /Expired/);
  assert.ok(!res!.edit.text.includes('123456'));
});
