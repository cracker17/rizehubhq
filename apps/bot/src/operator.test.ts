import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notifierTick, renderApproval, type Sender } from './notifier';
import { onButton, onNoteText, type DecisionDeps } from './decisions';
import { PendingNotes } from './pending';
import { approval, FakeBotDb } from './fakeBotDb';
import type { InlineMarkup } from './keyboard';
import { clientArg, formatJobs, formatLogins, formatOperatorNotice, formatOperatorStatus, isOperatorReply, noticeEvidence, operatorToast, parseTaskArgs, shouldNotify,
  type OperatorNotice } from './operator';
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
  assert.deepEqual(labels.slice(0, 3), ['✅ Send + start', '✏️ Edit', '⏭ Skip'], 'a task draft: sending it also starts the job');
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

test('notices: every posted reply (auto or approved), failures and unreadable chats are announced once', async () => {
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
  assert.equal(r.operatorNotices, 4);
  assert.equal(db.operatorNotices.filter((n) => n.telegram_sent_at).length, 4, 'all four marked, so nothing repeats');
  assert.match(sender.sent.map((s) => s.text).join('\n'), /Auto-replied.*[\s\S]*Reply posted.*[\s\S]*Reply not posted[\s\S]*Can't read Alex, Riley/);
  assert.doesNotMatch(sender.sent[1]!.text, /\/pause/, 'the kill-switch hint is for auto-sends only');
  assert.equal((await notifierTick(deps, { lastDecisionSync: '2026-10-15T00:00:00Z' })).operatorNotices, 0);
  assert.equal(shouldNotify({ action: 'message.classify_failed', detail: { attempts: 1 }, operator_inbox: null }), false);
  assert.match(formatOperatorNotice(notice({ action: 'send.blocked', detail: { action_types: ['credentials'] } })), /never.*[\s\S]*credentials/);
});

test('/status <client> and arguments', () => {
  const text = formatOperatorStatus({
    client: { slug: 'lvlup', name: 'LvlUp Ventures', paused: false, enabled: true }, blocker: 'operator paused (kill switch)', auto_send: false,
    counts: { sent: 3, drafted: 1, fyi: 9 }, channels: [{ name: 'Alex, Riley', enabled: true, last_polled_at: '2026-10-15T05:58:00Z', last_error: null }],
    last_action: null,
    jobs: [{ id: 'j1', title: 'Add Sam', status: 'running', updated_at: '2026-10-15T05:50:00Z' }],
    logins: [{ site: 'google', label: 'Google (Chat)', state: 'ok', last_checked_at: null }, { site: 'webflow', label: 'Webflow', state: 'signed_out', last_checked_at: null }],
  }, '2026-10-15T05:59:30Z', new Date('2026-10-15T06:00:00Z'), 'Asia/Manila');
  assert.match(text, /🛠 Add Sam · running · 13:50/);
  assert.match(text, /Logins: 🟢 Google \(Chat\) · 🔴 Webflow/);
  assert.match(text, /🟢 online/);
  assert.match(text, /Sends stopped: operator paused/);
  assert.match(text, /3 sent · 1 waiting for you · 9 FYI/);
  assert.match(text, /Alex, Riley: read 13:58/);
  assert.equal(clientArg(' @LvlUp '), 'lvlup');
  assert.equal(clientArg(''), null);
  assert.equal(clientArg('drop table'), null);
});

// ---------- phase 2: worker mode ----------

const ext = (payload: Record<string, unknown>, p: Partial<BotApproval> = {}): BotApproval =>
  approval({ kind: 'external_action', agent_id: null, request_id: null, requests: null, title: 'x', summary: 'x', payload, ...p });
const labels = (ap: BotApproval) => renderApproval(ap, new Map(), 'https://hq.rizehub.ph', 'Asia/Manila').markup.inline_keyboard[0]!.map((b) => b.text).slice(0, 3);

test('task drafts say "Send + start"; plain replies "Send"', () => {
  assert.deepEqual(labels(reply()), ['✅ Send + start', '✏️ Edit', '⏭ Skip']);
  assert.deepEqual(labels(reply({ payload: { ...reply().payload, category: 'reply' } })), ['✅ Send', '✏️ Edit', '⏭ Skip']);
  assert.equal(operatorToast(reply(), 'action_approved'), 'Posting the draft + starting the task');
});

test('client updates: Send / Edit / Skip, Edit takes the exact text, decision line says sending', async () => {
  const up = ext({ type: 'operator_update', outbox_id: 'o1', job_title: 'Add Sam to the team page', client_name: 'LvlUp Ventures', channel: 'Alex, Riley',
    sender: 'Alex', message: 'Can you add Sam?', draft: 'Done: Sam is live on the team page.', links: ['https://www.lvlup.vc/team'], message_url: 'https://chat.google.com/room/A' },
  { summary: 'Done: Sam is live on the team page.' });
  const { text } = renderApproval(up, new Map(), 'https://hq.rizehub.ph', 'Asia/Manila');
  assert.match(text, /📣 <b>CLIENT UPDATE<\/b> · LvlUp Ventures · Alex, Riley/);
  assert.match(text, /Job done: Add Sam to the team page/);
  assert.match(text, /<blockquote>Done: Sam is live on the team page.<\/blockquote>/);
  assert.match(text, /href="https:\/\/www.lvlup.vc\/team"/);
  assert.deepEqual(labels(up), ['✅ Send', '✏️ Edit', '⏭ Skip']);
  assert.equal(isOperatorReply(up), true);
  const db = new FakeBotDb();
  db.approvals.push(up);
  const d: DecisionDeps = { db, pending: new PendingNotes(), names: () => new Map(), dashboardUrl: 'https://hq.rizehub.ph', tz: () => 'Asia/Manila' };
  const out = await onButton(d, 7, 70, up.id, 'changes');
  assert.match((out as { prompt: string }).prompt, /exactly as it should be posted/);
  const note = await onNoteText(d, 7, 'Sam is live: https://www.lvlup.vc/team');
  assert.equal(note!.reply, '✏️ Sending your text.');
  assert.match(note!.edit.text, /Edited \d\d:\d\d: sending your text/);
});

test('job actions and memories: what exactly happens, their own buttons, sent in quiet hours only when someone waits', async () => {
  const act = ext({ type: 'operator_action', action_id: 'x1', job_title: 'Add Sam', client_name: 'LvlUp Ventures', action_kind: 'browser_click',
    spec: { url: 'https://webflow.com/design/lvlup', text: 'Publish', selector: 'button' } }, { summary: 'Publish the site to lvlup.vc' });
  const t = renderApproval(act, new Map(), 'https://hq.rizehub.ph', 'Asia/Manila').text;
  assert.match(t, /🚀 <b>Click in the browser<\/b> · LvlUp Ventures/);
  assert.match(t, /On https:\/\/webflow.com\/design\/lvlup: click “Publish”/);
  assert.deepEqual(labels(act), ['✅ Do it', '✏️ Not like this', '❌ Don’t']);
  const cms = ext({ type: 'operator_action', action_kind: 'webflow_publish', client_name: 'LvlUp', job_title: 'j', spec: { site_id: 's1', domains: ['lvlup.vc'] } });
  assert.match(renderApproval(cms, new Map(), 'https://hq.rizehub.ph', 'Asia/Manila').text, /Publish \(Webflow\)<\/b> · LvlUp ⚠️[\s\S]*<pre>[\s\S]*lvlup.vc/);
  const mem = ext({ type: 'brain_proposal', kind: 'decision', project_name: 'LvlUp Ventures', text: 'Team bios stay under 40 words.' });
  const mt = renderApproval(mem, new Map(), 'https://hq.rizehub.ph', 'Asia/Manila').text;
  assert.match(mt, /🧠 <b>MEMORY<\/b> · decision · LvlUp Ventures/);
  assert.deepEqual(labels(mem), ['✅ Save', '✏️ Not like this', '❌ Drop']);
  assert.equal(operatorToast(mem, 'action_approved'), 'Saved to memory');

  const db = new FakeBotDb();
  db.settings.quiet_hours = { start: '22:00', end: '07:00' };
  db.approvals.push(act, mem);
  const sender = new FakeSender();
  const r = await notifierTick({ db, sender, chatId: 1, dashboardUrl: 'https://hq.rizehub.ph', names: () => new Map(), now: () => new Date('2026-10-15T15:00:00Z'), log: () => {} },
    { lastDecisionSync: '2026-10-15T00:00:00Z' });
  assert.deepEqual([r.sent, r.held], [1, 1], 'the action goes out at night, the memory waits');
});

class PhotoSender extends FakeSender {
  albums: { jpeg: Buffer; caption: string }[][] = [];
  async photos(_c: number, p: { jpeg: Buffer; caption: string }[]) { this.albums.push(p); }
}

test('job notices: started, done (summary, links, QA, cost + screenshots), escalated, client informed, actions, logins', async () => {
  const db = new FakeBotDb();
  db.evidence.set(11, { label: 'QA 375px', jpeg: Buffer.from([0xff, 0xd8, 1]) });
  db.evidence.set(12, { label: 'QA 1366px', jpeg: Buffer.from([0xff, 0xd8, 2]) });
  const j = { inbox_id: null, operator_inbox: null, job_id: 'job-1', job_title: 'Add Sam to the team page' };
  db.operatorNotices.push(
    notice({ ...j, action: 'job.started', detail: { title: 'Add Sam to the team page' } }),
    notice({ ...j, action: 'job.done', detail: { summary: 'Added Sam\'s card & bio', links: ['https://www.lvlup.vc/team'], cost_usd: 0.84, qa: { pass: true, errors: [], evidence: [11, 12] } } }),
    notice({ ...j, action: 'job.escalated', ok: false, detail: { reason: 'Needs the photo: none in the drive' } }),
    notice({ ...j, action: 'update.done', detail: { text: 'Sam is live!', channel: 'Alex, Riley', url: 'https://chat.google.com/room/A', mode: 'approve' } }),
    notice({ ...j, action: 'action.failed', ok: false, detail: { kind: 'webflow_publish', summary: 'Publish', error: 'HTTP 409' } }),
    notice({ inbox_id: null, operator_inbox: null, action: 'login.lost', ok: false, detail: { site: 'webflow', label: 'Webflow', detail: 'redirected to https://webflow.com/login' } }),
    notice({ inbox_id: null, operator_inbox: null, action: 'login.restored', detail: { site: 'webflow', label: 'Webflow' } }),
  );
  const sender = new PhotoSender();
  const r = await notifierTick({ db, sender, chatId: 1, dashboardUrl: 'https://hq.rizehub.ph', names: () => new Map(), now: () => new Date('2026-10-15T06:00:00Z'), log: () => {} },
    { lastDecisionSync: '2026-10-15T00:00:00Z' });
  assert.equal(r.operatorNotices, 7);
  const all = sender.sent.map((s) => s.text);
  assert.match(all[0]!, /🛠 <b>Started<\/b> · lvlup\nAdd Sam to the team page/);
  assert.match(all[1]!, /✅ <b>Done<\/b> · lvlup · \$0.84\nAdd Sam to the team page\nAdded Sam's card &amp; bio\nLinks: <a href="https:\/\/www.lvlup.vc\/team">/);
  assert.match(all[1]!, /QA ✅ 375 \/ 1366 px/);
  assert.match(all[1]!, /hq.rizehub.ph\/operator/);
  assert.deepEqual(sender.albums.map((a) => a.map((p) => p.caption)), [['QA 375px', 'QA 1366px']]);
  assert.match(all[2]!, /🙋 <b>Needs you<\/b>[\s\S]*Needs the photo/);
  assert.match(all[3]!, /📣 <b>Client informed<\/b> · lvlup · Alex, Riley\nJob: Add Sam[\s\S]*Sam is live![\s\S]*Open the chat/);
  assert.match(all[4]!, /Action failed: Publish \(Webflow\)[\s\S]*HTTP 409[\s\S]*Not retried/);
  assert.match(all[5]!, /🔑 <b>Signed out of Webflow<\/b>[\s\S]*workspace viewer/);
  assert.match(all[6]!, /🔓 <b>Logged in again: Webflow/);
  assert.deepEqual(noticeEvidence({ action: 'job.started', detail: { qa: { evidence: [1] } } }), []);
  assert.deepEqual(noticeEvidence({ action: 'job.done', detail: { qa: { evidence: [1, 'x', -2, 3, 4, 5, 6] } } }), [1, 3, 4, 5]);
});

test('/task, /jobs, /logins', () => {
  assert.deepEqual(parseTaskArgs(' LvlUp  Add Sam to the team page\nphoto in drive'), { client: 'lvlup', brief: 'Add Sam to the team page\nphoto in drive' });
  assert.equal(parseTaskArgs('lvlup'), null);
  assert.equal(parseTaskArgs('lvlup ok'), null);
  assert.equal(parseTaskArgs(''), null);
  const jobs = formatJobs([
    { id: '1', client_slug: 'lvlup', title: 'Add Sam', status: 'waiting', cost_usd: '0.40', updated_at: '2026-10-15T05:00:00Z', error: null },
    { id: '2', client_slug: 'lvlup', title: 'Fix <footer>', status: 'escalated', cost_usd: 0, updated_at: '2026-10-15T04:00:00Z', error: 'QA kept failing' },
  ], null, 'Asia/Manila');
  assert.match(jobs, /✋ Add Sam · lvlup · waiting \(approve its actions\) · 13:00 · \$0.40/);
  assert.match(jobs, /🙋 Fix &lt;footer&gt; · lvlup · escalated: QA kept failing · 12:00/);
  assert.match(formatJobs([], 'lvlup', 'Asia/Manila'), /No operator jobs for lvlup/);
  const logins = formatLogins([
    { client_slug: 'lvlup', site: 'google', label: 'Google (Chat)', state: 'ok', last_checked_at: '2026-10-15T05:00:00Z', detail: 'Chat' },
    { client_slug: 'lvlup', site: 'webflow', label: 'Webflow', state: 'signed_out', last_checked_at: '2026-10-15T05:00:00Z', detail: 'redirected to login' },
  ], 'Asia/Manila');
  assert.match(logins, /🟢 lvlup · Google \(Chat\): logged in · checked 13:00/);
  assert.match(logins, /🔴 lvlup · Webflow: signed out · checked 13:00\n {3}redirected to login/);
  assert.match(logins, /workspace viewer/);
});

test('fake db: /task queues for known clients only', async () => {
  const db = new FakeBotDb();
  db.operatorStatuses.set('lvlup', { client: { slug: 'lvlup', name: 'LvlUp', paused: false, enabled: true }, blocker: null, auto_send: false, counts: {}, channels: [], last_action: null });
  await db.addOperatorJob('lvlup', 'Add Sam');
  await assert.rejects(db.addOperatorJob('nope', 'x y z'), /unknown client/);
  assert.equal((await db.operatorJobs('lvlup', 5))[0]!.status, 'queued');
});

// ---------- phase 3: digests ----------

test('operator digests: sent like the other reports, with per-client lines; quiet clients get one line', async () => {
  const { formatOperatorDigest } = await import('./operator');
  const data = {
    kind: 'operator_evening', kill_switch: false, office_paused: false, auto_send: false, online: true, spend_usd: 1.37,
    clients: [
      { slug: 'lvlup', name: 'LvlUp Ventures', paused: false, messages: 5, replies_sent: 3, auto_sent: 0, updates_sent: 1, waiting: 2,
        jobs_done: [{ title: 'Add Sam to the team page', links: ['https://www.lvlup.vc/team'], cost_usd: 0.84 }],
        jobs_open: [{ title: 'Check the fund page', status: 'running' }],
        jobs_stuck: [{ title: 'New logos', status: 'escalated', why: 'Send the Kinetic and Ardent logos' }],
        logins_bad: ['Webflow'], failures: 1 },
      { slug: 'madam-muse', name: 'Madam Muse', paused: false, messages: 0, replies_sent: 0, auto_sent: 0, updates_sent: 0, waiting: 0,
        jobs_done: [], jobs_open: [], jobs_stuck: [], logins_bad: [], failures: 0 },
    ],
  } as const;
  const text = formatOperatorDigest(data as never, 'https://hq.rizehub.ph');
  assert.match(text, /🌙 <b>Operator · evening<\/b> · ▶️ Live · every reply asks · \$1.37/);
  assert.match(text, /📥 <b>2 waiting for you<\/b>/);
  assert.match(text, /<b>LvlUp Ventures<\/b>: 5 messages · 3 replies sent · 1 client update · 2 waiting for you/);
  assert.match(text, /✅ Add Sam to the team page · <a href="https:\/\/www.lvlup.vc\/team">link<\/a>/);
  assert.match(text, /🙋 New logos: Send the Kinetic and Ardent logos/);
  assert.match(text, /🛠 Check the fund page · running/);
  assert.match(text, /🔑 Signed out: Webflow/);
  assert.match(text, /⚠️ 1 thing failed: \/status lvlup/);
  assert.match(text, /<b>Madam Muse<\/b>: quiet today\./);
  assert.match(formatOperatorDigest({ ...data, kind: 'operator_morning', kill_switch: true } as never, 'http://localhost:3000'), /☀️ <b>Operator · morning<\/b> · 🛑 Sends stopped/);

  const db = new FakeBotDb();
  db.reports.push({ id: 'r1', agent_id: null, report_date: '2026-10-15', kind: 'operator_evening', body_md: 'Operator evening digest', data: data as never,
    created_at: '2026-10-15T10:00:00Z', telegram_sent_at: null } as never);
  const sender = new FakeSender();
  const r = await notifierTick({ db, sender, chatId: 1, dashboardUrl: 'https://hq.rizehub.ph', names: () => new Map(), now: () => new Date('2026-10-15T10:01:00Z'), log: () => {} },
    { lastDecisionSync: '2026-10-15T00:00:00Z' });
  assert.equal(r.reports, 1);
  assert.match(sender.sent[0]!.text, /Operator · evening/);
});
