import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baselineFlags, conversationUrl, listSelectors, unreadConversations, type RawItem } from './browser/discover';
import { loadOperatorConfig } from './config';
import { Operator, type ChatDriver } from './operator';
import type { OperatorAccount, OperatorChannel, OperatorClient, OperatorDb } from './db';

const item = (p: Partial<RawItem>): RawItem => ({ name: 'x', href: '', id: '', count: '', unread: true, direct: false, ...p });

test('discover: conversation addresses from links or ids per app', () => {
  assert.equal(conversationUrl('slack', { href: '/client/T01/D07', id: '' }, 'https://app.slack.com/client/T01/C02'), 'https://app.slack.com/client/T01/D07');
  assert.equal(conversationUrl('slack', { href: '', id: 'C0ABC' }, 'https://app.slack.com/client/T01/C02'), 'https://app.slack.com/client/T01/C0ABC');
  assert.equal(conversationUrl('google_chat', { href: '', id: 'space/AAAAx1' }, 'https://chat.google.com/'), 'https://chat.google.com/room/AAAAx1');
  assert.equal(conversationUrl('google_chat', { href: '', id: 'dm/xyz_9' }, 'https://chat.google.com/'), 'https://chat.google.com/dm/xyz_9');
  assert.equal(conversationUrl('teams', { href: '', id: 'chat-list-item_19:abc@thread.v2' }, 'https://teams.microsoft.com/v2/'), 'https://teams.microsoft.com/l/chat/19%3Aabc%40thread.v2/0');
  assert.equal(conversationUrl('teams', { href: 'javascript:alert(1)', id: '' }, 'https://teams.microsoft.com/'), null);
  assert.equal(conversationUrl('google_chat', { href: '', id: 'weird' }, 'https://chat.google.com/'), null);
});

test('discover: only unread items, deduplicated, counts from badges, DMs flagged, capped', () => {
  const page = 'https://app.slack.com/client/T01/C02';
  const out = unreadConversations('slack', [
    item({ name: '#general', href: '/client/T01/C02', unread: false }),
    item({ name: 'Riley', href: '/client/T01/D07', count: '3', direct: true }),
    item({ name: 'Riley dup', href: '/client/T01/D07' }),
    item({ name: '#launch', href: '/client/T01/C09', count: '' }),
  ], page);
  assert.deepEqual(out, [
    { name: 'Riley', url: 'https://app.slack.com/client/T01/D07', unread: 3, direct: true },
    { name: '#launch', url: 'https://app.slack.com/client/T01/C09', unread: 1, direct: false },
  ]);
  assert.equal(unreadConversations('slack', Array.from({ length: 30 }, (_, i) => item({ href: `/client/T01/C${i}` })), page).length, 15);
  assert.equal(unreadConversations('google_chat', [item({ id: 'dm/abc' })], 'https://chat.google.com/')[0]!.direct, true);
});

test('discover: first read counts only the unread messages as new; later reads all new', () => {
  assert.deepEqual(baselineFlags(5, true, 2), [true, true, true, false, false]);
  assert.deepEqual(baselineFlags(3, true, undefined), [true, true, true], 'a manual channel: first read is history');
  assert.deepEqual(baselineFlags(2, true, 9), [false, false]);
  assert.deepEqual(baselineFlags(2, false, 1), [false, false]);
});

test('discover: selector overrides per kind from OPERATOR_DISCOVER_SELECTORS', () => {
  const cfg = loadOperatorConfig({ OPERATOR_DISCOVER_SELECTORS: '{"slack":{"item":".row"},"teams":{}}' });
  assert.equal(listSelectors('slack', cfg.discoverOverrides.slack).item, '.row');
  assert.notEqual(listSelectors('teams', cfg.discoverOverrides.teams).item, '.row');
  assert.throws(() => loadOperatorConfig({ OPERATOR_DISCOVER_SELECTORS: 'nope' }), /OPERATOR_DISCOVER_SELECTORS/);
});

