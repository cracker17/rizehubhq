// Admin → API & AI routes through the real internal HTTP server (ephemeral port), with a fake store, a fake live
// tester and real crypto: allowlisted names only (bootstrap secrets refused), tested before storing, sealed with the
// provider_key:<NAME> context, applied at once (reload), and no key value in any response or log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { parseDashboardAi, providerKeyContext } from '@rizehubhq/shared';
import { createHttpServer } from '../http';
import { loadKeyring, open } from '../vault/crypto';
import { FakeProviderKeyStore } from '../settings/store';
import type { RuntimeSnapshot } from '../settings/runtime';
import type { KeyTestResult } from '../settings/keyTest';
import { createSettingsRoutes, keyNameProblem, type KeyEnvView, type KeySource } from './settings';

const SECRET = 'test-internal-secret';
const KEY = 'gsk_live_route_value_9Q2w';

interface Ctx {
  store: FakeProviderKeyStore; logs: string[]; tests: string[]; reloads: number;
  sources: Map<string, { source: KeySource; value?: string }>;
}

async function withServer(fn: (call: (path: string, body: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: Record<string, unknown>; text: string }>, ctx: Ctx) => Promise<void>,
  o: { keyring?: boolean; runtime?: boolean; result?: (name: string, value: string) => KeyTestResult } = {}) {
  const kr = o.keyring === false ? null : loadKeyring({ VAULT_MASTER_KEY: randomBytes(32).toString('base64') });
  const ctx: Ctx = { store: new FakeProviderKeyStore(), logs: [], tests: [], reloads: 0, sources: new Map() };
  const snapshot: RuntimeSnapshot = { keys: [], unreadable: [], dashboard: parseDashboardAi({}), legacyDaily: null, loadedAt: 0 };
  const runtime = { snapshot, refresh: async () => { ctx.reloads++; return snapshot; } };
  const env: KeyEnvView = { value: (n) => ctx.sources.get(n)?.value, source: (n) => ctx.sources.get(n)?.source ?? 'missing', inEnv: (n) => n === 'GROQ_API_KEY' };
  const routes = createSettingsRoutes({
    store: () => ctx.store, keyring: () => kr, runtime: () => (o.runtime === false ? null : runtime), env, log: (m) => ctx.logs.push(m),
    test: async (name, value) => { ctx.tests.push(name); return o.result?.(name, value) ?? { ok: true, message: 'Groq accepted the key.' }; },
    aiStatus: () => ({ ai: { profile: 'free' } }),
  });
  const server = createHttpServer({ chat: async () => ({ answer: '' }), health: () => ({}) }, SECRET, routes);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const call = async (path: string, body: unknown, headers: Record<string, string> = { 'x-hq-secret': SECRET }) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, text };
  };
  try { await fn(call, ctx); } finally { server.close(); }
  assert.ok(!ctx.logs.join('\n').includes(KEY), 'no key value in the worker log');
  if (kr) for (const [name, r] of ctx.store.rows) assert.equal(typeof open(r.sealed, kr, providerKeyContext(name)), 'string');
}

test('/settings/keys/set: tests, seals (provider_key:<NAME>), stores last 4, reloads at once; the value is never echoed', () => withServer(async (call, ctx) => {
  const r = await call('/settings/keys/set', { name: 'GROQ_API_KEY', value: `  ${KEY}  ` });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, last4: '9Q2w', tested: true, applied: true, message: 'Groq accepted the key.' });
  assert.ok(!r.text.includes(KEY));
  assert.deepEqual(ctx.tests, ['GROQ_API_KEY']);
  assert.equal(ctx.reloads, 1, 'the worker uses it right away');
  const row = ctx.store.rows.get('GROQ_API_KEY')!;
  assert.equal(row.last4, '9Q2w');
  assert.deepEqual(row.test, { ok: true });
  assert.ok(!row.sealed.cipher.toString('latin1').includes(KEY), 'ciphertext only');
}));

test('/settings/keys/set refuses bootstrap secrets, unknown names and junk values', () => withServer(async (call, ctx) => {
  for (const name of ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_URL', 'VAULT_MASTER_KEY', 'VAULT_PREVIOUS_KEYS', 'HQ_INTERNAL_SECRET', 'TELEGRAM_BOT_TOKEN',
    'SUPABASE_DB_URL', 'RIZEHUB_WEBHOOK_SECRET', 'HQ_MCP_TOKEN_WEB_DEV']) {
    const r = await call('/settings/keys/set', { name, value: KEY });
    assert.equal(r.status, 400, name);
    assert.match(String(r.body.error), /system secret/, name);
  }
  assert.match(String((await call('/settings/keys/set', { name: 'MY_OTHER_KEY', value: KEY })).body.error), /Unknown key name/);
  assert.match(String((await call('/settings/keys/set', { name: 'groq_api_key', value: KEY })).body.error), /Unknown key name/);
  for (const value of ['short', 'has a space inside it', 'x'.repeat(600)]) {
    const r = await call('/settings/keys/set', { name: 'GROQ_API_KEY', value });
    assert.equal(r.status, 400);
  }
  assert.equal((await call('/settings/keys/set', { name: 'GROQ_API_KEY', value: KEY }, {})).status, 401, 'needs x-hq-secret');
  assert.equal((await call('/settings/keys/set', { name: 'GROQ_API_KEY', value: KEY }, { 'x-hq-secret': 'wrong-secret-value!!' })).status, 401);
  assert.equal(ctx.store.rows.size, 0);
  assert.deepEqual(ctx.tests, [], 'nothing was sent to a provider');
}));

