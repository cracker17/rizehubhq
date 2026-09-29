import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isStorageState, STORAGE_STATE_PREFIX } from '@rizehubhq/shared';
import { loadKeyring, open, seal } from '../vault/crypto';
import { connectorContext, type ConnectorFull, type ConnectorStore, type NewConnector } from './store';
import { DRIVE_SCOPE, authorizeUrl, pkcePair, type StorageSecret } from './storageOAuth';
import { clearStorageTokenCache, driveFindOrCreateFolder, dropboxWebUrl, headerSafeJson, openStorage, safeSegment, type StorageEnv } from './storage';
import { deliverableMarkdown, workspaceFileList } from './storageDeliverable';
import { createStorageConnectorRoutes } from '../routes/storageConnectors';
import { storageTools } from '../tools/storage';
import { reviewNext } from '../qa';
import { FakeHqDb } from '../fakeHqDb';
import { jsonResponse, makeDeps, mockModel } from '../testing';

const kr = loadKeyring({ VAULT_MASTER_KEY: randomBytes(32).toString('base64') })!;
const PUBLIC = 'https://hq.example.ph';
const REDIRECT = `${PUBLIC}/api/connectors/callback`;

// ---------- fakes ----------
interface Call { url: URL; method: string; headers: Record<string, string>; body: Buffer }
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function fakeFetch(handler: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const b = init.body;
    const body = b == null ? Buffer.alloc(0) : typeof b === 'string' ? Buffer.from(b) : b instanceof Uint8Array ? Buffer.from(b) : Buffer.from(String(b));
    const c: Call = { url, method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers).entries()), body };
    calls.push(c);
    return handler(c);
  }) as typeof fetch;
  return { f, calls };
}

function fakeStore(rows: ConnectorFull[] = []) {
  const marks: { id: string; status: string; error?: string | null }[] = [];
  const rotated: string[] = [];
  const store: ConnectorStore = {
    forAgent: async () => [],
    get: async (id) => rows.find((r) => r.id === id) ?? null,
    insert: async (c: NewConnector) => {
      rows.push({ id: c.id, kind: c.kind, status: 'active', name: c.name, account_email: c.accountEmail, url: c.url, auth_type: c.authType, settings: c.settings, sealed: c.sealed });
      return c.id;
    },
    rotate: async (id, sealed) => { rows.find((r) => r.id === id)!.sealed = sealed; rotated.push(id); },
    mark: async (id, status, error) => { marks.push({ id, status, error }); },
    defaultStorage: async () => rows.filter((r) => r.kind === 'storage' && r.status === 'active')
      .sort((a, b) => Number(b.settings.default === true) - Number(a.settings.default === true))[0] ?? null,
  };
  return { store, rows, marks, rotated };
}

function storageRow(provider: 'drive' | 'dropbox', refreshToken = 'rt-1', settings: Record<string, unknown> = {}): ConnectorFull {
  const id = randomUUID();
  const secret: StorageSecret = { kind: 'storage', provider, clientId: 'client-123', clientSecret: 'secret-456', refreshToken };
  return { id, kind: 'storage', status: 'active', name: provider === 'drive' ? 'Google Drive' : 'Dropbox', account_email: null, url: null,
    auth_type: 'oauth', settings: { provider, ...settings }, sealed: seal(JSON.stringify(secret), kr, connectorContext(id)) };
}

const form = (c: Call) => Object.fromEntries(new URLSearchParams(c.body.toString('utf8')));
const post = (routes: ReturnType<typeof createStorageConnectorRoutes>, p: string, body: unknown) =>
  routes.find((r) => r.path === p)!.handle({} as never, Buffer.from(JSON.stringify(body)));

