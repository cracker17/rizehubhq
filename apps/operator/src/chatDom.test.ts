import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comparable, composeSegments, isMe, mentionsMe, normalizeMessages, parseTimestamp, selectors, DEFAULT_SELECTORS } from './browser/chatDom';
import { cdpEndpointFor, loadOperatorConfig } from './config';
import { resolveCdpEndpoint } from './browser/cdp';

const ME = ['Julev', 'Julev Ajeto'];

test('timestamps: ms, µs, s and ISO; junk is null', () => {
  assert.equal(parseTimestamp('1760500000000'), '2025-10-15T03:46:40.000Z');
  assert.equal(parseTimestamp('1760500000000000'), '2025-10-15T03:46:40.000Z');
  assert.equal(parseTimestamp('1760500000'), '2025-10-15T03:46:40.000Z');
  assert.equal(parseTimestamp('2026-10-15T01:00:00Z'), '2026-10-15T01:00:00.000Z');
  assert.equal(parseTimestamp(''), null);
  assert.equal(parseTimestamp('yesterday-ish'), null);
});

test('me and mentions: display names, "You", @first name; no partial-word matches', () => {
  assert.equal(isMe('Julev Ajeto', ME), true);
  assert.equal(isMe('You', ME), true);
  assert.equal(isMe('Alex', ME), false);
  assert.equal(mentionsMe('@Julev Ajeto can you check?', ME), true);
  assert.equal(mentionsMe('thanks @julev', ME), true);
  assert.equal(mentionsMe('@Julevx hi', ME), false);
  assert.equal(mentionsMe('Julev did it', ME), false);
});

test('normalize: sender carries over grouped messages, empty rows drop, missing ids get a stable hash', () => {
  const raw = [
    { id: 'a1', sender: 'Alex', ts: '1760500000000', text: 'Can you update the team page?', thread: '' },
    { id: '', sender: '', ts: '1760500060000', text: 'And add Sam @Julev', thread: '' },
    { id: 'a3', sender: 'Julev Ajeto', ts: '1760500120000', text: 'On it', thread: '' },
    { id: 'a4', sender: 'Riley', ts: '', text: '   ', thread: '' },
    { id: 'a1', sender: 'Alex', ts: '1760500000000', text: 'Can you update the team page?', thread: '' },
  ];
  const out = normalizeMessages(raw, ME);
  assert.equal(out.length, 3);
  assert.equal(out[1]!.sender_name, 'Alex');
  assert.match(out[1]!.external_id, /^h:[0-9a-f]{32}$/);
  assert.equal(normalizeMessages(raw, ME)[1]!.external_id, out[1]!.external_id, 'same content → same id');
  assert.equal(out[1]!.mentions_me, true);
  assert.equal(out[2]!.from_me, true);
  assert.equal(out[0]!.sent_at, '2025-10-15T03:46:40.000Z');
});

test('compose: @mentions only for listed names (longest first), lines become breaks', () => {
  assert.deepEqual(composeSegments('Hi @Alex Smith, done.\nLink: x @Bob', ['Alex Smith', 'Alex']), [
    { kind: 'text', text: 'Hi ' }, { kind: 'mention', name: 'Alex Smith' }, { kind: 'text', text: ', done.' },
    { kind: 'newline' }, { kind: 'text', text: 'Link: x @Bob' },
  ]);
  assert.deepEqual(composeSegments('plain', []), [{ kind: 'text', text: 'plain' }]);
  assert.equal(comparable('Hi  @Alex Smith,\n done'), comparable('Hi Alex Smith, done'));
});

test('selectors: overrides replace defaults, blanks are ignored', () => {
  const s = selectors({ message: 'div.msg', composer: '  ' });
  assert.equal(s.message, 'div.msg');
  assert.equal(s.composer, DEFAULT_SELECTORS.composer);
});

test('config: defaults, minimums, CDP endpoint per profile', () => {
  const c = loadOperatorConfig({});
  assert.equal(c.enabled, false);
  assert.equal(c.pollMs, 120_000);
  assert.equal(c.sends, true);
  assert.equal(c.modelRole, 'specialist');
  assert.equal(loadOperatorConfig({ OPERATOR_POLL_MS: '5000', OPERATOR_SENDS: 'off', OPERATOR_MODEL_ROLE: 'nope' }).pollMs, 30_000);
  assert.equal(loadOperatorConfig({ OPERATOR_SENDS: 'off' }).sends, false);
  assert.throws(() => loadOperatorConfig({ OPERATOR_GCHAT_SELECTORS: '[1]x' }), /JSON object/);
  assert.equal(cdpEndpointFor('madam-muse', { OPERATOR_CDP_MADAM_MUSE: 'http://ws-mm:9223/' }), 'http://ws-mm:9223');
  assert.equal(cdpEndpointFor('lvlup', { OPERATOR_CDP_URL: 'http://ws:9223' }), 'http://ws:9223');
  assert.equal(cdpEndpointFor('lvlup', {}), null);
});

test('CDP endpoint: hostnames become IPs (Chrome refuses other Host headers); IPs and localhost stay', async () => {
  assert.equal(await resolveCdpEndpoint('http://ws-lvlup:9223', async () => '172.20.0.5'), 'http://172.20.0.5:9223');
  assert.equal(await resolveCdpEndpoint('http://127.0.0.1:9223/', async () => { throw new Error('no lookup'); }), 'http://127.0.0.1:9223');
  assert.equal(await resolveCdpEndpoint('http://localhost:9222', async () => { throw new Error('no lookup'); }), 'http://localhost:9222');
  await assert.rejects(resolveCdpEndpoint('ftp://x:1'), /http/);
});