test('/settings/keys/set: a key the provider rejects is not stored; the error never contains the key', () => withServer(async (call, ctx) => {
  const r = await call('/settings/keys/set', { name: 'ANTHROPIC_API_KEY', value: KEY });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Anthropic said: bad key [key]');
  assert.ok(!r.text.includes(KEY));
  assert.equal(ctx.store.rows.size, 0);
  assert.equal(ctx.reloads, 0);
}, { result: (_n, v) => ({ ok: false, error: `Anthropic said: bad key ${v}` }) }));

test('/settings/keys/set: test:false or an untestable key is stored untested; no keyring → 503', async () => {
  await withServer(async (call, ctx) => {
    const r = await call('/settings/keys/set', { name: 'PAGESPEED_API_KEY', value: KEY });
    assert.equal(r.body.tested, null);
    assert.equal(ctx.store.rows.get('PAGESPEED_API_KEY')!.test, null);
    const s = await call('/settings/keys/set', { name: 'FIGMA_TOKEN', value: KEY, test: false });
    assert.deepEqual([s.status, s.body.tested], [200, null]);
    assert.deepEqual(ctx.tests, ['PAGESPEED_API_KEY'], 'test:false skips the provider call');
  }, { result: () => ({ ok: null, message: 'not testable' }) });
  await withServer(async (call, ctx) => {
    assert.equal((await call('/settings/keys/set', { name: 'GROQ_API_KEY', value: KEY })).status, 503);
    assert.equal(ctx.store.rows.size, 0);
  }, { keyring: false });
});

test('/settings/keys/test uses the key agents use now; dashboard keys record the result, missing keys say so', () => withServer(async (call, ctx) => {
  ctx.sources.set('GROQ_API_KEY', { source: 'dashboard', value: KEY });
  ctx.sources.set('OPENAI_API_KEY', { source: 'env', value: 'sk-env-value-123456' });
  await ctx.store.upsert('GROQ_API_KEY', { cipher: Buffer.alloc(0), iv: Buffer.alloc(0), keyVersion: 1 }, '9Q2w', null);
  const g = await call('/settings/keys/test', { name: 'GROQ_API_KEY' });
  assert.deepEqual(g.body, { ok: false, source: 'dashboard', error: 'rejected [key]' });
  assert.deepEqual(ctx.store.rows.get('GROQ_API_KEY')!.test, { ok: false, error: 'rejected [key]' });
  const o = await call('/settings/keys/test', { name: 'OPENAI_API_KEY' });
  assert.equal(o.body.source, 'env');
  const m = await call('/settings/keys/test', { name: 'SERPER_API_KEY' });
  assert.deepEqual(m.body, { ok: false, source: 'missing', error: 'No key is set for this service.' });
  assert.equal((await call('/settings/keys/test', { name: 'VAULT_MASTER_KEY' })).status, 400);
  ctx.store.rows.clear(); // the helper re-opens stored rows; this one held a placeholder
}, { result: (n, v) => (n === 'GROQ_API_KEY' ? { ok: false, error: `rejected ${v}` } : { ok: true, message: 'fine' }) }));

test('/settings/reload and /settings/status: names and sources only, never values; 503 before the runtime exists', async () => {
  await withServer(async (call, ctx) => {
    ctx.sources.set('GROQ_API_KEY', { source: 'dashboard', value: KEY });
    ctx.sources.set('TAVILY_API_KEY', { source: 'env', value: 'tvly-env-value-123' });
    const r = await call('/settings/reload', {});
    assert.deepEqual(r.body, { ok: true, keys: [], unreadable: [] });
    assert.equal(ctx.reloads, 1);
    const s = await call('/settings/status', {});
    const keys = s.body.keys as { name: string; source: string }[];
    assert.equal(keys.length, 12);
    assert.deepEqual(keys.find((k) => k.name === 'GROQ_API_KEY'), { name: 'GROQ_API_KEY', source: 'dashboard' });
    assert.deepEqual(keys.find((k) => k.name === 'TAVILY_API_KEY'), { name: 'TAVILY_API_KEY', source: 'env' });
    assert.deepEqual(keys.find((k) => k.name === 'FIGMA_TOKEN'), { name: 'FIGMA_TOKEN', source: 'missing' });
    assert.deepEqual(s.body.ai, { profile: 'free' });
    assert.deepEqual(s.body.envAlso, ['GROQ_API_KEY'], 'names only');
    assert.ok(!s.text.includes(KEY) && !s.text.includes('tvly-env-value-123'));
    assert.ok(!keys.some((k) => /SUPABASE|VAULT|HQ_INTERNAL/.test(k.name)));
  });
  await withServer(async (call) => {
    assert.equal((await call('/settings/reload', {})).status, 503);
  }, { runtime: false });
});

test('keyNameProblem: allowlist + clear refusal for system secrets', () => {
  assert.equal(keyNameProblem('OPENROUTER_API_KEY'), null);
  assert.match(keyNameProblem('HERMES_KEY_WEB_DEV')!, /system secret/);
  assert.match(keyNameProblem('OUTREACH_SMTP_PASS')!, /system secret/);
  assert.equal(keyNameProblem('GITHUB_TOKEN_DEFAULT'), 'Unknown key name.');
});
