// Vault tools with fakes only: FakeVaultStore, a fake fetch, a fake browser. No network, no real browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { ToolSet } from 'ai';
import { createVaultTools, type VaultToolEnv } from './vault';
import { loadKeyring, seal, type Keyring } from '../vault/crypto';
import { FakeVaultStore } from '../vault/fakeStore';
import { fakeLauncher, type FakeSite } from '../vault/fakeBrowser';
import { BrowserUnavailable, getVaultBrowserSession, openSessionCount, sweepSessions } from '../vault/browser';
import type { NewCredential } from '../vault/store';
import { runTask, type ToolContext } from '../runner';
import { loadRole } from '../roles';
import { makeDeps, mockModel, promptText, toolCalls } from '../testing';

const CLIENT = '0c000000-0000-4000-8000-000000000001';
const TOKEN = 'shpat_DEMO_0000_not_real_9f8e7d';
const PASSWORD = 'Demo-Only-Pw!42';

interface Setup {
  store: FakeVaultStore; kr: Keyring; tools: ToolSet; env: VaultToolEnv; ctx: ToolContext;
  fetchCalls: { url: string; init: RequestInit }[]; api: string; login: string; launcher: ReturnType<typeof fakeLauncher>;
}

function setup(o: {
  site?: FakeSite; agent?: string; fetchImpl?: (url: string, init: RequestInit) => Response; launch?: VaultToolEnv['launchBrowser'];
  /** The task's client (default Madam Muse); null = a task without a client. */
  taskClient?: string | null;
} = {}): Setup {
  const kr = loadKeyring({ VAULT_MASTER_KEY: randomBytes(32).toString('base64') })!;
  const store = new FakeVaultStore();
  store.addClient(CLIENT, 'Madam Muse', 'madam-muse');
  const add = (c: Partial<NewCredential> & { secret: string }) => {
    const id = randomUUID();
    void store.insertCredential({
      id, clientId: CLIENT, platform: 'shopify', label: 'Madam Muse Admin API', loginUrl: null, username: 'dev@rizehub.ph',
      secretType: 'api_token', twofaMethod: 'none', scopeNotes: 'Themes only. header: X-Shopify-Access-Token',
      urlAllowlist: ['https://madammuse.myshopify.com/admin/api'], expiresAt: null, grants: ['web-dev', 'qa-lead'],
      ...c, sealed: seal(c.secret, kr, id),
    });
    return id;
  };
  const api = add({ secret: TOKEN });
  const login = add({
    secret: PASSWORD, secretType: 'password', label: 'Madam Muse store login', loginUrl: 'https://madammuse.myshopify.com/admin',
    scopeNotes: 'Theme edits on unpublished themes only', urlAllowlist: ['https://madammuse.myshopify.com/admin/themes'], twofaMethod: 'sms',
  });
  add({ secret: 'other-demo', label: 'Ads account', platform: 'ga4', grants: ['writer'] });

  const fetchCalls: Setup['fetchCalls'] = [];
  const fetchImpl = o.fetchImpl ?? ((url: string, init: RequestInit) => {
    // An API that echoes the auth header back (worst case for leaks).
    const h = new Headers(init.headers);
    return new Response(JSON.stringify({ ok: true, echo: h.get('x-shopify-access-token') ?? h.get('authorization'), url }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  });
  const launcher = fakeLauncher(o.site ?? { password: PASSWORD });
  const env: VaultToolEnv = {
    store: () => store, keyring: () => kr,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      return fetchImpl(String(url), init ?? {});
    }) as typeof fetch,
    launchBrowser: o.launch ?? launcher, twofaTimeoutMs: 50, twofaPollMs: 1, sleep: async () => undefined,
  };
  const deps = makeDeps({ model: mockModel([]) });
  const task = deps.db.addTask({ agent_id: o.agent ?? 'web-dev', client_id: o.taskClient === undefined ? CLIENT : o.taskClient, status: 'working' });
  const ctx: ToolContext = { task, role: loadRole(o.agent ?? 'web-dev'), deps, state: { ended: null, costUsd: 0, overBudget: false, toolErrors: 0 } };
  return { store, kr, tools: createVaultTools(ctx, env), env, ctx, fetchCalls, api, login, launcher };
}

