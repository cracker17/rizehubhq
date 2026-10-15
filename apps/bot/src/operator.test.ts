import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notifierTick, renderApproval, type Sender } from './notifier';
import { onButton, onNoteText, type DecisionDeps } from './decisions';
import { PendingNotes } from './pending';
import { approval, FakeBotDb } from './fakeBotDb';
import type { InlineMarkup } from './keyboard';
import { clientArg, formatOperatorNotice, formatOperatorStatus, shouldNotify, type OperatorNotice } from './operator';
import type { BotApproval } from './types';

const reply = (p: Partial<BotApproval> = {}): BotApproval => approval({
  kind: 'external_action', agent_id: null, request_id: null, requests: null, title: 'Reply to Alex (LvlUp Ventures)', summary: 'On it, @Alex',
  payload: { type: 'operator_reply', inbox_id: 'i1', client: 'lvlup', client_name: 'LvlUp Ventures', channel: 'Alex, Riley', sender: 'Alex',
    message: 'Can you add <Sam> to the team page?', draft: 'On it, @Alex', category: 'task', action_types: ['ack', 'task'], confidence: 0.82,
    task_plan: ['Add Sam card', 'Publish after approval'], message_url: 'https://chat.google.com/room/A' },
  ...p,
});

class FakeSender implements Sender {
  sent: { text: string; markup?: InlineMarkup }[] = [];
  async send(_c: number, text: string, markup?: InlineMarkup) { this.sent.push({ text, markup }); return this.sent.length; }
  async edit() { /* not needed */ }
}

test('reply drafts: message, draft and why; buttons Send / Edit / Skip; HTML is escaped', () => {
  const { text, markup } = renderApproval(reply(), new Map(), 'https://hq.rizehub.ph', 'Asia/Manila');
  assert.match(text, /💬 <b>REPLY<\/b> · LvlUp Ventures · Alex, Riley/);
  assert.match(text, /&lt;Sam&gt;/);
  assert.match(text, /<blockquote>On it, @Alex<\/blockquote>/);
  assert.match(text, /ack, task · confidence 82%/);
  const labels = markup.inline_keyboard[0]!.map((b) => b.text);
  assert.deepEqual(labels.slice(0, 3), ['✅ Send', '✏️ Edit', '⏭ Skip']);
  const done = renderApproval(reply({ status: 'changes_requested', ceo_note: 'Done! @Alex', decided_at: '2026-10-15T02:00:00Z', decided_via: 'telegram' }),
    new Map(), 'https://hq.rizehub.ph', 'Asia/Manila');
  assert.match(done.text, /✏️ Edited 10:00: posting your text/);
});

test('reply drafts go out in quiet hours (a client is waiting); other approvals still wait', async () => {
  const db = new FakeBotDb();
  db.settings.quiet_hours = { start: '22:00', end: '07:00' };
  db.approvals.push(reply(), approval());
  const sender = new FakeSender();
  const r = await notifierTick({ db, sender, chatId: 1, dashboardUrl: 'https://hq.rizehub.ph', names: () => new Map(), now: () => new Date('2026-10-15T15:00:00Z'), log: () => {} },
    { lastDecisionSync: '2026-10-15T00:00:00Z' });
  assert.equal(r.sent, 1);
  assert.equal(r.held, 1);
  assert.match(sender.sent[0]!.text, /REPLY/);
});

test('✏️ Edit asks for the exact text; the next message becomes the posted reply', async () => {
  const db = new FakeBotDb();
  const ap = reply();
  db.approvals.push(ap);
  const d: DecisionDeps = { db, pending: new PendingNotes(), names: () => new Map(), dashboardUrl: 'https://hq.rizehub.ph', tz: () => 'Asia/Manila' };
  const out = await onButton(d, 7, 70, ap.id, 'changes');
  assert.equal(out.kind, 'ask_note');
  assert.match((out as { prompt: string }).prompt, /exactly as it should be posted/);
  const note = await onNoteText(d, 7, 'Added Sam, live here: https://www.lvlup.vc/fund/team');
  assert.equal(note!.reply, '✏️ Posting your text.');
  assert.deepEqual(db.decisions[0], { id: ap.id, decision: 'changes', note: 'Added Sam, live here: https://www.lvlup.vc/fund/team' });
  const skip = reply();
  db.approvals.push(skip);
  const s = await onButton(d, 7, 71, skip.id, 'reject');
  assert.equal(s.kind === 'edit' && s.toast, 'Skipped');
});

const notice = (p: Partial<OperatorNotice>): OperatorNotice & { telegram_sent_at: string | null } => ({
  id: Math.floor(Math.random() * 1e9), created_at: '2026-10-15T05:59:00Z', client_slug: 'lvlup', inbox_id: 'i1', action: 'send.done', ok: true,
  detail: {}, operator_inbox: { sender_name: 'Alex', final_text: 'Thanks Alex!', mode: 'auto', error: null, url: null }, telegram_sent_at: null, ...p,
});

test('notices: auto-sends, failures and blocked chats are announced once; approved sends are only marked', async () => {
  const db = new FakeBotDb();
  db.operatorNotices.push(
    notice({}),
    notice({ operator_inbox: { sender_name: 'Alex', final_text: 'x', mode: 'approve', error: null, url: null } }),
    notice({ action: 'send.failed', ok: false, detail: { error: 'composer not found' } }),
    notice({ action: 'watch.failed', ok: false, inbox_id: null, operator_inbox: null, detail: { channel: 'Alex, Riley', error: 'signed out of Google' } }),
  );
  const sender = new FakeSender();
  const deps = { db, sender, chatId: 1, dashboardUrl: 'https://hq.rizehub.ph', names: () => new Map(), now: () => new Date('2026-10-15T06:00:00Z'), log: () => {} };
  const r = await notifierTick(deps, { lastDecisionSync: '2026-10-15T00:00:00Z' });
  assert.equal(r.operatorNotices, 3);
  assert.equal(db.operatorNotices.filter((n) => n.telegram_sent_at).length, 4, 'all four marked, so nothing repeats');
  assert.match(sender.sent.map((s) => s.text).join('\n'), /Auto-replied.*[\s\S]*Reply not posted[\s\S]*Can't read Alex, Riley/);
  assert.equal((await notifierTick(deps, { lastDecisionSync: '2026-10-15T00:00:00Z' })).operatorNotices, 0);
  assert.equal(shouldNotify({ action: 'message.classify_failed', detail: { attempts: 1 }, operator_inbox: null }), false);
  assert.match(formatOperatorNotice(notice({ action: 'send.blocked', detail: { action_types: ['credentials'] } })), /never.*[\s\S]*credentials/);
});

test('/status <client> and arguments', () => {
  const text = formatOperatorStatus({
    client: { slug: 'lvlup', name: 'LvlUp Ventures', paused: false, enabled: true }, blocker: 'operator paused (kill switch)', auto_send: false,
    counts: { sent: 3, drafted: 1, fyi: 9 }, channels: [{ name: 'Alex, Riley', enabled: true, last_polled_at: '2026-10-15T05:58:00Z', last_error: null }],
    last_action: null,
  }, '2026-10-15T05:59:30Z', new Date('2026-10-15T06:00:00Z'), 'Asia/Manila');
  assert.match(text, /🟢 online/);
  assert.match(text, /Sends stopped: operator paused/);
  assert.match(text, /3 sent · 1 waiting for you · 9 FYI/);
  assert.match(text, /Alex, Riley: read 13:58/);
  assert.equal(clientArg(' @LvlUp '), 'lvlup');
  assert.equal(clientArg(''), null);
  assert.equal(clientArg('drop table'), null);
});
