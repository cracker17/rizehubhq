import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ago, chatUrl, describeAction, isOnline, sendState, visibleInbox, type OperatorActionRow, type OperatorInboxRow } from './operatorView';

const act = (action: string, detail: Record<string, unknown> = {}, ok = true): OperatorActionRow =>
  ({ id: 1, created_at: '2026-10-15T00:00:00Z', client_slug: 'lvlup', inbox_id: null, actor: 'operator', action, ok, detail });

test('feed lines are plain words for every step the operator logs', () => {
  assert.equal(describeAction(act('message.new', { sender: 'Alex', channel: 'Alex, Riley' })).text, 'New message from Alex in Alex, Riley');
  assert.equal(describeAction(act('message.new', { baseline: true, channel: 'X' })).tone, 'muted');
  assert.equal(describeAction(act('message.classified', { category: 'task', confidence: 0.82 })).text, 'Drafted a task reply · 82%');
  assert.equal(describeAction(act('browser.typed', { chars: 40, mentions_linked: 2 })).text, 'Typed 40 characters with 2 @mention(s)');
  assert.equal(describeAction(act('send.done')).kind, 'send');
  assert.equal(describeAction(act('watch.failed', { channel: 'X', error: 'signed out' }, false)).tone, 'danger');
  assert.equal(describeAction(act('something.new', {}, false)).tone, 'danger');
});

test('send state: kill switch beats office pause beats live', () => {
  assert.equal(sendState({ killSwitch: true, officePaused: true, autoSend: true }).label, 'Sends stopped');
  assert.equal(sendState({ killSwitch: false, officePaused: true, autoSend: true }).label, 'Office paused');
  assert.equal(sendState({ killSwitch: false, officePaused: false, autoSend: false }).label, 'Live · every reply asks');
});

test('online = heartbeat within 3 minutes; ago reads naturally', () => {
  const now = Date.parse('2026-10-15T01:00:00Z');
  assert.equal(isOnline('2026-10-15T00:58:30Z', now), true);
  assert.equal(isOnline('2026-10-15T00:56:00Z', now), false);
  assert.equal(isOnline(null, now), false);
  assert.equal(ago('2026-10-15T00:50:00Z', now), '10 min ago');
  assert.equal(ago(null, now), 'never');
});

test('inbox hides baseline history and your own messages; chat addresses are checked', () => {
  const row = (id: string, p: Partial<OperatorInboxRow>): OperatorInboxRow => ({ id, client_slug: 'lvlup', channel_id: 'c', sender_name: 'A', body: 'b', sent_at: null,
    created_at: `2026-10-15T00:0${id}:00Z`, status: 'fyi', category: null, mode: null, draft: null, final_text: null, approval_id: null, error: null,
    mentions_me: false, from_me: false, space_name: null, ...p });
  const v = visibleInbox([row('1', {}), row('2', { status: 'fyi', category: 'fyi' }), row('3', { from_me: true }), row('4', { status: 'drafted', category: 'reply' })]);
  assert.deepEqual(v.map((r) => r.id), ['4', '2']);
  assert.equal(chatUrl(' https://chat.google.com/room/AAQA '), 'https://chat.google.com/room/AAQA');
  assert.equal(chatUrl('https://mail.google.com/chat/u/0/#chat/space/AAQA'), 'https://mail.google.com/chat/u/0/#chat/space/AAQA');
  assert.equal(chatUrl('https://evil.example/chat.google.com/'), null);
});

test('jobs: open first (oldest first), then finished newest first; money formatting; task text', async () => {
  const { sortJobs, usd, taskBrief, JOB_STATUS } = await import('./operatorView');
  const j = (id: string, status: string, created: string, updated: string) => ({ id, status, created_at: created, updated_at: updated }) as never;
  const out = sortJobs([j('done-old', 'done', '01', '02'), j('run', 'running', '05', '06'), j('q', 'queued', '03', '03'), j('done-new', 'escalated', '04', '09')]);
  assert.deepEqual(out.map((x: { id: string }) => x.id), ['q', 'run', 'done-new', 'done-old']);
  assert.equal(usd('0.4'), '$0.40');
  assert.equal(usd(0), '$0');
  assert.equal(taskBrief('  ok '), null);
  assert.equal(taskBrief('  Fix the footer '), 'Fix the footer');
  assert.equal(JOB_STATUS.waiting.label, 'Needs your OK');
});