async function run(tools: ToolSet, name: string, input: unknown): Promise<string> {
  return String(await tools[name]!.execute!(input as never, { toolCallId: 't', messages: [] }));
}

test('vault_list shows only granted credentials, masked usernames, never secrets; use is logged', async () => {
  const s = setup();
  const out = await run(s.tools, 'vault_list', {});
  assert.match(out, /Madam Muse: 2 credential\(s\) granted/);
  assert.match(out, new RegExp(s.api));
  assert.match(out, /d\*\*\*@rizehub\.ph/);
  assert.match(out, /1 other credential/);
  assert.doesNotMatch(out, /Ads account/);
  assert.ok(!out.includes(TOKEN) && !out.includes(PASSWORD) && !out.includes('dev@rizehub.ph'));
  assert.equal(s.store.log.at(-1)?.action, 'list');
  assert.match(await run(s.tools, 'vault_list', { client: 'nobody' }), /No client/);
});

// Admin → Tool logins: the agency's own accounts live on the internal client (20260929060000_internal_vault.sql).
const INTERNAL = '0c000000-0000-4000-8000-0000000000aa';
const SEMRUSH_KEY = 'semrush_DEMO_key_not_real_7a6b';
function addToolLogins(s: Setup) {
  s.store.addClient(INTERNAL, 'RizeHub (internal)', 'rizehub-internal', true);
  const add = (label: string, platform: string, grants: string[], secret: string) => {
    const id = randomUUID();
    void s.store.insertCredential({
      id, clientId: INTERNAL, platform, label, loginUrl: null, username: 'team@rizehub.ph', secretType: 'api_token', twofaMethod: 'none',
      scopeNotes: 'Keyword research only', urlAllowlist: ['https://api.semrush.com/'], expiresAt: null, grants, sealed: seal(secret, s.kr, id),
    });
    return id;
  };
  return { semrush: add('Semrush · agency seat', 'semrush', ['web-dev', 'writer'], SEMRUSH_KEY), canva: add('Canva · team', 'canva', ['designer'], 'canva-demo') };
}

