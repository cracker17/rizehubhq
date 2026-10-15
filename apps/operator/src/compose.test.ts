import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeSelectors, composeUrl, sendTestText, testSeen } from './browser/compose';
import { Operator, type ChatDriver } from './operator';
import type { OperatorDb } from './db';

test('compose: where to reply (Gmail needs the thread), overrides per kind', () => {
  assert.equal(composeUrl('slack', 'https://app.slack.com/client/T1/D2', null), 'https://app.slack.com/client/T1/D2');
  assert.equal(composeUrl('gmail', 'https://mail.google.com/mail/u/0/#search/is%3Aunread', '18f2c3d4e5f6a7b8'), 'https://mail.google.com/mail/u/0/#all/18f2c3d4e5f6a7b8');
  assert.equal(composeUrl('gmail', 'https://mail.google.com/mail/u/0/#inbox', null), null);
  assert.equal(composeUrl('gmail', 'https://mail.google.com/mail/u/0/#inbox', '../evil'), null);
  assert.equal(composeSelectors('slack', { composeBox: '.box', message: 'ignored' }).composeBox, '.box');
  assert.equal(composeSelectors('gmail').composeSendKey, 'ControlOrMeta+Enter');
});

test('send test: a unique message that must come back when the chat is read again', () => {
  const t = sendTestText(Date.parse('2026-10-17T03:04:05Z'));
  assert.match(t, /^HQ operator send test 2026-10-17 03:04 #/);
  assert.notEqual(t, sendTestText(Date.parse('2026-10-17T03:04:06Z')));
  assert.equal(testSeen([{ body: 'older' }, { body: `Julev: ${t}` }], t), true);
  assert.equal(testSeen([{ body: 'HQ operator send test 2026-10-16 01:00 #abc' }], t), false);
});

test('send test tick: claims one, runs it in the client browser, records pass / fail; never with sends off', async () => {
  const done: [string, string, boolean, string][] = [];
  let queue = [{ client_slug: 'lvlup', kind: 'slack' as const, test_url: 'https://app.slack.com/client/T1/D2' }];
  const db = {
    clients: async () => [{ slug: 'lvlup', name: 'LvlUp', client_id: null, brain_project: null, profile: 'lvlup', my_names: ['Julev'], rules: '', enabled: true, paused: false }],
    channels: async () => [],
    claimSendTest: async () => queue.shift() ?? null,
    sendTestDone: async (c: string, k: string, ok: boolean, d: string) => { done.push([c, k, ok, d]); return ok ? 'passed' : 'failed'; },
  };
  let outcome: { ok: boolean; detail: string } | Error = { ok: true, detail: 'posted and read back' };
  const chat: ChatDriver = { read: async () => ({ title: '', messages: [] }), send: async () => ({ sent: false }),
    sendTest: async () => { if (outcome instanceof Error) throw outcome; return outcome; } };
  const mk = (sends: boolean) => new Operator({ db: db as unknown as OperatorDb, chat, pollMs: 120_000, sends, log: () => undefined,
    gate: async () => ({ ok: false, reason: 'x' }), classify: async () => { throw new Error('no'); } });
  assert.equal(await mk(false).sendTestTick(), null, 'OPERATOR_SENDS=off: a test would post, so it waits');
  assert.equal(await mk(true).sendTestTick(), 'passed');
  queue = [{ client_slug: 'lvlup', kind: 'slack', test_url: 'https://app.slack.com/client/T1/D2' }];
  outcome = new Error('no slack composer found');
  assert.equal(await mk(true).sendTestTick(), 'failed');
  assert.deepEqual(done.map((d) => [d[2], d[3]]), [[true, 'posted and read back'], [false, 'no slack composer found']]);
  assert.equal(await mk(true).sendTestTick(), null);
});
