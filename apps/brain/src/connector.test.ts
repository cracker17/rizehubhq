// Brain connector end to end without network (M14.2): a bare git repo plays GitHub, a second clone plays Julev's PC,
// PGlite runs the real migrations. Covers dynamic registration → consent code → PKCE token exchange → MCP tools over
// the internal HTTP API → saves committed and pushed to the vault (incl. losing a push race to the PC) → refresh-token
// rotation and replay detection → revocation.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { createPgliteStore, defaultMigrationsDir, type PgliteStore } from './store/pglite';
import { fakeEmbedder } from './index/embed';
import { createBrainService, type BrainService } from './service';
import { createHttpServer } from './http';
import type { VaultOp } from './write/vault';
import { saveSessionOp } from './write/vault';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-brain-conn-'));
const bare = path.join(tmp, 'github.git');
const pc = path.join(tmp, 'pc');
const clone = path.join(tmp, 'vps', 'vault');
const g = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Julev', '-c', 'user.email=j@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' }).toString().trim();
const pcWrite = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(pc, rel)), { recursive: true }); fs.writeFileSync(path.join(pc, rel), text); };
const pcPush = (msg: string) => { g(pc, 'add', '-A'); g(pc, 'commit', '-q', '-m', msg); g(pc, 'push', '-q', 'origin', 'main'); };
const originFile = (rel: string) => g(pc, 'show', `origin/main:${rel}`);

const CEO = '11111111-1111-4111-8111-111111111111';
const SECRET = 'internal-s3cret';
const MEMORY = `---\nproject: demo\nname: Demo\nupdated: 2026-09-01\n---\n# Demo\n\n## Overview\n- What it is: a demo\n\n## Links\n- Site:\n\n## Status\n- building\n\n## Decisions log\n<!-- - YYYY-MM-DD: decision -->\n- 2026-09-01: Use Supabase.\n\n## Open next steps\n- Build M1\n`;

let store: PgliteStore;
let service: BrainService;
let server: http.Server;
let base = '';
const logs: string[] = [];