test('tool logins: a task without a client lists and uses only the RizeHub tool logins the agent is granted', async () => {
  const s = setup({ taskClient: null });
  const { semrush, canva } = addToolLogins(s);
  const out = await run(s.tools, 'vault_list', {});
  assert.match(out, /This task has no client/);
  assert.match(out, /RizeHub tool logins \(the agency's own accounts, usable in any task\): 1 granted to you/);
  assert.match(out, new RegExp(semrush));
  assert.match(out, /1 other tool login\(s\) exist that you are not granted/);
  assert.doesNotMatch(out, /Canva|Madam Muse/);
  assert.ok(!out.includes(SEMRUSH_KEY) && !out.includes('team@rizehub.ph'));
  assert.deepEqual(s.store.log.at(-1)?.detail, { client_id: null, granted: 0, tools: 1 });

  const res = await run(s.tools, 'vault_api', { credential_id: semrush, request: { method: 'GET', url: 'https://api.semrush.com/?type=domain_ranks&domain=rizehub.ph' } });
  assert.match(res, /HTTP 200/);
  assert.ok(!res.includes(SEMRUSH_KEY), 'the echoed key is redacted');
  assert.equal(new Headers(s.fetchCalls.at(-1)!.init.headers).get('authorization'), `Bearer ${SEMRUSH_KEY}`);
  // every Client Vault guard still applies: allowlist, grants, audit
  assert.match(await run(s.tools, 'vault_api', { credential_id: semrush, request: { method: 'GET', url: 'https://www.semrush.com/billing' } }), /not on this credential's allowlist/);
  assert.match(await run(s.tools, 'vault_api', { credential_id: canva, request: { method: 'GET', url: 'https://api.semrush.com/' } }), /not granted/);
  assert.equal(s.fetchCalls.length, 1);
  assert.deepEqual(s.store.log.filter((l) => l.credentialId).map((l) => l.action).slice(-3), ['api_call', 'denied', 'denied']);
});

test('tool logins: shown next to the client\'s own logins in a client task; a task without a client and no tool logins says so', async () => {
  const s = setup();
  addToolLogins(s);
  const out = await run(s.tools, 'vault_list', {});
  assert.match(out, /Madam Muse: 2 credential\(s\) granted/);
  assert.match(out, /RizeHub tool logins .*: 1 granted to you/);
  assert.match(out, /Semrush · agency seat/);
  const bare = setup({ taskClient: null });
  const none = await run(bare.tools, 'vault_list', {});
  assert.match(none, /This task has no client/);
  assert.doesNotMatch(none, /RizeHub tool logins/);
  assert.match(await run(bare.tools, 'vault_list', { client: 'madam-muse' }), /Madam Muse: 2 credential\(s\) granted/);
});

test('grants are enforced: an agent without a grant gets nothing and the attempt is logged', async () => {
  const s = setup({ agent: 'writer' });
  const out = await run(s.tools, 'vault_api', { credential_id: s.api, request: { method: 'GET', url: 'https://madammuse.myshopify.com/admin/api/2025-07/themes.json' } });
  assert.match(out, /not granted/);
  assert.equal(s.fetchCalls.length, 0);
  assert.deepEqual(s.store.log.at(-1), { credentialId: s.api, agentId: 'writer', taskId: s.ctx.task.id, action: 'denied', success: false, detail: { tool: 'vault_api', reason: 'not granted' } });
  assert.match(await run(s.tools, 'vault_login', { credential_id: s.login }), /not granted/);
  assert.match(await run(s.tools, 'vault_api', { credential_id: 'not-a-uuid', request: { method: 'GET', url: 'https://x.com' } }), /Unknown credential/);
  assert.match(await run(s.tools, 'vault_report_problem', { credential_id: s.api, issue: 'broken' }), /not granted/);
});

test('vault_api adds the token itself (scope header), redacts every echo, logs status only', async () => {
  const s = setup();
  const out = await run(s.tools, 'vault_api', { credential_id: s.api, request: {
    method: 'GET', url: 'https://madammuse.myshopify.com/admin/api/2025-07/themes.json',
    headers: { Authorization: 'Bearer from-agent', 'X-Shopify-Access-Token': 'agent-guess', Accept: 'application/json' },
  } });
  assert.equal(s.fetchCalls.length, 1);
  const h = new Headers(s.fetchCalls[0]!.init.headers);
  assert.equal(h.get('x-shopify-access-token'), TOKEN);
  assert.equal(h.get('authorization'), null, 'agent-supplied auth headers are dropped');
  assert.equal(h.get('accept'), 'application/json');
  assert.equal(s.fetchCalls[0]!.init.redirect, 'manual');
  assert.match(out, /^HTTP 200/);
  assert.match(out, /\[REDACTED\]/);
  assert.ok(!out.includes(TOKEN));
  const entry = s.store.log.at(-1)!;
  assert.equal(entry.action, 'api_call');
  assert.equal(entry.success, true);
  assert.deepEqual(entry.detail, { method: 'GET', host: 'madammuse.myshopify.com', path: '/admin/api/2025-07/themes.json', status: 200 });
  assert.ok(!JSON.stringify(s.store.log).includes(TOKEN));
  assert.ok(s.store.creds.get(s.api)!.last_used_at);
});

test('vault_api: default Bearer, Basic for app passwords, redacted errors and 401 hints', async () => {
  const s = setup({ fetchImpl: (url) => { if (url.includes('boom')) throw new Error(`socket closed while sending ${TOKEN}`); return new Response('denied', { status: 401 }); } });
  s.store.creds.get(s.api)!.scope_notes = null;
  s.store.creds.get(s.api)!.write_allowlist = ['POST /admin/api/x'];
  const out = await run(s.tools, 'vault_api', { credential_id: s.api, request: { method: 'POST', url: 'https://madammuse.myshopify.com/admin/api/x', body: '{"a":1}' } });
  const h = new Headers(s.fetchCalls[0]!.init.headers);
  assert.equal(h.get('authorization'), `Bearer ${TOKEN}`);
  assert.equal(h.get('content-type'), 'application/json');
  assert.match(out, /HTTP 401/);
  assert.match(out, /vault_report_problem/);
  assert.equal(s.store.log.at(-1)!.success, false);
  const err = await run(s.tools, 'vault_api', { credential_id: s.api, request: { method: 'GET', url: 'https://madammuse.myshopify.com/admin/api/boom' } });
  assert.match(err, /Request failed: socket closed while sending \[REDACTED\]/);
  assert.ok(!JSON.stringify(s.store.log).includes(TOKEN));

  s.store.creds.get(s.api)!.secret_type = 'app_password';
  await run(s.tools, 'vault_api', { credential_id: s.api, request: { method: 'GET', url: 'https://madammuse.myshopify.com/admin/api/y' } });
  assert.equal(new Headers(s.fetchCalls.at(-1)!.init.headers).get('authorization'), `Basic ${Buffer.from(`dev@rizehub.ph:${TOKEN}`).toString('base64')}`);
});

test('vault_api enforces the allowlist, https and approval for deletes', async () => {
  const s = setup();
  const call = (method: string, url: string) => run(s.tools, 'vault_api', { credential_id: s.api, request: { method, url } });
  assert.match(await call('GET', 'https://madammuse.myshopify.com/admin/orders.json'), /not on this credential's allowlist/);
  assert.match(await call('GET', 'https://evil.example.com/admin/api/x'), /not on this credential's allowlist/);
  assert.match(await call('GET', 'http://madammuse.myshopify.com/admin/api/x'), /must be https/);
  assert.match(await call('DELETE', 'https://madammuse.myshopify.com/admin/api/2025-07/themes/1.json'), /request_external_action/);
  assert.equal(s.fetchCalls.length, 0);
  assert.deepEqual(s.store.log.filter((l) => l.action === 'denied').map((l) => l.detail?.reason),
    ['url_not_allowlisted', 'url_not_allowlisted', 'delete_needs_approval']);
  // no allowlist = no API use at all
  s.store.creds.get(s.api)!.url_allowlist = [];
  assert.match(await call('GET', 'https://madammuse.myshopify.com/admin/api/x'), /empty/);
});

test('vault_api is read-only by default; writes only when METHOD + path are on the write allowlist', async () => {
  const s = setup();
  const call = (method: string, url: string, body?: string, headers?: Record<string, string>) =>
    run(s.tools, 'vault_api', { credential_id: s.api, request: { method, url, body, headers } });
  const assets = 'https://madammuse.myshopify.com/admin/api/2025-07/themes/123/assets.json';
  // no write allowlist: every write is refused before any request is made
  for (const m of ['POST', 'PUT', 'PATCH']) assert.match(await call(m, assets, '{"asset":{}}'), /read-only for .* Allowed writes: none/);
  assert.equal(s.fetchCalls.length, 0);
  assert.deepEqual(s.store.log.filter((l) => l.action === 'denied').map((l) => l.detail?.reason), ['write_not_allowlisted', 'write_not_allowlisted', 'write_not_allowlisted']);
  // GET still works
  assert.match(await call('GET', assets), /^HTTP 200/);
  // the CEO allows exactly one write
  s.store.creds.get(s.api)!.write_allowlist = ['PUT /admin/api/2025-07/themes/123/assets.json'];
  assert.match(await call('PUT', assets, '{"asset":{"key":"sections/hero.liquid","value":"x"}}'), /^HTTP 200/);
  assert.equal(s.fetchCalls.at(-1)!.init.method, 'PUT');
  assert.match(await call('POST', assets, '{}'), /read-only/, 'method must match');
  assert.match(await call('PUT', 'https://madammuse.myshopify.com/admin/api/2025-07/themes/999/assets.json', '{}'), /read-only/, 'path must match');
  assert.match(await call('PUT', 'https://madammuse.myshopify.com/admin/api/2025-07/themes/123/assets.json.bak', '{}'), /read-only/, 'whole segments only');
  // method overrides cannot sneak a write through a GET
  assert.match(await call('GET', `${assets}?_method=PUT`), /method overrides/);
  const n = s.fetchCalls.length;
  await call('GET', assets, undefined, { 'X-HTTP-Method-Override': 'DELETE' });
  assert.equal(new Headers(s.fetchCalls[n]!.init.headers).get('x-http-method-override'), null);
});

test('vault_api never publishes, even when the write allowlist covers the endpoint', async () => {
  const s = setup();
  const c = s.store.creds.get(s.api)!;
  c.url_allowlist = ['https://madammuse.myshopify.com/admin/api', 'https://api.webflow.com/v2', 'https://blog.example.com/wp-json'];
  c.write_allowlist = ['PUT /admin/api', 'POST /admin/api', 'POST /v2', 'PATCH /v2', 'POST /wp-json', 'PUT /wp-json'];
  const call = (method: string, url: string, body?: string) => run(s.tools, 'vault_api', { credential_id: s.api, request: { method, url, body } });
  assert.match(await call('PUT', 'https://madammuse.myshopify.com/admin/api/2025-07/themes/123.json', '{"theme":{"role":"main"}}'), /Shopify theme role change.*request_external_action/s);
  assert.match(await call('POST', 'https://madammuse.myshopify.com/admin/api/2025-07/themes.json', '{"theme":{"name":"x","role":"main"}}'), /Shopify theme/);
  assert.match(await call('POST', 'https://madammuse.myshopify.com/admin/api/2025-07/graphql.json', '{"query":"mutation { themePublish(id: 1) { theme { id } } }"}'), /Shopify publish/);
  assert.match(await call('POST', 'https://api.webflow.com/v2/sites/abc/publish', '{"publishToWebflowSubdomain":true}'), /Webflow publish/);
  assert.match(await call('POST', 'https://api.webflow.com/v2/collections/c1/items/publish', '{"itemIds":["i"]}'), /Webflow publish/);
  assert.match(await call('PATCH', 'https://api.webflow.com/v2/collections/c1/items/i1/live', '{}'), /Webflow publish/);
  assert.match(await call('POST', 'https://blog.example.com/wp-json/wp/v2/posts/7', '{"title":"x","status":"publish"}'), /WordPress publish/);
  assert.match(await call('POST', 'https://blog.example.com/wp-json/wp/v2/posts?status=publish', '{"title":"x"}'), /WordPress publish/);
  assert.match(await call('POST', 'https://blog.example.com/wp-json/wp/v2/posts', '{"title":"x","st\\u0061tus":"future"}'), /WordPress publish/);
  assert.equal(s.fetchCalls.length, 0);
  assert.ok(s.store.log.filter((l) => l.action === 'denied').every((l) => l.detail?.reason === 'publish_needs_approval'));
  // drafts and unpublished theme edits are fine
  assert.match(await call('POST', 'https://blog.example.com/wp-json/wp/v2/posts', '{"title":"x","status":"draft"}'), /^HTTP 200/);
  assert.match(await call('PUT', 'https://madammuse.myshopify.com/admin/api/2025-07/themes/123/assets.json', '{"asset":{"key":"a","value":"b"}}'), /^HTTP 200/);
  // vault_list tells the agent what it may write
  assert.match(await run(s.tools, 'vault_list', {}), /API writes: PUT \/admin\/api, POST \/admin\/api/);
});

test('vault_login fills the form in an isolated context, blurs passwords, guards navigation, keeps the session for the task', async () => {
  const s = setup();
  const out = await run(s.tools, 'vault_login', { credential_id: s.login });
  assert.match(out, /^Logged in as d\*\*\*@rizehub\.ph at madammuse\.myshopify\.com/);
  assert.ok(!out.includes(PASSWORD));
  const ctx = s.launcher.browsers[0]!.contexts[0]!;
  const page = ctx.pages[0]!;
  assert.equal(page.filled['input[type="email"]'], 'dev@rizehub.ph');
  assert.equal(page.filled['input[type="password"]'], PASSWORD);
  assert.equal(page.stage, 'home');
  assert.match(ctx.initScripts[0]!, /blur/);
  assert.equal(ctx.options?.acceptDownloads, false);
  // navigation guard: allowlisted paths pass, everything else is aborted
  assert.equal(await ctx.navigate('https://madammuse.myshopify.com/admin/themes/1/editor'), true);
  assert.equal(await ctx.navigate('https://madammuse.myshopify.com/admin/orders'), true, 'login origin is implicitly allowed');
  assert.equal(await ctx.navigate('https://evil.example.com/steal'), false);
  const sess = getVaultBrowserSession(s.ctx.state, s.login)!;
  assert.deepEqual(sess.blocked, ['https://evil.example.com/steal']);
  assert.equal(getVaultBrowserSession(s.ctx.state)?.credentialId, s.login);
  assert.match(await run(s.tools, 'vault_login', { credential_id: s.login }), /Already logged in/);
  assert.equal(s.store.log.filter((l) => l.action === 'login' && l.success).length, 1);
  assert.match(await run(s.tools, 'vault_login', { credential_id: s.login, url: 'https://evil.example.com/login' }), /Already logged in|not on this credential's allowlist/);
  assert.match(await run(s.tools, 'vault_login', { credential_id: s.api }), /use vault_api/);

  // task ends → the sweeper closes the browser and clears cookies
  s.ctx.state.ended = 'submitted';
  assert.equal(await sweepSessions(), 1);
  assert.equal(ctx.cookiesCleared, true);
  assert.equal(ctx.closed, true);
  assert.equal(s.launcher.browsers[0]!.closed, true);
  assert.equal(getVaultBrowserSession(s.ctx.state), null);
});

test('vault_login refuses URLs off the allowlist before opening a browser', async () => {
  const s = setup();
  assert.match(await run(s.tools, 'vault_login', { credential_id: s.login, url: 'https://evil.example.com/login' }), /not on this credential's allowlist/);
  assert.equal(s.launcher.browsers.length, 0);
});

test('failed logins: one retry, then the credential is flagged check_needed and the CEO asked', async () => {
  const s = setup({ site: { password: 'something-else' } });
  assert.match(await run(s.tools, 'vault_login', { credential_id: s.login }), /You may try once more/);
  assert.match(await run(s.tools, 'vault_login', { credential_id: s.login }), /Login failed twice/);
  assert.equal(s.store.creds.get(s.login)!.status, 'check_needed');
  assert.equal(s.store.approvals.filter((a) => a.payload.type === 'vault_problem').length, 1);
  assert.match(await run(s.tools, 'vault_login', { credential_id: s.login }), /check needed/);
  assert.equal(s.launcher.browsers.length, 2, 'no third attempt');
  assert.ok(s.launcher.browsers.every((b) => b.closed));
  assert.equal(openSessionCount(), 0);
});

test('2FA: the worker asks the CEO, types the code itself and never shows it to the agent', async () => {
  const s = setup({ site: { password: PASSWORD, otp: '482913', twoStep: true } });
  assert.match(await run(s.tools, 'vault_request_2fa', { credential_id: s.login }), /Call vault_login first/);
  assert.match(await run(s.tools, 'vault_login', { credential_id: s.login }), /one-time code \(sms\)/);
  // CEO answers from Telegram while the tool is polling
  s.env.sleep = async () => { const ap = s.store.approvals.find((a) => a.status === 'pending'); if (ap) s.store.answer(ap.id, 'approved', ' 482 913 '); };
  const out = await run(s.tools, 'vault_request_2fa', { credential_id: s.login });
  assert.match(out, /Code accepted/);
  assert.ok(!out.includes('482913'));
  const ap = s.store.approvals.at(-1)!;
  assert.equal(ap.payload.type, 'question');
  assert.match(String(ap.payload.question), /Web Developer is logging in to Madam Muse store login .* sent by SMS\. Reply with the code only\./);
  assert.equal(ap.ceo_note, '[2FA code used]');
  assert.equal(s.launcher.browsers[0]!.contexts[0]!.pages[0]!.stage, 'home');
  assert.equal(getVaultBrowserSession(s.ctx.state, s.login)?.state, 'logged_in');
  assert.deepEqual(s.store.log.map((l) => l.action).slice(-3), ['login', 'twofa_request', 'twofa']);
  s.ctx.state.ended = 'submitted';
  await sweepSessions();
});

test('2FA timeout closes the waiting login and the question (a late code is never stored)', async () => {
  const s = setup({ site: { password: PASSWORD, otp: '111111' } });
  await run(s.tools, 'vault_login', { credential_id: s.login });
  s.env.twofaTimeoutMs = 0;
  assert.match(await run(s.tools, 'vault_request_2fa', { credential_id: s.login }), /No code within/);
  assert.equal(s.launcher.browsers[0]!.closed, true);
  const ap = s.store.approvals.at(-1)!;
  assert.equal(ap.status, 'rejected');
  assert.equal(ap.ceo_note, '[2FA request expired]');
});

test('2FA approved without a code does not crash: the login is closed and the agent is told', async () => {
  const s = setup({ site: { password: PASSWORD, otp: '482913', twoStep: true } });
  await run(s.tools, 'vault_login', { credential_id: s.login });
  s.env.sleep = async () => { const ap = s.store.approvals.find((a) => a.status === 'pending'); if (ap) s.store.answer(ap.id, 'approved', null); };
  assert.match(await run(s.tools, 'vault_request_2fa', { credential_id: s.login }), /did not provide a code/);
  assert.equal(getVaultBrowserSession(s.ctx.state, s.login), null);
  // a rejected question scrubs whatever was typed
  await run(s.tools, 'vault_login', { credential_id: s.login });
  s.env.sleep = async () => { const ap = s.store.approvals.find((a) => a.status === 'pending'); if (ap) s.store.answer(ap.id, 'rejected', '999000'); };
  assert.match(await run(s.tools, 'vault_request_2fa', { credential_id: s.login }), /did not provide a code/);
  assert.ok(!JSON.stringify(s.store.approvals).includes('999000'));
});

test('missing Playwright gives a clear message; report_problem flags the credential', async () => {
  const s = setup({ launch: async () => { throw new BrowserUnavailable('Playwright is not installed on the worker.'); } });
  assert.match(await run(s.tools, 'vault_login', { credential_id: s.login }), /Browser automation is not available on the worker: Playwright is not installed/);
  assert.equal(s.store.creds.get(s.login)!.failed_login_count, 0, 'not counted as a failed login');
  const out = await run(s.tools, 'vault_report_problem', { credential_id: s.api, issue: 'Token returns 401 since this morning' });
  assert.match(out, /flagged "check needed"/);
  assert.equal(s.store.creds.get(s.api)!.status, 'check_needed');
  assert.match(await run(s.tools, 'vault_api', { credential_id: s.api, request: { method: 'GET', url: 'https://madammuse.myshopify.com/admin/api/x' } }), /check needed/);
});

test('end to end in the runner: the model never sees the secret', async () => {
  const s = setup();
  const model = mockModel([
    toolCalls([{ name: 'vault_list', input: {} }]),
    toolCalls([{ name: 'vault_api', input: { credential_id: s.api, request: { method: 'GET', url: 'https://madammuse.myshopify.com/admin/api/2025-07/shop.json' } } }]),
    toolCalls([{ name: 'submit_output', input: { summary: 'Checked the shop via the API' } }]),
  ]);
  const deps = Object.assign(makeDeps({ model }), { vault: s.env });
  const task = deps.db.addTask({ agent_id: 'web-dev', client_id: CLIENT, status: 'working' });
  const r = await runTask(task, deps, { heartbeatMs: 5 });
  assert.equal(r.status, 'submitted');
  const seen = model.doGenerateCalls.map(promptText).join('\n');
  assert.match(seen, /HTTP 200/);
  assert.match(seen, /\[REDACTED\]/);
  assert.ok(!seen.includes(TOKEN) && !seen.includes(PASSWORD));
  assert.ok(!JSON.stringify(deps.db.activity).includes(TOKEN));
});
