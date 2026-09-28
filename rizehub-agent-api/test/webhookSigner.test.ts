import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliverWebhook, newEvent, signBody, signWebhook, verifyWebhook } from '../src/webhookSigner.ts';
import { MemoryIdempotencyStore, checkIdempotency, rememberResponse, requestFingerprint } from '../src/idempotency.ts';

const SECRET = 'whsec_test_123';

test('shared test vector: HQ (apps/worker/src/rizehub/webhook.test.ts) checks the same bytes and signature', () => {
  const body = '{"id":"evt_1","event":"job.completed","created_at":"2026-09-28T02:00:00Z","data":{"job_id":"job_1","type":"lead_search","status":"completed","result":{"lead_ids":["ld_1001"],"total":1}}}';
  assert.equal(signBody(body, SECRET), 'e14135d083b36c0dcc829e245cf55b94bab8aee1113f7adff3f8e1d3d17ec77f');
  assert.equal(verifyWebhook(body, 'sha256=e14135d083b36c0dcc829e245cf55b94bab8aee1113f7adff3f8e1d3d17ec77f', '1790560800', SECRET, 1790560800_000), true);
});

test('signWebhook signs exactly the bytes it returns; tampering, old timestamps and wrong secrets fail', () => {
  const now = Date.parse('2026-09-28T02:00:00Z');
  const e = newEvent('client.signed_up', { account_id: 'acc_1', company: 'Kinfolk Candle Studio', package: 'shopify-growth' }, new Date(now));
  assert.match(e.id, /^evt_[0-9a-f]{24}$/);
  const { body, headers } = signWebhook(e, SECRET, now);
  assert.equal(headers['x-rizehub-timestamp'], String(now / 1000));
  assert.equal(verifyWebhook(body, headers['x-rizehub-signature']!, headers['x-rizehub-timestamp']!, SECRET, now), true);
  assert.equal(verifyWebhook(body.replace('Kinfolk', 'Kinf0lk'), headers['x-rizehub-signature']!, headers['x-rizehub-timestamp']!, SECRET, now), false);
  assert.equal(verifyWebhook(body, headers['x-rizehub-signature']!, headers['x-rizehub-timestamp']!, SECRET, now + 301_000), false);
  assert.equal(verifyWebhook(body, headers['x-rizehub-signature']!, headers['x-rizehub-timestamp']!, 'other', now), false);
  assert.throws(() => signWebhook(e, ''), /secret is required/);
});

test('deliverWebhook retries 5xx/network with backoff (same event id, fresh timestamp) and stops on 4xx', async () => {
  const e = newEvent('job.completed', { job_id: 'job_1' });
  const seen: { body: string; ts: string }[] = [];
  const statuses = [503, 0, 200];
  let t = 1_790_560_800_000;
  const sleeps: number[] = [];
  const res = await deliverWebhook('http://hq/hooks/rizehub', e, SECRET, {
    fetch: async (_u, init) => {
      seen.push({ body: init.body, ts: init.headers['x-rizehub-timestamp']! });
      const s = statuses.shift()!;
      if (s === 0) throw new Error('ECONNREFUSED');
      return { ok: s < 300, status: s };
    },
    sleep: async (ms) => { sleeps.push(ms); t += ms; }, now: () => t, baseDelayMs: 1000,
  });
  assert.deepEqual(res, { ok: true, attempts: 3, status: 200 });
  assert.deepEqual(sleeps, [1000, 2000]);
  assert.ok(seen.every((s) => JSON.parse(s.body).id === e.id));
  assert.notEqual(seen[0]!.ts, seen[2]!.ts);

  const rejected = await deliverWebhook('http://hq/hooks/rizehub', e, SECRET, { fetch: async () => ({ ok: false, status: 401 }), sleep: async () => {} });
  assert.deepEqual(rejected, { ok: false, attempts: 1, status: 401 });
});

test('idempotency: replay the first result, conflict on a different body, 5xx not remembered', async () => {
  const store = new MemoryIdempotencyStore();
  const fp = requestFingerprint('POST', '/accounts', false, { company: 'A', plan: 'x' });
  assert.equal(fp, requestFingerprint('post', '/accounts', false, { plan: 'x', company: 'A' })); // key order doesn't matter
  assert.notEqual(fp, requestFingerprint('POST', '/accounts', true, { company: 'A', plan: 'x' })); // dry run is a different request
  assert.deepEqual(await checkIdempotency(store, 'k1', 't1:account', fp), { action: 'run' });
  await rememberResponse(store, 'k1', 't1:account', fp, 201, { id: 'acc_1' });
  assert.deepEqual(await checkIdempotency(store, 'k1', 't1:account', fp), { action: 'replay', status: 201, body: { id: 'acc_1' } });
  const other = requestFingerprint('POST', '/accounts', false, { company: 'B', plan: 'x' });
  assert.equal((await checkIdempotency(store, 'k1', 't1:account', other)).action, 'conflict');
  assert.deepEqual(await checkIdempotency(store, 'k2', 't1:account', other), { action: 'run' }); // scoped per API key
  await rememberResponse(store, 'k1', 't1:workspace', fp, 503, {});
  assert.deepEqual(await checkIdempotency(store, 'k1', 't1:workspace', fp), { action: 'run' });
});
