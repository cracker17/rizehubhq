// Vault routes through the real internal HTTP server (ephemeral port), with a FakeVaultStore + real crypto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createHttpServer } from '../http';
import { createVaultRoutes, RateLimiter } from './vault';
import { createVaultService, hashAccessToken } from '../vault/service';
import { FakeVaultStore } from '../vault/fakeStore';
import { loadKeyring, open } from '../vault/crypto';

const SECRET = 'test-internal-secret';
const CLIENT = '0c000000-0000-4000-8000-000000000009';
const PW = 'Demo-Only-Route-Pw!';

async function withServer(fn: (call: (path: string, body: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: Record<string, unknown>; text: string }>, ctx: { store: FakeVaultStore; errors: string[] }) => Promise<void>, o: { keyring?: boolean; perIp?: RateLimiter } = {}) {
  const store = new FakeVaultStore();
  store.addClient(CLIENT, 'Vinyl Icons', 'vinyl-icons');
  const kr = o.keyring === false ? null : loadKeyring({ VAULT_MASTER_KEY: randomBytes(32).toString('base64') });
  const service = createVaultService(store, kr);
  const errors: string[] = [];
  const routes = createVaultRoutes({ service: () => service, secret: () => SECRET, logError: (m) => errors.push(m), accessPerIp: o.perIp });
  const server = createHttpServer({ chat: async () => ({ answer: '' }), health: () => ({}) }, SECRET, routes);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const call = async (path: string, body: unknown, headers: Record<string, string> = { 'x-hq-secret': SECRET }) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, text };
  };
  try { await fn(call, { store, errors }); } finally { server.close(); }
  // plaintext never reached the store or any error log
  assert.ok(!JSON.stringify([...store.creds.values()].map((c) => ({ ...c, sealed: c.sealed.cipher.toString('latin1') }))).includes(PW));
  assert.ok(!errors.join('\n').includes(PW));
  if (kr) for (const c of store.creds.values()) assert.equal(typeof open(c.sealed, kr, c.id), 'string');
}

const storeBody = (o: Record<string, unknown> = {}) => ({
  clientId: CLIENT, platform: 'wordpress', label: 'Vinyl Icons WP', loginUrl: 'vinylicons.com/wp-login.php', username: 'rizehub-agent',
  secretType: 'app_password', secret: PW, twofaMethod: 'none', scopeNotes: 'Staging only', urlAllowlist: ['https://vinylicons.com/wp-json/wp/v2'],
  grants: ['wordpress-dev', 'qa-lead'], ...o,
});

test('/vault/store encrypts + stores; /vault/reveal decrypts and logs; /vault/rotate replaces the secret', () => withServer(async (call, { store }) => {
  const r = await call('/vault/store', storeBody());
  assert.equal(r.status, 200);
  const id = String(r.body.id);
  const c = store.creds.get(id)!;
  assert.equal(c.login_url, 'https://vinylicons.com/wp-login.php');
  assert.deepEqual([...c.grants], ['wordpress-dev', 'qa-lead']);
  assert.ok(!r.text.includes(PW));

  const rev = await call('/vault/reveal', { id });
  assert.deepEqual(rev.body, { label: 'Vinyl Icons WP', secret: PW });
  assert.deepEqual(store.log.at(-1), { credentialId: id, agentId: 'ceo', taskId: null, action: 'reveal', success: true, detail: { via: 'dashboard' } });

  assert.equal((await call('/vault/rotate', { id, secret: 'Rotated-Demo-Pw' })).status, 200);
  assert.equal((await call('/vault/reveal', { id })).body.secret, 'Rotated-Demo-Pw');
  assert.equal((await call('/vault/reveal', { id: '0c000000-0000-4000-8000-0000000000ff' })).status, 404);
}));

test('vault routes need the internal secret and validate input without echoing secrets', () => withServer(async (call) => {
  assert.equal((await call('/vault/store', storeBody(), {})).status, 401);
  assert.equal((await call('/vault/reveal', { id: CLIENT }, { 'x-hq-secret': 'wrong-secret-value!!' })).status, 401);
  const bad = await call('/vault/store', storeBody({ platform: 'Not A Platform', secret: '' }));
  assert.equal(bad.status, 400);
  assert.match(String(bad.body.error), /platform/);
  const allow = await call('/vault/store', storeBody({ urlAllowlist: ['http://plain.example.com'] }));
  assert.equal(allow.status, 400);
  const big = await call('/vault/store', storeBody({ secret: `${PW}${'x'.repeat(9000)}` }));
  assert.equal(big.status, 400);
  assert.ok(!big.text.includes(PW));
  assert.equal((await call('/vault/store', storeBody({ clientId: '0c000000-0000-4000-8000-0000000000ff' }))).status, 404);
  assert.equal((await call('/vault/store', '{nope')).status, 400);
}));

test('without VAULT_MASTER_KEY the routes answer 503', () => withServer(async (call) => {
  const r = await call('/vault/store', storeBody());
  assert.equal(r.status, 503);
  assert.match(String(r.body.error), /VAULT_MASTER_KEY/);
}, { keyring: false }));

test('/vault/access: client self-serve link is single use, expiry-checked and rate limited', () => withServer(async (call, { store }) => {
  const token = randomBytes(32).toString('base64url');
  const expired = randomBytes(32).toString('base64url');
  store.links.push({ tokenHash: hashAccessToken(token), clientId: CLIENT, platforms: ['wordpress', 'shopify'], expiresAt: Date.now() + 3600_000, usedAt: null, credentialId: null });
  store.links.push({ tokenHash: hashAccessToken(expired), clientId: CLIENT, platforms: ['wordpress'], expiresAt: Date.now() - 1, usedAt: null, credentialId: null });
  const body = { token, platform: 'wordpress', loginUrl: 'https://vinylicons.com/wp-admin', username: 'owner', secret: PW, notes: 'Editor role' };

  assert.equal((await call('/vault/access', body, {})).status, 401, 'only the dashboard server may forward the form');
  assert.deepEqual((await call('/vault/access/state', { token })).body, { state: 'open', client_name: 'Vinyl Icons', platforms: ['wordpress', 'shopify'] });
  assert.equal((await call('/vault/access/state', { token: 'short' })).body.state, 'invalid');
  assert.equal((await call('/vault/access', { ...body, platform: 'github' })).status, 409);
  const ok = await call('/vault/access', body);
  assert.deepEqual(ok.body, { ok: true });
  const c = [...store.creds.values()].find((x) => x.created_by === 'client_link')!;
  assert.equal(c.label, 'Wordpress access (from client)');
  assert.equal(c.scope_notes, 'Editor role');
  assert.equal(c.grants.size, 0, 'the CEO grants agents later');
  assert.equal((await call('/vault/access', body)).status, 410);
  assert.equal((await call('/vault/access/state', { token })).body.state, 'used');
  assert.equal((await call('/vault/access', { ...body, token: expired })).status, 410);
  assert.equal((await call('/vault/access/state', { token: expired })).body.state, 'expired');
  assert.equal((await call('/vault/access', { ...body, token: randomBytes(32).toString('base64url') })).status, 410);
  assert.equal((await call('/vault/access', body)).status, 429, 'the per-IP limiter (5 in this test) kicked in');
}, { perIp: new RateLimiter(5, 60_000) }));

test('rate limiter: fixed window per key', () => {
  let t = 0;
  const l = new RateLimiter(2, 1000, () => t);
  assert.deepEqual([l.hit('a'), l.hit('a'), l.hit('a'), l.hit('b')], [true, true, false, true]);
  t = 1001;
  assert.equal(l.hit('a'), true);
});
