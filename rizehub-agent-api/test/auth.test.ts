import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FixedWindowRateLimiter, authenticateAgentRequest, generateApiKey, hashApiKey,
  type ApiKeyRecord, type AuditEntry, type AuthDeps,
} from '../src/auth.ts';
import { KEY_GROUP_SCOPES, ROUTES, matchRoute } from '../src/scopes.ts';

function deps(records: ApiKeyRecord[], limit = 100) {
  const audit: AuditEntry[] = [];
  const touched: string[] = [];
  const d: AuthDeps = {
    keys: { findByHash: async (h) => records.find((r) => r.keyHash === h) ?? null, touch: async (id) => { touched.push(id); } },
    audit: { record: (e) => { audit.push(e); } },
    rateLimiter: new FixedWindowRateLimiter(limit),
    now: () => new Date('2026-09-28T02:00:00Z'),
  };
  return { d, audit, touched };
}
const LEADS = generateApiKey('rzh_test');
const RO = generateApiKey('rzh_test');
const REVOKED = generateApiKey('rzh_test');
const keys: ApiKeyRecord[] = [
  { id: 'k1', label: 'hq-leads', keyHash: LEADS.keyHash, scopes: KEY_GROUP_SCOPES.LEADS, revokedAt: null, lastUsedAt: null },
  { id: 'k2', label: 'hq-readonly', keyHash: RO.keyHash, scopes: KEY_GROUP_SCOPES.READONLY, revokedAt: null, lastUsedAt: null },
  { id: 'k3', label: 'hq-old', keyHash: REVOKED.keyHash, scopes: KEY_GROUP_SCOPES.LEADS, revokedAt: '2026-09-01T00:00:00Z', lastUsedAt: null },
];
const H = (key: string | null, extra: Record<string, string> = {}) => ({
  ...(key ? { authorization: `Bearer ${key}` } : {}), 'x-hq-task-id': '7d1c0e7e-2f7e-4b53-9a57-1c0b6f1e9a10', 'x-hq-agent-id': 'prospector', ...extra,
});

test('keys: generated keys are random, only the sha256 hash is stored', () => {
  const a = generateApiKey(); const b = generateApiKey();
  assert.notEqual(a.key, b.key);
  assert.match(a.key, /^rzh_live_[A-Za-z0-9_-]{32}$/);
  assert.equal(a.keyHash, hashApiKey(a.key));
  assert.equal(hashApiKey('rzh_test_leads_4f8a2c'), '919585c501daad3ea893db181cb7bc6e881278c3bbcbc0b8926662d22a5b3b0c');
});

test('allowed request: scope ok, HQ ids returned, audit row written, last_used touched, rate headers', async () => {
  const { d, audit, touched } = deps(keys);
  const r = await authenticateAgentRequest({ method: 'POST', path: '/agent-api/v1/leads/search', headers: H(LEADS.key, { 'idempotency-key': 't1:leads_search' }) }, d);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.route.scope, 'leads:search');
  assert.deepEqual(r.hq, { taskId: '7d1c0e7e-2f7e-4b53-9a57-1c0b6f1e9a10', agentId: 'prospector' });
  assert.equal(r.idempotencyKey, 't1:leads_search');
  assert.equal(r.headers['x-ratelimit-limit'], '100');
  assert.equal(audit[0]!.outcome, 'allowed');
  assert.equal(audit[0]!.keyLabel, 'hq-leads');
  assert.equal(audit[0]!.hqAgentId, 'prospector');
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(touched, ['k1']);
});