test('autonomy: a client rule wins over the default; risky types cannot be auto; credentials only never', async () => {
  const { autonomyFor, allowedModes } = await import('./operatorView');
  const rows = [
    { client_slug: '*', action_type: 'ack', mode: 'auto' as const },
    { client_slug: '*', action_type: 'money', mode: 'approve' as const },
    { client_slug: 'lvlup', action_type: 'money', mode: 'never' as const },
  ];
  const lv = autonomyFor(rows, 'lvlup');
  assert.deepEqual(lv.find((r) => r.type === 'money'), { type: 'money', mode: 'never', own: true });
  assert.deepEqual(lv.find((r) => r.type === 'ack'), { type: 'ack', mode: 'auto', own: false });
  assert.equal(lv.find((r) => r.type === 'reply')!.mode, 'approve', 'no row anywhere = approve');
  assert.equal(autonomyFor(rows, '*').find((r) => r.type === 'money')!.mode, 'approve');
  assert.deepEqual(allowedModes('ack'), ['auto', 'approve', 'never']);
  assert.deepEqual(allowedModes('publish'), ['approve', 'never']);
  assert.deepEqual(allowedModes('credentials'), ['never']);
  assert.equal(describeAction(act('autonomy.changed', { action_type: 'money', now: 'never', client: 'lvlup' })).text, 'Rule changed: money → never');
});

test('digest times: defaults, off, junk', async () => {
  const { digestTimes } = await import('./operatorView');
  assert.deepEqual(digestTimes(undefined), { morning: '08:00', evening: '18:00' });
  assert.deepEqual(digestTimes({ morning: '07:30', evening: 'off' }), { morning: '07:30', evening: null });
  assert.deepEqual(digestTimes({ morning: '7:30' }), { morning: null, evening: '18:00' });
});

test('channel addresses per kind (mirrors operator_channel_url_ok)', async () => {
  const { channelUrl } = await import('./operatorView');
  assert.equal(channelUrl('slack', ' https://app.slack.com/client/T01/C02 '), 'https://app.slack.com/client/T01/C02');
  assert.equal(channelUrl('slack', 'https://lvlup.slack.com/archives/C02'), 'https://lvlup.slack.com/archives/C02');
  assert.equal(channelUrl('slack', 'https://chat.google.com/room/A'), null);
  assert.equal(channelUrl('gmail', 'https://mail.google.com/mail/u/0/#label/LvlUp'), 'https://mail.google.com/mail/u/0/#label/LvlUp');
  assert.equal(channelUrl('teams', 'https://teams.microsoft.com/l/chat/19:abc/0'), 'https://teams.microsoft.com/l/chat/19:abc/0');
  assert.equal(channelUrl('teams', 'http://teams.microsoft.com/x'), null);
  assert.equal(channelUrl('google_chat', 'https://chat.google.com/room/A'), 'https://chat.google.com/room/A');
});

test('WhatsApp numbers become wa.me addresses', async () => {
  const { channelUrl } = await import('./operatorView');
  assert.equal(channelUrl('whatsapp', '+63 917 555 0101'), 'https://wa.me/639175550101');
  assert.equal(channelUrl('whatsapp', '12'), null);
});

test('email senders box: one per line or comma, lowercase, no duplicates, no 1-letter junk', async () => {
  const { parseTargets } = await import('./operatorView');
  assert.deepEqual(parseTargets(' @LvlUp.vc \nRiley Chen, alex@lvlup.vc;@lvlup.vc\nx\n'), ['@lvlup.vc', 'riley chen', 'alex@lvlup.vc']);
});
