import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { handleHook } from './hooks';
import { parseWebhook, sendRequest, sendWhatsApp, verifyMetaSignature, whatsappToken, windowOpen, WhatsAppRefusal } from './whatsapp';

const SECRET = 'app-secret-123';
const sign = (b: Buffer) => `sha256=${createHmac('sha256', SECRET).update(b).digest('hex')}`;
const payload = {
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: '109876543210987' },
    contacts: [{ wa_id: '639171112222', profile: { name: 'Sam Lee' } }],
    messages: [
      { id: 'wamid.A1', from: '639171112222', timestamp: '1760500000', type: 'text', text: { body: 'Is the event on Friday?' } },
      { id: 'wamid.A2', from: '639171112222', timestamp: '1760500060', type: 'image', image: { caption: 'the venue' } },
      { id: 'wamid.A3', from: '639171112222', timestamp: '1760500070', type: 'reaction', reaction: { emoji: '👍' } },
    ],
    statuses: [{ id: 'wamid.OUT', status: 'delivered' }],
  } }] }],
};

test('whatsapp: Meta signature over the raw body', () => {
  const raw = Buffer.from(JSON.stringify(payload));
  assert.equal(verifyMetaSignature(raw, sign(raw), SECRET), true);
  assert.equal(verifyMetaSignature(Buffer.from(raw.toString() + ' '), sign(raw), SECRET), false);
  assert.equal(verifyMetaSignature(raw, 'sha256=00', SECRET), false);
  assert.equal(verifyMetaSignature(raw, undefined, SECRET), false);
  assert.equal(verifyMetaSignature(raw, sign(raw), ''), false);
});

test('whatsapp: webhook → messages (text, media with caption; reactions and statuses skipped)', () => {
  const m = parseWebhook(payload);
  assert.deepEqual(m.map((x) => [x.phoneId, x.msg.external_id, x.msg.thread_key, x.msg.sender_name, x.msg.body]), [
    ['109876543210987', 'wamid.A1', '639171112222', 'Sam Lee', 'Is the event on Friday?'],
    ['109876543210987', 'wamid.A2', '639171112222', 'Sam Lee', '[image] the venue'],
  ]);
  assert.equal(m[0]!.msg.sent_at, new Date(1760500000 * 1000).toISOString());
  assert.deepEqual(parseWebhook({ object: 'page', entry: [] }), []);
  assert.deepEqual(parseWebhook(null), []);
});