async function api(method: string, p: string, init: { body?: unknown; form?: Record<string, string>; auth?: string; secret?: string | null } = {}) {
  const headers: Record<string, string> = {};
  if (init.secret !== null) headers['x-brain-secret'] = init.secret ?? SECRET;
  if (init.auth) headers.authorization = init.auth;
  let body: string | undefined;
  if (init.form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(init.form).toString(); }
  else if (init.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(init.body); }
  const res = await fetch(`${base}${p}`, { method, headers, body });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
let clientId = '';
let access = '';
let refresh = '';

async function mcp(method: string, params: unknown = {}, token = access) {
  return api('POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method, params }, auth: `Bearer ${token}` });
}
const toolText = (r: { body: { result?: { content: Array<{ text: string }>; isError: boolean } } }) => r.body.result!.content[0]!.text;

before(async () => {
  g(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
  g(tmp, 'clone', '-q', bare, pc);
  g(pc, 'checkout', '-q', '-b', 'main');
  pcWrite('projects.json', JSON.stringify({ projects: [{ slug: 'demo', name: 'Demo', aliases: ['demo site'] }, { slug: 'demo-two', name: 'Demo Two' }] }, null, 2));
  pcWrite('projects/demo/memory.md', MEMORY);
  pcWrite('projects/demo/sessions/LOG.md', '# Session log\n- 2026-09-01 [web] start -> 2026-09-01-start.md');
  pcWrite('projects/demo-two/memory.md', '# Demo Two\n\n## Status\n- idle\n');
  pcWrite('projects/_template/memory.md', `---\nproject: SLUG\nname: NAME\nupdated: YYYY-MM-DD\n---\n# NAME\n\n## Overview\n- What it is:\n- Client / owner:\n- Platform / stack:\n\n## Links\n- Site:\n\n## Status\n-\n\n## Decisions log\n<!-- - YYYY-MM-DD: decision -->\n\n## Open next steps\n-\n`);
  pcWrite('profile/profile.md', '# Julev\n\n- Web developer in Davao.');
  pcWrite('docs/new-computer-setup.md', '# New computer\n\n1. Clone the vault.');
  pcPush('init');

  store = await createPgliteStore(defaultMigrationsDir());
  await store.exec(`insert into auth.users (id, email) values ($1, 'ceo@example.com')`, [CEO]);
  await store.exec(`insert into ceo_users (user_id) values ($1)`, [CEO]);
  service = createBrainService({ store, embedder: fakeEmbedder(), git: { repoUrl: bare, branch: 'main', dir: clone }, log: (m) => logs.push(m), timeZone: 'Asia/Manila' });
  await service.sync({ reason: 'boot' });
  server = createHttpServer({
    store, embedder: fakeEmbedder(), service, internalSecret: SECRET, webhookSecret: 'hook', branch: 'main', log: (m) => logs.push(m),
    vaultDir: clone, redirectHosts: [],
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  await store?.close?.();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('OAuth endpoints need the internal secret (only the dashboard reaches them)', async () => {
  assert.equal((await api('POST', '/oauth/register', { body: { redirect_uris: [REDIRECT] }, secret: null })).status, 401);
  assert.equal((await api('POST', '/mcp', { body: {}, secret: 'wrong' })).status, 401);
});

test('registration: Claude callbacks and loopback pass, other hosts and confidential clients are refused', async () => {
  const bad = await api('POST', '/oauth/register', { body: { client_name: 'Evil', redirect_uris: ['https://evil.example/cb'] } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid_redirect_uri');
  const conf = await api('POST', '/oauth/register', { body: { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' } });
  assert.equal(conf.status, 400);
  const lo = await api('POST', '/oauth/register', { body: { client_name: 'Claude Code', redirect_uris: ['http://localhost:33418/callback'] } });
  assert.equal(lo.status, 201);
  // Loopback: any port at authorize time (RFC 8252).
  assert.equal((await api('GET', `/oauth/client?client_id=${lo.body.client_id}&redirect_uri=${encodeURIComponent('http://localhost:50123/callback')}`)).status, 200);
  const ok = await api('POST', '/oauth/register', { body: { client_name: 'Claude', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'] } });
  assert.equal(ok.status, 201);
  assert.match(ok.body.client_id, /^hqbc_/);
  assert.equal(ok.body.token_endpoint_auth_method, 'none');
  clientId = ok.body.client_id;
  const chk = await api('GET', `/oauth/client?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}`);
  assert.equal(chk.status, 200);
  assert.equal(chk.body.client_name, 'Claude');
  assert.equal((await api('GET', `/oauth/client?client_id=${clientId}&redirect_uri=${encodeURIComponent('https://claude.ai/other')}`)).status, 400);
});

test('code: only for the CEO, PKCE S256 required; token exchange checks the verifier; a code works once', async () => {
  const req = { client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', scopes: ['brain:read'], resource: 'https://hq.example/mcp/brain' };
  assert.equal((await api('POST', '/oauth/code', { body: { ...req, user_id: '22222222-2222-4222-8222-222222222222' } })).status, 403); // not the CEO
  assert.equal((await api('POST', '/oauth/code', { body: { ...req, code_challenge_method: 'plain', user_id: CEO } })).status, 400);
  const c1 = await api('POST', '/oauth/code', { body: { ...req, user_id: CEO } });
  assert.equal(c1.status, 200);
  const bad = await api('POST', '/oauth/token', { form: { grant_type: 'authorization_code', client_id: clientId, code: c1.body.code, redirect_uri: REDIRECT, code_verifier: 'x'.repeat(43) } });
  assert.equal(bad.body.error, 'invalid_grant'); // wrong verifier; the code is now spent
  const again = await api('POST', '/oauth/token', { form: { grant_type: 'authorization_code', client_id: clientId, code: c1.body.code, redirect_uri: REDIRECT, code_verifier: verifier } });
  assert.equal(again.body.error, 'invalid_grant');

  // Read-only approval: write tools are not listed and refused.
  const c2 = await api('POST', '/oauth/code', { body: { ...req, user_id: CEO } });
  const t = await api('POST', '/oauth/token', { form: { grant_type: 'authorization_code', client_id: clientId, code: c2.body.code, redirect_uri: REDIRECT, code_verifier: verifier } });
  assert.equal(t.status, 200);
  assert.equal(t.body.token_type, 'Bearer');
  assert.equal(t.body.scope, 'brain:read');
  const list = await mcp('tools/list', {}, t.body.access_token);
  const names = list.body.result.tools.map((x: { name: string }) => x.name);
  assert.ok(names.includes('brain_search'));
  assert.ok(!names.includes('brain_save_session'));
  const refused = await mcp('tools/call', { name: 'brain_save_session', arguments: { project: 'demo', title: 'x' } }, t.body.access_token);
  assert.equal(refused.body.result.isError, true);
  assert.match(toolText(refused), /brain:write/);
});

test('MCP: no token → 401; read tools answer from the index', async () => {
  const c = await api('POST', '/oauth/code', { body: { client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', scopes: ['brain:read', 'brain:write'], user_id: CEO } });
  const t = await api('POST', '/oauth/token', { body: { grant_type: 'authorization_code', client_id: clientId, code: c.body.code, redirect_uri: REDIRECT, code_verifier: verifier } });
  access = t.body.access_token;
  refresh = t.body.refresh_token;
  assert.equal((await api('POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } })).status, 401);
  const init = await mcp('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(init.body.result.protocolVersion, '2025-06-18');
  assert.equal(init.body.result.serverInfo.name, 'hq-brain');
  assert.equal((await api('POST', '/mcp', { body: { jsonrpc: '2.0', method: 'notifications/initialized' }, auth: `Bearer ${access}` })).status, 202);
  const tools = (await mcp('tools/list')).body.result.tools.map((x: { name: string }) => x.name);
  assert.deepEqual(tools.sort(), ['brain_create_project', 'brain_get_document', 'brain_get_setup_kit', 'brain_list_projects', 'brain_load_project', 'brain_recent_activity', 'brain_save_session', 'brain_search', 'brain_update_memory']);
  assert.match(toolText(await mcp('tools/call', { name: 'brain_list_projects', arguments: {} })), /\*\*Demo\*\* \(`demo`\)/);
  const load = toolText(await mcp('tools/call', { name: 'brain_load_project', arguments: { project: 'demo site' } }));
  assert.match(load, /Web developer in Davao/);
  assert.match(load, /## Memory \(projects\/demo\/memory.md\)/);
  const amb = await mcp('tools/call', { name: 'brain_load_project', arguments: { project: 'dem' } });
  assert.equal(amb.body.result.isError, true);
  assert.match(toolText(amb), /several projects/);
  assert.match(toolText(await mcp('tools/call', { name: 'brain_search', arguments: { query: 'Supabase' } })), /projects\/demo\/memory.md/);
  assert.match(toolText(await mcp('tools/call', { name: 'brain_get_setup_kit', arguments: {} })), /Clone the vault/);
  assert.equal((await mcp('nope/method')).body.error.code, -32601);
});

test('brain_save_session: session file + LOG.md + memory.md committed and pushed to the vault, then searchable', async () => {
  const r = await mcp('tools/call', {
    name: 'brain_save_session', arguments: {
      project: 'demo', title: 'Built the connector', source: 'mobile', goal: 'Reach the brain from the phone',
      what_we_did: ['Added OAuth', 'Added MCP tools'], decisions: ['Tokens last one hour'], files: ['apps/brain/src/mcp/server.ts'],
      next_steps: ['Build the UI', 'Wire agents'], facts: [{ section: 'Links', lines: ['Connector: https://hq.example/mcp/brain'] }],
    },
  });
  assert.equal(r.body.result.isError, false, toolText(r));
  g(pc, 'fetch', '-q');
  const files = g(pc, 'ls-tree', '-r', '--name-only', 'origin/main', 'projects/demo/sessions').split('\n');
  const session = files.find((f) => /\d{4}-\d{2}-\d{2}-built-the-connector\.md$/.test(f));
  assert.ok(session, files.join(', '));
  const body = originFile(session!);
  assert.match(body, /^source: mobile$/m);
  assert.match(body, /## What we did\n- Added OAuth\n- Added MCP tools/);
  assert.match(originFile('projects/demo/sessions/LOG.md'), /\[mobile\] Built the connector -> \d{4}-\d{2}-\d{2}-built-the-connector\.md$/);
  const mem = originFile('projects/demo/memory.md');
  assert.match(mem, /- \d{4}-\d{2}-\d{2}: Tokens last one hour\n/);
  assert.match(mem, /- 2026-09-01: Use Supabase\./);
  assert.match(mem, /## Open next steps\n- Build the UI\n- Wire agents$/); // git show output is trimmed
  assert.match(mem, /## Links\n- Connector: https:\/\/hq.example\/mcp\/brain\n/); // the empty "- Site:" placeholder is gone
  assert.doesNotMatch(mem, /updated: 2026-09-01/);
  assert.equal(g(pc, 'log', '-1', '--format=%an', 'origin/main'), 'HQ Brain');
  // Indexed right away: the new decision is searchable without waiting for a webhook.
  assert.match(toolText(await mcp('tools/call', { name: 'brain_search', arguments: { query: 'Tokens last one hour' } })), /memory.md/);
  const ev = await store.exec(`select actor, action from brain_events where action = 'saved' order by id desc limit 1`);
  assert.equal(ev[0]!.actor, 'claude:Claude');
  // Tool calls name the project they touched (the /brain page lights that region up); never the arguments.
  const tc = await store.exec(`select project_slug, summary, meta from brain_events where action = 'tool_call' and summary = 'brain_save_session' order by id desc limit 1`);
  assert.equal(tc[0]!.project_slug, 'demo');
  assert.ok(!JSON.stringify(tc[0]!.meta).includes('Tokens last one hour'));
});

test('a push that loses the race to the PC is redone on the new tree (both changes kept, no merge)', async () => {
  g(pc, 'pull', '-q', 'origin', 'main');
  let first = true;
  const op: VaultOp = (dir, today) => {
    if (first) {
      first = false;
      // Julev's PC pushes a LOG.md line after the VPS pulled and before it pushes.
      pcWrite('projects/demo/sessions/LOG.md', `${fs.readFileSync(path.join(pc, 'projects/demo/sessions/LOG.md'), 'utf8').trimEnd()}\n- 2026-09-30 [claude-code] from the PC -> pc.md`);
      pcPush('pc save');
    }
    return saveSessionOp({ project: 'demo', title: 'Raced save', what_we_did: ['raced'] })(dir, today);
  };
  const r = await service.write(op, 'claude:test');
  assert.ok(r.sha);
  assert.ok(logs.some((l) => /lost a race/.test(l)));
  g(pc, 'fetch', '-q');
  const log = originFile('projects/demo/sessions/LOG.md');
  assert.match(log, /from the PC -> pc\.md\n- \d{4}-\d{2}-\d{2} \[web\] Raced save/);
  assert.equal(g(pc, 'rev-list', '--merges', '--count', 'origin/main'), '0');
});

test('writes refuse secrets and duplicates; brain_create_project fills the template', async () => {
  const leak = await mcp('tools/call', { name: 'brain_update_memory', arguments: { project: 'demo', decisions: [`Use key sk-proj-${'a1'.repeat(20)}`] } });
  assert.equal(leak.body.result.isError, true);
  assert.match(toolText(leak), /secret/);
  const dup = await mcp('tools/call', { name: 'brain_create_project', arguments: { name: 'Demo Site' } });
  assert.equal(dup.body.result.isError, true);
  assert.match(toolText(dup), /already exists as "demo"/);
  const mk = await mcp('tools/call', { name: 'brain_create_project', arguments: { name: 'Spicy Voyage Shopify', aliases: ['spicyvoyage.com'], platform: 'Shopify Horizon', links: ['Site: https://spicyvoyage.com'] } });
  assert.equal(mk.body.result.isError, false, toolText(mk));
  g(pc, 'fetch', '-q');
  const pj = JSON.parse(originFile('projects.json'));
  assert.deepEqual(pj.projects.at(-1), { slug: 'spicy-voyage-shopify', name: 'Spicy Voyage Shopify', aliases: ['spicy voyage shopify', 'spicy-voyage-shopify', 'spicyvoyage.com'], paths: [] });
  const md = originFile('projects/spicy-voyage-shopify/memory.md');
  assert.match(md, /^project: spicy-voyage-shopify$/m);
  assert.match(md, /- Platform \/ stack: Shopify Horizon\n/);
  assert.match(md, /## Links\n- Site: https:\/\/spicyvoyage.com\n/);
  assert.equal(originFile('projects/spicy-voyage-shopify/sessions/LOG.md'), '# Session log');
  // The clone holds no leftovers from the refused writes.
  assert.equal(g(clone, 'status', '--porcelain'), '');
});

test('dashboard writes (/write/memory, /write/project) need the internal secret and commit as the CEO', async () => {
  assert.equal((await api('POST', '/write/memory', { body: { project: 'demo', decisions: ['x'] }, secret: null })).status, 401);
  const bad = await api('POST', '/write/memory', { body: { project: 'nope-nothing' , decisions: ['x'] } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /no project matches/);
  const ok = await api('POST', '/write/memory', { body: { project: 'demo', next_steps: ['[x] Build the UI', 'Wire agents'] } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  g(pc, 'fetch', '-q');
  assert.match(originFile('projects/demo/memory.md'), /## Open next steps\n- \[x\] Build the UI\n- Wire agents/);
  const ev = await store.exec(`select actor from brain_events where action = 'saved' order by id desc limit 1`);
  assert.equal(ev[0]!.actor, 'julev');
});

test('refresh tokens rotate; replaying an old one revokes the connection; revoke ends it', async () => {
  const r1 = await api('POST', '/oauth/token', { form: { grant_type: 'refresh_token', client_id: clientId, refresh_token: refresh } });
  assert.equal(r1.status, 200);
  assert.notEqual(r1.body.refresh_token, refresh);
  assert.equal((await mcp('ping', {}, access)).status, 401); // the old access token died with the rotation
  assert.equal((await mcp('ping', {}, r1.body.access_token)).status, 200);
  const narrower = await api('POST', '/oauth/token', { form: { grant_type: 'refresh_token', client_id: clientId, refresh_token: r1.body.refresh_token, scope: 'brain:read' } });
  assert.equal(narrower.body.scope, 'brain:read');
  // Replay of a spent refresh token: refused, and the whole family is revoked.
  const replay = await api('POST', '/oauth/token', { form: { grant_type: 'refresh_token', client_id: clientId, refresh_token: refresh } });
  assert.equal(replay.body.error, 'invalid_grant');
  assert.equal((await mcp('ping', {}, narrower.body.access_token)).status, 401);

  const c = await api('POST', '/oauth/code', { body: { client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', scopes: ['brain:read'], user_id: CEO } });
  const t = await api('POST', '/oauth/token', { form: { grant_type: 'authorization_code', client_id: clientId, code: c.body.code, redirect_uri: REDIRECT, code_verifier: verifier } });
  assert.equal((await mcp('ping', {}, t.body.access_token)).status, 200);
  assert.equal((await api('POST', '/oauth/revoke', { form: { token: t.body.refresh_token, client_id: clientId } })).status, 200);
  assert.equal((await mcp('ping', {}, t.body.access_token)).status, 401);
  // A CEO who is no longer the CEO: tokens stop working.
  const c2 = await api('POST', '/oauth/code', { body: { client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', scopes: ['brain:read'], user_id: CEO } });
  const t2 = await api('POST', '/oauth/token', { form: { grant_type: 'authorization_code', client_id: clientId, code: c2.body.code, redirect_uri: REDIRECT, code_verifier: verifier } });
  await store.exec(`delete from ceo_users where user_id = $1`, [CEO]);
  assert.equal((await mcp('ping', {}, t2.body.access_token)).status, 401);
  await store.exec(`insert into ceo_users (user_id) values ($1)`, [CEO]);
  // Only hashes are stored.
  const leaked = await store.exec(`select count(*)::int as n from brain_tokens where token_hash = $1`, [t2.body.access_token]);
  assert.equal(leaked[0]!.n, 0);
});