test('sweep: unread conversations become channels and only their unread messages are stored as new; Gmail is one channel', async () => {
  const client: OperatorClient = { slug: 'lvlup', name: 'LvlUp', client_id: null, brain_project: null, profile: 'lvlup', my_names: ['Julev'], rules: '', enabled: true, paused: false };
  const accounts: OperatorAccount[] = [
    { id: 'a1', client_slug: 'lvlup', kind: 'slack', label: 'LvlUp Slack', home_url: 'https://app.slack.com/client/T01', enabled: true, last_swept_at: null, last_error: null },
    { id: 'a2', client_slug: 'lvlup', kind: 'gmail', label: 'LvlUp mail', home_url: 'https://mail.google.com/mail/u/0/#search/is%3Aunread', enabled: true, last_swept_at: null, last_error: null },
  ];
  const channels: OperatorChannel[] = [];
  const ingested: { ch: string; id: string; baseline: boolean | undefined }[] = [];
  const swept: [string, number, string | null][] = [];
  const db = {
    clients: async () => [client], channels: async () => channels, accounts: async () => accounts,
    discover: async (acc: string, name: string, url: string, direct: boolean) => {
      let ch = channels.find((c) => c.url === url);
      const created = !ch;
      if (!ch) {
        ch = { id: `ch${channels.length + 1}`, client_slug: 'lvlup', kind: acc === 'a1' ? 'slack' : 'gmail', name, url, enabled: true, last_seen_key: null, last_polled_at: null, last_error: null, direct, auto_discovered: true, account_id: acc };
        channels.push(ch);
      }
      return { channel_id: ch.id, created, enabled: ch.enabled };
    },
    ingest: async (ch: string, m: { external_id: string; baseline?: boolean }) => { ingested.push({ ch, id: m.external_id, baseline: m.baseline }); return m.baseline ? null : m.external_id; },
    channelPolled: async (id: string, key: string | null) => { const c = channels.find((x) => x.id === id)!; c.last_seen_key = key ?? c.last_seen_key; },
    accountSwept: async (id: string, n: number, e: string | null) => { swept.push([id, n, e]); },
  };
  const msgs = (ids: string[]) => ids.map((id) => ({ external_id: id, thread_key: null, sender_name: 'Riley', body: id, sent_at: null, mentions_me: false, from_me: false }));
  const chat: ChatDriver = {
    read: async () => { throw new Error('manual polling is not used here'); },
    send: async () => ({ sent: false }),
    sweep: async () => [{ name: 'Riley', url: 'https://app.slack.com/client/T01/D07', unread: 2, direct: true }],
    readAt: async (_c, acc, ch) => ({ title: ch.name, messages: msgs(acc.id === 'a1' ? ['m1', 'm2', 'm3', 'm4'] : ['g1', 'g2']) }),
  };
  let t = 1_000_000;
  const op = new Operator({ db: db as unknown as OperatorDb, chat, pollMs: 120_000, sends: false, now: () => t, log: () => undefined,
    gate: async () => ({ ok: false, reason: 'test' }), classify: async () => { throw new Error('no'); } });
  const stored = await op.sweepTick();
  assert.equal(stored, 4, 'Slack: the 2 unread (m3, m4); Gmail: both unread threads (cap 5)');
  assert.deepEqual(ingested.filter((x) => !x.baseline).map((x) => x.id), ['m3', 'm4', 'g1', 'g2']);
  assert.deepEqual(ingested.filter((x) => x.baseline).map((x) => x.id), ['m1', 'm2']);
  assert.deepEqual(swept, [['a1', 1, null], ['a2', 1, null]]);
  assert.equal(await op.sweepTick(), 0, 'not due again before OPERATOR_POLL_MS');
  t += 120_000;
  chat.sweep = async () => { throw new Error('signed out of Slack'); };
  await op.sweepTick();
  assert.deepEqual(swept.at(-2), ['a1', 0, 'signed out of Slack']);
  assert.equal(await op.watchTick(), 0, 'auto-discovered channels are not polled by the watcher');
});