test('whatsapp: 24 h window, tokens per client, the Graph request quotes the customer', () => {
  const now = Date.parse('2026-10-17T12:00:00Z');
  assert.equal(windowOpen('2026-10-16T12:30:00Z', now), true);
  assert.equal(windowOpen('2026-10-16T11:59:00Z', now), false);
  assert.equal(windowOpen(null, now), false);
  assert.equal(whatsappToken({ OPERATOR_WHATSAPP_TOKEN: 'shared', OPERATOR_WHATSAPP_TOKEN_LVLUP: 'own' }, 'lvlup'), 'own');
  assert.equal(whatsappToken({ OPERATOR_WHATSAPP_TOKEN: 'shared' }, 'madam-muse'), 'shared');
  assert.equal(whatsappToken({}, 'lvlup'), null);
  const r = sendRequest({ env: {}, phoneId: '109876543210987', to: '639171112222', text: 'Yes, Friday 6 pm!', replyTo: 'wamid.A1', token: 't' });
  assert.equal(r.url, 'https://graph.facebook.com/v23.0/109876543210987/messages');
  const body = JSON.parse(String(r.init.body));
  assert.deepEqual([body.to, body.text.body, body.context.message_id], ['639171112222', 'Yes, Friday 6 pm!', 'wamid.A1']);
  assert.equal(JSON.parse(String(sendRequest({ env: { OPERATOR_WHATSAPP_GRAPH_VERSION: 'v24.0' }, phoneId: '1', to: '2', text: 'x', replyTo: 'h:none', token: 't' }).init.body)).context, undefined);
  assert.match(sendRequest({ env: { OPERATOR_WHATSAPP_GRAPH_VERSION: 'v24.0' }, phoneId: '1', to: '2', text: 'x', replyTo: null, token: 't' }).url, /\/v24\.0\//);
});

test('whatsapp send: refuses outside the window or without a contact/token (final), stops on a pause, maps API errors', async () => {
  const now = Date.parse('2026-10-17T12:00:00Z');
  const calls: string[] = [];
  const base = {
    env: { OPERATOR_WHATSAPP_TOKEN: 'secret-token' }, client: 'lvlup', phoneId: '109876543210987', to: '639171112222', text: 'Yes!', replyTo: 'wamid.A1',
    lastInbound: async () => '2026-10-17T08:00:00Z', lastCheck: async () => null, maySent: (m: string) => new Error(`MAYBE ${m}`), now,
    fetch: (async (url: string) => { calls.push(url); return new Response(JSON.stringify({ messages: [{ id: 'wamid.OUT1' }] }), { status: 200 }); }) as unknown as typeof fetch,
  };
  assert.deepEqual(await sendWhatsApp(base), { sent: true, quoted: true, inThread: false, mentionsLinked: 0, wamid: 'wamid.OUT1' });
  await assert.rejects(sendWhatsApp({ ...base, lastInbound: async () => '2026-10-15T08:00:00Z' }), (e: Error) => e instanceof WhatsAppRefusal && /24 h window/.test(e.message) && (e as WhatsAppRefusal).final);
  await assert.rejects(sendWhatsApp({ ...base, to: null }), /no WhatsApp contact/);
  await assert.rejects(sendWhatsApp({ ...base, env: {} }), /no WhatsApp access token/);
  assert.deepEqual((await sendWhatsApp({ ...base, lastCheck: async () => 'operator paused' })).sent, false);
  assert.equal(calls.length, 1, 'nothing else reached Meta');
  await assert.rejects(sendWhatsApp({ ...base, fetch: (async () => new Response(JSON.stringify({ error: { code: 131047, message: 'Re-engagement message secret-token' } }), { status: 400 })) as unknown as typeof fetch }),
    (e: Error) => /WhatsApp API 400 \(131047\)/.test(e.message) && !e.message.includes('secret-token'));
  await assert.rejects(sendWhatsApp({ ...base, fetch: (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch }), /^Error: MAYBE|MAYBE WhatsApp did not answer/);
});

test('webhook handler: verification handshake, signature first, ingest each message, 500 asks Meta to retry', async () => {
  const stored: string[] = [];
  const d = { appSecret: SECRET, verifyToken: 'verify-me', ingest: async (m: { msg: { external_id: string } }) => { stored.push(m.msg.external_id); return 'id'; } };
  const q = (s: string) => new URLSearchParams(s);
  assert.deepEqual(await handleHook(d as never, { method: 'GET', path: '/hooks/whatsapp', query: q('hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42'), headers: {}, body: Buffer.alloc(0) }), { status: 200, body: '42' });
  assert.equal((await handleHook(d as never, { method: 'GET', path: '/hooks/whatsapp', query: q('hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42'), headers: {}, body: Buffer.alloc(0) })).status, 403);
  const raw = Buffer.from(JSON.stringify(payload));
  assert.equal((await handleHook(d as never, { method: 'POST', path: '/hooks/whatsapp', query: q(''), headers: { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) }, body: raw })).status, 401);
  assert.deepEqual(stored, [], 'a bad signature stores nothing');
  assert.equal((await handleHook(d as never, { method: 'POST', path: '/hooks/whatsapp', query: q(''), headers: { 'x-hub-signature-256': sign(raw) }, body: raw })).status, 200);
  assert.deepEqual(stored, ['wamid.A1', 'wamid.A2']);
  const failing = { ...d, ingest: async () => { throw new Error('db down'); } };
  assert.equal((await handleHook(failing as never, { method: 'POST', path: '/hooks/whatsapp', query: q(''), headers: { 'x-hub-signature-256': sign(raw) }, body: raw })).status, 500);
  assert.equal((await handleHook(d as never, { method: 'POST', path: '/other', query: q(''), headers: {}, body: raw })).status, 404);
});