test('refusals: no key 401, unknown 401, revoked 401, missing HQ headers 400, wrong scope 403, write without Idempotency-Key 400, unknown route 404', async () => {
  const { d, audit } = deps(keys);
  const call = (method: string, path: string, headers: Record<string, string>, query = '') =>
    authenticateAgentRequest({ method, path, headers, query: new URLSearchParams(query) }, d);
  const code = async (p: ReturnType<typeof call>) => { const r = await p; return r.ok ? 200 : `${r.status} ${r.error.code}`; };
  assert.equal(await code(call('GET', '/leads/ld_1', H(null))), '401 unauthorized');
  assert.equal(await code(call('GET', '/leads/ld_1', H('rzh_nope'))), '401 unauthorized');
  assert.equal(await code(call('GET', '/leads/ld_1', H(REVOKED.key))), '401 unauthorized');
  assert.equal(await code(call('GET', '/leads/ld_1', { authorization: `Bearer ${LEADS.key}` })), '400 missing_hq_headers');
  assert.equal(await code(call('GET', '/leads/ld_1', H(LEADS.key, { 'x-hq-agent-id': 'bad agent!' }))), '400 missing_hq_headers');
  assert.equal(await code(call('POST', '/accounts', H(LEADS.key, { 'idempotency-key': 'x' }))), '403 forbidden');
  assert.equal(await code(call('POST', '/leads/ld_1/notes', H(LEADS.key))), '400 missing_idempotency_key');
  assert.equal(await code(call('DELETE', '/leads/ld_1', H(LEADS.key))), '404 not_found');
  // READONLY: every GET, no writes
  assert.equal(await code(call('GET', '/reports/rpt_1', H(RO.key))), 200);
  assert.equal(await code(call('GET', '/workspaces/ws_1/metrics', H(RO.key), 'from=2026-09-01&to=2026-09-30')), 200);
  assert.equal(await code(call('POST', '/reports/rpt_1/publish', H(RO.key, { 'idempotency-key': 'x' }))), '403 forbidden');
  assert.ok(audit.every((a) => a.at === '2026-09-28T02:00:00.000Z'));
  assert.equal(audit.filter((a) => a.outcome === 'forbidden').length, 2);
});

test('dry_run flag is surfaced; rate limit → 429 with Retry-After and retryable error', async () => {
  const { d } = deps(keys, 2);
  const req = { method: 'POST', path: '/accounts', headers: H(LEADS.key, { 'idempotency-key': 'a' }), query: new URLSearchParams('dry_run=true') };
  const ro = { method: 'GET', path: '/accounts/acc_1', headers: H(RO.key), query: new URLSearchParams() };
  const first = await authenticateAgentRequest(ro, d);
  assert.ok(first.ok);
  await authenticateAgentRequest(ro, d);
  const limited = await authenticateAgentRequest(ro, d);
  assert.equal(limited.ok, false);
  if (!limited.ok) {
    assert.equal(limited.status, 429);
    assert.equal(limited.error.retryable, true);
    assert.ok(Number(limited.headers['retry-after']) > 0);
  }
  const onb = { ...keys[0]!, scopes: KEY_GROUP_SCOPES.ONBOARDING };
  const r = await authenticateAgentRequest(req, deps([onb]).d);
  assert.ok(r.ok && r.dryRun);
});

test('route table covers every endpoint in openapi.yaml', async () => {
  const fs = await import('node:fs');
  const spec = fs.readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8');
  const paths = [...spec.matchAll(/^  (\/[^:\s]+):\s*$/gm)].map((m) => m[1]!);
  const methods: string[] = [];
  const lines = spec.split('\n');
  let cur: string | null = null;
  for (const l of lines) {
    const p = l.match(/^  (\/[^:\s]+):\s*$/);
    if (p) { cur = p[1]!; continue; }
    const m = l.match(/^    (get|post|put|patch|delete):\s*$/);
    if (m && cur) methods.push(`${m[1]!.toUpperCase()} ${cur}`);
    if (/^\S/.test(l)) cur = null;
  }
  assert.ok(paths.length >= 15);
  const table = ROUTES.map((r) => `${r.method} ${r.pattern}`).sort();
  assert.deepEqual(methods.sort(), table);
  assert.equal(matchRoute('get', '/leads/ld_1/')?.scope, 'leads:read');
});
