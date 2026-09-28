import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RizehubClient, RizehubError, idempotencyKey, isDryRun } from './client';
import { MOCK_KEYS, MockRizehub, mockFetch } from './mock';

const ctx = { taskId: 't-123', agentId: 'prospector' };

function recordingFetch(responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses[calls.length - 1];
    if (!r) throw new Error('no more responses');
    if (r instanceof Error) throw r;
    return r;
  };
  return { f, calls };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const hdr = (init: RequestInit, name: string) => new Headers(init.headers).get(name);

test('writes send auth, audit headers and Idempotency-Key = taskId:step; dry runs get a separate key', async () => {
  const { f, calls } = recordingFetch([json(202, { job_id: 'job_1', status: 'queued' }), json(200, { dry_run: true, valid: true, would: {}, warnings: [] })]);
  const c = new RizehubClient({ baseUrl: 'http://rz/agent-api/v1/', keys: { LEADS: 'k-leads', ONBOARDING: 'k-onb' }, fetch: f, sleep: async () => {} });
  const acc = await c.searchLeads(ctx, { platform: 'shopify', limit: 5 }, 'search-1');
  assert.equal(acc.job_id, 'job_1');
  assert.equal(calls[0]!.url, 'http://rz/agent-api/v1/leads/search');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal(hdr(calls[0]!.init, 'authorization'), 'Bearer k-leads');
  assert.equal(hdr(calls[0]!.init, 'x-hq-task-id'), 't-123');
  assert.equal(hdr(calls[0]!.init, 'x-hq-agent-id'), 'prospector');
  assert.equal(hdr(calls[0]!.init, 'idempotency-key'), 't-123:search-1');
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { platform: 'shopify', limit: 5 });

  const dry = await c.createAccount(ctx, { company: 'X', primary_contact: { name: 'A', email: 'a@x.co' }, plan: 'seo-retainer' }, { dryRun: true });
  assert.ok(isDryRun(dry));
  assert.match(calls[1]!.url, /\/accounts\?dry_run=true$/);
  assert.equal(hdr(calls[1]!.init, 'authorization'), 'Bearer k-onb');
  assert.equal(hdr(calls[1]!.init, 'idempotency-key'), 't-123:account:dry_run');
  assert.equal(idempotencyKey('t', 's'), 't:s');
});

test('reads send no Idempotency-Key; GET path params are encoded', async () => {
  const { f, calls } = recordingFetch([json(200, { id: 'a/b' })]);
  const c = new RizehubClient({ baseUrl: 'http://rz/agent-api/v1', keys: { READONLY: 'k-ro' }, fetch: f });
  await c.getAccount(ctx, 'a/b');
  assert.equal(calls[0]!.url, 'http://rz/agent-api/v1/accounts/a%2Fb');
  assert.equal(hdr(calls[0]!.init, 'idempotency-key'), null);
});

test('429 honours Retry-After, 5xx and network errors back off, then succeed', async () => {
  const sleeps: number[] = [];
  const { f, calls } = recordingFetch([
    json(429, { error: { code: 'rate_limited', message: 'slow down', retryable: true } }, { 'retry-after': '2', 'x-ratelimit-remaining': '0' }),
    json(503, { error: { code: 'unavailable', message: 'deploying', retryable: true } }),
    new TypeError('fetch failed'),
    json(200, { id: 'ld_1' }),
  ]);
  const limits: unknown[] = [];
  const c = new RizehubClient({ baseUrl: 'http://rz/agent-api/v1', keys: { LEADS: 'k' }, fetch: f, sleep: async (ms) => { sleeps.push(ms); }, retryBaseMs: 100, onRateLimit: (i) => limits.push(i) });
  const lead = await c.getLead(ctx, 'ld_1');
  assert.equal(lead.id, 'ld_1');
  assert.equal(calls.length, 4);
  assert.equal(sleeps[0], 2000);
  assert.ok(sleeps[1]! >= 200 && sleeps[1]! < 300, `2nd backoff ${sleeps[1]}`);
  assert.ok(sleeps[2]! >= 400 && sleeps[2]! < 600, `3rd backoff ${sleeps[2]}`);
  assert.deepEqual(limits[0], { remaining: 0, resetSec: null });
});

test('non-retryable errors map to {code, message, retryable} without retrying', async () => {
  const { f, calls } = recordingFetch([json(409, { error: { code: 'workspace_exists', message: 'Madam Muse already has one', retryable: false } })]);
  const c = new RizehubClient({ baseUrl: 'http://rz/agent-api/v1', keys: { ONBOARDING: 'k' }, fetch: f, sleep: async () => {} });
  await assert.rejects(c.createWorkspace(ctx, 'acc_1', { template: 'seo-retainer', name: 'MM' }), (e: unknown) => {
    assert.ok(e instanceof RizehubError);
    assert.deepEqual(e.toJSON(), { code: 'workspace_exists', message: 'Madam Muse already has one', retryable: false });
    assert.equal(e.status, 409);
    return true;
  });
  assert.equal(calls.length, 1);
});

test('gives up after maxRetries; non-JSON error bodies get http_<status>', async () => {
  const { f, calls } = recordingFetch([new Response('<html>bad gateway</html>', { status: 502 }), new Response('nope', { status: 502 })]);
  const c = new RizehubClient({ baseUrl: 'http://rz/agent-api/v1', keys: { READONLY: 'k' }, fetch: f, sleep: async () => {}, maxRetries: 1 });
  await assert.rejects(c.getJob(ctx, 'job_1'), { code: 'http_502', retryable: true });
  assert.equal(calls.length, 2);
});

test('a missing key or missing task context fails fast', async () => {
  const c = new RizehubClient({ baseUrl: 'http://rz/agent-api/v1', keys: {}, fetch: async () => { throw new Error('should not be called'); } });
  await assert.rejects(c.getLead(ctx, 'x'), { code: 'missing_key' });
  const c2 = new RizehubClient({ baseUrl: 'http://rz/agent-api/v1', keys: { LEADS: 'k' }, fetch: async () => { throw new Error('should not be called'); } });
  await assert.rejects(c2.getLead({ taskId: '', agentId: 'x' }, 'x'), { code: 'missing_context' });
});

test('waitForJob polls with growing delays until the job completes (against the mock)', async () => {
  let now = 1_000_000;
  const mock = new MockRizehub({ jobDelayMs: 3_000, now: () => now });
  const sleeps: number[] = [];
  const c = new RizehubClient({ baseUrl: 'http://rz/agent-api/v1', keys: MOCK_KEYS, fetch: mockFetch(mock), sleep: async (ms) => { sleeps.push(ms); now += ms; } });
  const acc = await c.searchLeads(ctx, { platform: 'shopify', location: 'Australia', signals: ['slow_site'], limit: 5 });
  const job = await c.waitForJob(ctx, acc.job_id, 'LEADS', { timeoutMs: 60_000, pollMs: 500 });
  assert.equal(job.status, 'completed');
  assert.ok(job.result!.lead_ids!.length > 0);
  assert.deepEqual(sleeps.slice(0, 3), [500, 800, 1280]);
  // a timeout returns the unfinished job instead of throwing
  const acc2 = await c.searchLeads(ctx, { platform: 'webflow' }, 'second');
  const pending = await c.waitForJob(ctx, acc2.job_id, 'LEADS', { timeoutMs: 100 });
  assert.notEqual(pending.status, 'completed');
});