// ---------- OAuth ----------
test('storage oauth: Drive authorize URL = drive.file only, offline + consent, PKCE S256, "st_" state', async () => {
  const { store } = fakeStore();
  const routes = createStorageConnectorRoutes({ store: () => store, keyring: () => kr, publicUrl: () => PUBLIC });
  const [status, body] = await post(routes, '/connectors/storage/start', { provider: 'drive', clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret' });
  assert.equal(status, 200);
  const u = new URL((body as { authorizeUrl: string }).authorizeUrl);
  assert.equal(`${u.origin}${u.pathname}`, 'https://accounts.google.com/o/oauth2/v2/auth');
  const q = Object.fromEntries(u.searchParams);
  assert.equal(q.scope, DRIVE_SCOPE);
  assert.equal(q.access_type, 'offline');
  assert.equal(q.prompt, 'consent');
  assert.equal(q.response_type, 'code');
  assert.equal(q.redirect_uri, REDIRECT);
  assert.equal(q.client_id, '123-abc.apps.googleusercontent.com');
  assert.equal(q.code_challenge_method, 'S256');
  assert.match(q.code_challenge!, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(q.state!.startsWith(STORAGE_STATE_PREFIX) && isStorageState(q.state));
  assert.doesNotMatch(u.toString(), /GOCSPX-secret/, 'the client secret never goes to the browser');
});

test('storage oauth: Dropbox authorize URL = token_access_type=offline, PKCE, no scope (the app\'s Permissions decide)', () => {
  const { verifier, challenge } = pkcePair();
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
  const u = new URL(authorizeUrl({ provider: 'dropbox', clientId: 'appkey', redirectUri: REDIRECT, state: 'st_x', challenge }));
  assert.equal(`${u.origin}${u.pathname}`, 'https://www.dropbox.com/oauth2/authorize');
  assert.equal(u.searchParams.get('token_access_type'), 'offline');
  assert.equal(u.searchParams.get('code_challenge'), challenge);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('scope'), null);
  assert.equal(u.searchParams.get('access_type'), null);
});

test('storage oauth: MCP sign-in states never look like storage states', async () => {
  // The shared callback routes by this prefix; mcpClient.startSignIn re-draws any state that would match it.
  assert.equal(isStorageState('st_abc'), true);
  assert.equal(isStorageState('abcst_'), false);
  assert.equal(isStorageState(null), false);
});

test('storage finish (Drive): code + PKCE verifier exchanged, refresh token sealed, kind storage, account read; state works once', async () => {
  const { store, rows } = fakeStore();
  let tokenBody: Record<string, string> = {};
  const { f, calls } = fakeFetch((c) => {
    if (c.url.href === 'https://oauth2.googleapis.com/token') {
      tokenBody = form(c);
      assert.equal(c.headers['content-type'], 'application/x-www-form-urlencoded');
      return json({ access_token: 'at-1', expires_in: 3599, refresh_token: 'rt-1', scope: DRIVE_SCOPE, token_type: 'Bearer' });
    }
    if (c.url.pathname === '/drive/v3/about') return json({ user: { emailAddress: 'CEO@gmail.com', displayName: 'CEO' } });
    return json({}, 404);
  });
  const routes = createStorageConnectorRoutes({ store: () => store, keyring: () => kr, publicUrl: () => PUBLIC, fetch: f });
  const [, started] = await post(routes, '/connectors/storage/start', { provider: 'drive', clientId: 'cid-12345678', clientSecret: 'csecret-123', name: 'My Drive' });
  const u = new URL((started as { authorizeUrl: string }).authorizeUrl);
  const state = u.searchParams.get('state')!;
  const [status, body] = await post(routes, '/connectors/storage/finish', { state, code: '4/code-from-google' });
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual({ ...tokenBody, code_verifier: undefined }, {
    grant_type: 'authorization_code', code: '4/code-from-google', redirect_uri: REDIRECT, code_verifier: undefined,
    client_id: 'cid-12345678', client_secret: 'csecret-123',
  });
  assert.equal(createHash('sha256').update(tokenBody.code_verifier!).digest('base64url'), u.searchParams.get('code_challenge'), 'PKCE verifier matches');
  const row = rows[0]!;
  assert.equal(row.kind, 'storage');
  assert.equal(row.name, 'My Drive');
  assert.equal(row.account_email, 'CEO@gmail.com');
  assert.deepEqual(row.settings, { provider: 'drive' });
  const secret = JSON.parse(open(row.sealed!, kr, connectorContext(row.id))) as StorageSecret;
  assert.deepEqual(secret, { kind: 'storage', provider: 'drive', clientId: 'cid-12345678', clientSecret: 'csecret-123', refreshToken: 'rt-1' });
  assert.doesNotMatch(JSON.stringify(body), /rt-1|at-1|csecret/, 'no token or secret in the response');
  assert.equal(calls.filter((c) => c.url.pathname === '/drive/v3/about')[0]!.headers.authorization, 'Bearer at-1');
  const [again] = await post(routes, '/connectors/storage/finish', { state, code: 'x' });
  assert.equal(again, 400, 'a state is used once');
});

test('storage finish: no refresh token or a missing scope is refused; a bad client secret is explained', async () => {
  for (const [provider, tokenRes, re] of [
    ['drive', { access_token: 'a', expires_in: 3600, scope: DRIVE_SCOPE }, /refresh token/],
    ['drive', { access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'openid' }, /Drive access was not granted/],
    ['dropbox', { access_token: 'a', refresh_token: 'r', expires_in: 14400, scope: 'account_info.read files.metadata.read' }, /files\.content\.write/],
    ['dropbox', { error: 'invalid_client', error_description: 'Invalid client_id or client_secret' }, /rejected the client ID or secret/],
  ] as const) {
    const { store, rows } = fakeStore();
    const { f } = fakeFetch((c) => (c.url.pathname.endsWith('/token') ? json(tokenRes, 'error' in tokenRes ? 400 : 200) : json({ email: 'x@y.z' })));
    const routes = createStorageConnectorRoutes({ store: () => store, keyring: () => kr, publicUrl: () => PUBLIC, fetch: f });
    const [, started] = await post(routes, '/connectors/storage/start', { provider, clientId: 'cid-12345678', clientSecret: 'csecret-123' });
    const state = new URL((started as { authorizeUrl: string }).authorizeUrl).searchParams.get('state');
    const [status, body] = await post(routes, '/connectors/storage/finish', { state, code: 'c' });
    assert.equal(status, 400);
    assert.match((body as { error: string }).error, re);
    assert.equal(rows.length, 0, 'nothing stored');
  }
});

// ---------- tokens ----------
test('storage tokens: refresh with the refresh token; a rotated refresh token is re-sealed; invalid_grant → needs_reauth', async () => {
  clearStorageTokenCache();
  const row = storageRow('drive', 'rt-old');
  const { store, marks, rotated } = fakeStore([row]);
  let reply: Record<string, unknown> = { access_token: 'at-2', expires_in: 3600 };
  let status = 200;
  const { f, calls } = fakeFetch((c) => {
    if (c.url.href === 'https://oauth2.googleapis.com/token') return json(reply, status);
    if (c.url.pathname === '/drive/v3/about') return json({ user: { emailAddress: 'ceo@gmail.com' } });
    return json({}, 404);
  });
  const env: StorageEnv = { store, keyring: kr, fetch: f };
  const s = (await openStorage(env))!;
  assert.equal(await s.check(), 'ceo@gmail.com');
  assert.deepEqual(form(calls[0]!), { grant_type: 'refresh_token', refresh_token: 'rt-old', client_id: 'client-123', client_secret: 'secret-456' });
  assert.equal(calls[1]!.headers.authorization, 'Bearer at-2');
  assert.deepEqual(rotated, [], 'same refresh token: nothing re-sealed');

  reply = { access_token: 'at-3', expires_in: 3600, refresh_token: 'rt-new' };
  await s.check();
  assert.deepEqual(rotated, [row.id]);
  assert.equal((JSON.parse(open(row.sealed!, kr, connectorContext(row.id))) as StorageSecret).refreshToken, 'rt-new');

  status = 400; reply = { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' };
  await assert.rejects(s.check(), /invalid_grant/);
  assert.equal(marks.at(-1)?.status, 'needs_reauth');
});

// ---------- Google Drive ----------
test('Drive save: folder path found or created by name + parent (quotes escaped), multipart upload into it, private link', async () => {
  clearStorageTokenCache();
  const row = storageRow('drive');
  const { store, marks } = fakeStore([row]);
  const queries: string[] = [];
  const created: Record<string, unknown>[] = [];
  const { f, calls } = fakeFetch((c) => {
    if (c.url.pathname.endsWith('/token')) return json({ access_token: 'at', expires_in: 3600 });
    if (c.url.pathname === '/drive/v3/files' && c.method === 'GET') {
      const q = c.url.searchParams.get('q')!;
      queries.push(q);
      return json({ files: q.includes("name = 'Madam Muse'") ? [{ id: 'f-client', name: 'Madam Muse' }] : [] });
    }
    if (c.url.pathname === '/drive/v3/files' && c.method === 'POST') {
      const b = JSON.parse(c.body.toString('utf8')) as { name: string };
      created.push(b);
      return json({ id: `f-${b.name.slice(0, 4)}` });
    }
    if (c.url.pathname === '/upload/drive/v3/files') return json({ id: 'file-1', name: 'x', webViewLink: 'https://drive.google.com/file/d/file-1/view' });
    return json({}, 404);
  });
  const s = (await openStorage({ store, keyring: kr, fetch: f }))!;
  const saved = await s.save({ clientName: 'Madam Muse', requestTitle: "CEO's launch", fileName: 'brief.md', bytes: Buffer.from('# Hello'), mimeType: 'text/markdown' });
  assert.deepEqual(queries, [
    "name = 'RizeHub HQ' and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and trashed = false",
    "name = 'Madam Muse' and mimeType = 'application/vnd.google-apps.folder' and 'f-Rize' in parents and trashed = false",
    "name = 'CEO\\'s launch' and mimeType = 'application/vnd.google-apps.folder' and 'f-client' in parents and trashed = false",
  ]);
  assert.deepEqual(created, [
    { name: 'RizeHub HQ', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] },
    { name: "CEO's launch", mimeType: 'application/vnd.google-apps.folder', parents: ['f-client'] },
  ]);
  const up = calls.find((c) => c.url.pathname === '/upload/drive/v3/files')!;
  assert.equal(up.method, 'POST');
  assert.equal(up.url.searchParams.get('uploadType'), 'multipart');
  assert.match(up.url.searchParams.get('fields')!, /webViewLink/);
  const boundary = /^multipart\/related; boundary=(.+)$/.exec(up.headers['content-type']!)![1]!;
  const text = up.body.toString('utf8');
  assert.ok(text.startsWith(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"brief.md","parents":["f-CEO'"]}\r\n--${boundary}\r\nContent-Type: text/markdown\r\n\r\n# Hello\r\n--${boundary}--`), text);
  assert.equal(up.headers.authorization, 'Bearer at');
  assert.equal(saved.url, 'https://drive.google.com/file/d/file-1/view');
  assert.equal(saved.folderUrl, "https://drive.google.com/drive/folders/f-CEO'");
  assert.equal(saved.path, "RizeHub HQ/Madam Muse/CEO's launch/brief.md");
  assert.ok(!calls.some((c) => /permissions|sharing|create_shared_link/.test(c.url.href)), 'never creates a shared link');
  assert.equal(marks.at(-1)?.status, 'active');
  // a second save in the same folder reuses the cached folder ids
  const before = queries.length;
  await s.save({ clientName: 'Madam Muse', requestTitle: "CEO's launch", fileName: 'b.md', bytes: Buffer.from('b'), mimeType: 'text/markdown' });
  assert.equal(queries.length, before);
  // backslashes are escaped too (folder names reach the query only after safeSegment, which already drops them)
  await driveFindOrCreateFolder(f, 'at', 'a\\b', 'root');
  assert.equal(queries.at(-1), "name = 'a\\\\b' and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and trashed = false");
});

test('Drive save: files over 5 MB use a resumable session (init with X-Upload headers, then PUT)', async () => {
  clearStorageTokenCache();
  const { store } = fakeStore([storageRow('drive')]);
  const session = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=abc';
  const { f, calls } = fakeFetch((c) => {
    if (c.url.pathname.endsWith('/token')) return json({ access_token: 'at', expires_in: 3600 });
    if (c.url.pathname === '/drive/v3/files' && c.method === 'GET') return json({ files: [{ id: 'fid' }] });
    if (c.method === 'POST' && c.url.searchParams.get('uploadType') === 'resumable') return new Response(null, { status: 200, headers: { location: session } });
    if (c.method === 'PUT' && c.url.href === session) return json({ id: 'big', webViewLink: 'https://drive.google.com/file/d/big/view' });
    return json({}, 404);
  });
  const bytes = Buffer.alloc(6 * 1024 * 1024, 7);
  const s = (await openStorage({ store, keyring: kr, fetch: f }))!;
  const saved = await s.save({ clientName: null, requestTitle: 'Video', fileName: 'clip.mp4', bytes, mimeType: 'video/mp4' });
  const init = calls.find((c) => c.url.searchParams.get('uploadType') === 'resumable' && c.method === 'POST')!;
  assert.equal(init.headers['x-upload-content-type'], 'video/mp4');
  assert.equal(init.headers['x-upload-content-length'], String(bytes.length));
  assert.deepEqual(JSON.parse(init.body.toString('utf8')), { name: 'clip.mp4', parents: ['fid'] });
  const put = calls.find((c) => c.method === 'PUT')!;
  assert.equal(put.body.length, bytes.length);
  assert.equal(put.headers.authorization, undefined, 'the session URI carries the authorization');
  assert.equal(saved.url, 'https://drive.google.com/file/d/big/view');
  assert.ok(saved.path.startsWith('RizeHub HQ/Internal/Video/'), 'no client → Internal');
});

// ---------- Dropbox ----------
test('Dropbox save: /2/files/upload with header-safe Dropbox-API-Arg into the app folder; link opens the folder', async () => {
  clearStorageTokenCache();
  const { store } = fakeStore([storageRow('dropbox', 'rt', { appFolder: 'RizeHub HQ' })]);
  const { f, calls } = fakeFetch((c) => {
    if (c.url.href === 'https://api.dropboxapi.com/oauth2/token') return json({ access_token: 'sl.at', expires_in: 14400, token_type: 'bearer' });
    if (c.url.href === 'https://content.dropboxapi.com/2/files/upload') {
      return json({ name: 'brief.md', path_display: '/Madam Muse/Café launch/brief.md', id: 'id:1' });
    }
    return json({}, 404);
  });
  const s = (await openStorage({ store, keyring: kr, fetch: f }))!;
  const saved = await s.save({ clientName: 'Madam Muse', requestTitle: 'Café launch', fileName: 'brief.md', bytes: Buffer.from('hi'), mimeType: 'text/markdown' });
  const up = calls.find((c) => c.url.host === 'content.dropboxapi.com')!;
  const arg = up.headers['dropbox-api-arg']!;
  assert.match(arg, /Caf\\u00e9/);
  assert.ok(/^[\x20-\x7e]+$/.test(arg), 'ASCII only');
  assert.deepEqual(JSON.parse(arg), { path: '/Madam Muse/Café launch/brief.md', mode: 'add', autorename: true, mute: false });
  assert.equal(up.headers['content-type'], 'application/octet-stream');
  assert.equal(up.headers.authorization, 'Bearer sl.at');
  assert.equal(up.body.toString(), 'hi');
  assert.equal(saved.folderUrl, 'https://www.dropbox.com/home/Apps/RizeHub%20HQ/Madam%20Muse/Caf%C3%A9%20launch');
  assert.equal(saved.url, `${saved.folderUrl}?preview=brief.md`);
  assert.equal(saved.path, 'Apps/RizeHub HQ/Madam Muse/Café launch/brief.md');
  assert.ok(!calls.some((c) => /sharing/.test(c.url.pathname)), 'never creates a shared link');
});

test('storage helpers: safe names, header JSON, markdown, workspace file list', () => {
  assert.equal(safeSegment('a/b\\c:d*?"<>|e'), 'a-b-c-d------e');
  assert.equal(safeSegment('  ..  '), 'Untitled');
  assert.equal(safeSegment('name.  '), 'name');
  assert.equal(safeSegment(null, 'Internal'), 'Internal');
  assert.equal(safeSegment('x'.repeat(300)).length, 100);
  assert.equal(headerSafeJson({ p: 'ñ✓' }), '{"p":"\\u00f1\\u2713"}');
  assert.equal(dropboxWebUrl(null, '/Internal/x'), 'https://www.dropbox.com/home/Apps/RizeHub%20HQ/Internal/x');
  assert.equal(deliverableMarkdown({ title: 'T', output: {} }), null);
  assert.match(deliverableMarkdown({ title: 'T', output: { summary: 'S', content: 'Body', links: ['https://a.b'] } })!, /^# T\n\nS\n\n---\n\nBody\n\n## Links\n- https:\/\/a\.b\n$/);
  assert.deepEqual(workspaceFileList({ files: ['out/a.png', './b.txt', 'https://x.y/z', '/etc/passwd', 'brain/sops/x.md', 'C:\\x', 'out/a.png', 3] }), ['out/a.png', 'b.txt']);
});

// ---------- save_file tool ----------
function toolSetup(opts: { storage: StorageEnv | null }) {
  const db = new FakeHqDb();
  const clientId = randomUUID();
  db.clients.set(clientId, { id: clientId, name: 'Madam Muse', slug: 'madam-muse', platforms: [], website: null, service_package: null, status: 'active', notes: null });
  const req = db.addRequest({ raw_text: 'x', title: 'Spring launch' });
  const task = db.addTask({ agent_id: 'designer', request_id: req.id, client_id: clientId, title: 'Hero banner' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-storage-'));
  fs.mkdirSync(path.join(dir, task.id, 'exports'), { recursive: true });
  fs.writeFileSync(path.join(dir, task.id, 'exports', 'hero.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'secret');
  const deps = { db, log: () => undefined, storage: opts.storage, workspacesDir: dir };
  const tools = storageTools({ task, deps, role: {}, state: {} } as never) as Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }>;
  const run = async (input: Record<string, unknown>) => String(await tools.save_file!.execute(input, { toolCallId: 'x', messages: [] }));
  return { db, task, dir, run };
}

function dropboxEnv() {
  clearStorageTokenCache();
  const { store } = fakeStore([storageRow('dropbox', 'rt', { appFolder: 'HQ' })]);
  const uploads: { path: string; body: Buffer }[] = [];
  const { f } = fakeFetch((c) => {
    if (c.url.pathname === '/oauth2/token') return json({ access_token: 'at', expires_in: 14400 });
    if (c.url.pathname === '/2/files/upload') {
      const p = (JSON.parse(c.headers['dropbox-api-arg']!) as { path: string }).path;
      uploads.push({ path: p, body: c.body });
      return json({ name: p.split('/').pop(), path_display: p });
    }
    return json({}, 404);
  });
  return { env: { store, keyring: kr, fetch: f } as StorageEnv, uploads };
}

test('save_file: text content or a workspace file → client/request folder; outside paths refused; activity logged', async () => {
  const { env, uploads } = dropboxEnv();
  const { db, run } = toolSetup({ storage: env });
  const r1 = await run({ content: '# Copy', file_name: 'copy.md' });
  assert.match(r1, /Saved to Dropbox.*Apps\/HQ\/Madam Muse\/Spring launch\/copy\.md/s);
  assert.match(r1, /https:\/\/www\.dropbox\.com\/home\/Apps\/HQ\/Madam%20Muse\/Spring%20launch\?preview=copy\.md/);
  const r2 = await run({ path: 'exports/hero.png' });
  assert.match(r2, /hero\.png/);
  assert.deepEqual(uploads.map((u) => u.path), ['/Madam Muse/Spring launch/copy.md', '/Madam Muse/Spring launch/hero.png']);
  assert.deepEqual([...uploads[1]!.body], [0x89, 0x50, 0x4e, 0x47]);
  assert.match(await run({ path: '../outside.txt' }), /^Refused/);
  assert.match(await run({ path: '.env' }), /^Refused/);
  assert.match(await run({ path: 'nope.png' }), /no such file/);
  assert.match(await run({ content: 'x' }), /file_name/);
  assert.match(await run({ content: 'x', file_name: 'a', path: 'b' }), /either/);
  assert.equal(uploads.length, 2, 'refusals upload nothing');
  assert.equal(db.activity.filter((a) => a.action === 'storage.saved').length, 2);
});

test('save_file: no storage connected → a plain sentence, nothing uploaded', async () => {
  const { store } = fakeStore([]);
  const { run } = toolSetup({ storage: { store, keyring: kr, fetch: (() => { throw new Error('no network'); }) as never } });
  assert.match(await run({ content: 'x', file_name: 'a.md' }), /No storage is connected/);
});

// ---------- QA auto-save ----------
const CRITERIA = ['a', 'b', 'c'];
const passVerdict = { verdict: 'pass', score: 95, summary: 's', checks: CRITERIA.map((criterion) => ({ criterion, result: 'pass', note: 'n' })), fix_list: [] };

function qaSetup(storage: StorageEnv | undefined, files: string[] = []) {
  const db = new FakeHqDb();
  const req = db.addRequest({ raw_text: 'x', title: 'Blog sprint' });
  const task = db.addTask({ agent_id: 'writer', request_id: req.id, status: 'qa_pending', acceptance_criteria: CRITERIA, title: 'Speed article',
    output: { summary: 'Article', content: 'BODY', files, links: [] } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-qa-'));
  if (files.length) { fs.mkdirSync(path.join(dir, task.id, 'out'), { recursive: true }); fs.writeFileSync(path.join(dir, task.id, 'out', 'chart.svg'), '<svg/>'); }
  const recorded: unknown[] = [];
  if (storage) storage.recordTask = async (id, s) => { recorded.push({ id, s }); };
  const deps = { ...makeDeps({ db, model: mockModel([jsonResponse(passVerdict)]) }), storage, workspacesDir: dir };
  return { db, task, deps, recorded };
}

test('QA pass → the deliverable text + its workspace files are saved; links recorded on the task; activity storage.saved', async () => {
  const { env, uploads } = dropboxEnv();
  const { db, task, deps, recorded } = qaSetup(env, ['out/chart.svg', '../escape.txt', 'https://site.example/page']);
  const out = await reviewNext(deps);
  assert.equal(out.status === 'recorded' && out.result, 'pass');
  assert.deepEqual(uploads.map((u) => u.path), ['/Internal/Blog sprint/Speed article.md', '/Internal/Blog sprint/chart.svg']);
  assert.match(uploads[0]!.body.toString(), /^# Speed article\n\nArticle\n\n---\n\nBODY/);
  const rec = recorded[0] as { id: string; s: { provider: string; files: { name: string }[]; skipped: string[] } };
  assert.equal(rec.id, task.id);
  assert.equal(rec.s.provider, 'dropbox');
  assert.deepEqual(rec.s.files.map((f) => f.name), ['Speed article.md', 'chart.svg']);
  assert.equal(rec.s.skipped.length, 1);
  const act = db.activity.find((a) => a.action === 'storage.saved')!;
  assert.equal(act.task_id, task.id);
  assert.equal(db.tasks.get(task.id)!.status, 'awaiting_ceo');
});

test('QA pass with failing storage → storage.failed logged, the verdict still stands; no storage → nothing at all', async () => {
  clearStorageTokenCache();
  const { store } = fakeStore([storageRow('drive')]);
  const broken: StorageEnv = { store, keyring: kr, fetch: (async () => json({ error: 'server_error' }, 500)) as never };
  const a = qaSetup(broken);
  const out = await reviewNext(a.deps);
  assert.equal(out.status === 'recorded' && out.result, 'pass');
  assert.equal(a.db.tasks.get(a.task.id)!.status, 'awaiting_ceo');
  const failed = a.db.activity.find((x) => x.action === 'storage.failed')!;
  assert.equal(failed.detail.provider, 'drive');
  assert.match(String(failed.detail.error), /server_error|HTTP 500/);
  assert.equal(a.recorded.length, 0);

  const b = qaSetup(undefined);
  const out2 = await reviewNext(b.deps);
  assert.equal(out2.status === 'recorded' && out2.result, 'pass');
  assert.equal(b.db.activity.filter((x) => x.action.startsWith('storage.')).length, 0);
});
