// P2 end to end against the real migrations: invite → join → connector token (subject person) → every MCP tool only
// shows granted projects; owner-only files and transcripts stay hidden; writes need edit access; disabling cuts off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPgliteStore, defaultMigrationsDir, type PgliteStore } from './store/pglite';
import { handleMcpPost, type McpDeps } from './mcp/server';
import { canSeePath, ownerOnly, type Access } from './access';
import { joinWithInvite, passwordProblem, peekInvite } from './people';
import type { BrainService } from './service';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

test('visibility rules', () => {
  const member: Access = { role: 'member', personId: 'p', email: 'a@b.co', name: 'A', grants: new Map([['alpha', { slug: 'alpha', access: 'read', transcripts: false }]]) };
  assert.equal(canSeePath(member, 'projects/alpha/memory.md'), true);
  assert.equal(canSeePath(member, 'projects/beta/memory.md'), false);
  assert.equal(canSeePath(member, 'projects/alpha/sessions/2026-11-01-code-abc123ef.md'), false, 'transcripts off by default');
  assert.equal(canSeePath({ ...member, grants: new Map([['alpha', { slug: 'alpha', access: 'read', transcripts: true }]]) }, 'projects/alpha/sessions/2026-11-01-code-abc123ef.md'), true);
  assert.equal(canSeePath(member, 'profile/profile.md'), false);
  assert.equal(canSeePath({ ...member, role: 'admin' }, 'profile/profile.md'), false, 'owner-only even for admins');
  assert.equal(canSeePath({ ...member, role: 'admin' }, 'projects/beta/memory.md'), true);
  for (const p of ['env-index.md', 'CLAUDE.md', 'scheduled-tasks/x.md', 'projects/alpha/secrets-map.md', 'devices/d.md', 'LOG.md']) assert.equal(ownerOnly(p), true, p);
  assert.equal(passwordProblem('short', 'a@b.co'), 'Use at least 12 characters.');
  assert.equal(passwordProblem('a-long-enough-pass', 'a@b.co'), null);
});

test('invite → join → filtered connector', async () => {
  const store: PgliteStore = await createPgliteStore(defaultMigrationsDir());
  // two projects + owner-only files + a transcript
  await store.rpc('brain_sync_projects', { p_projects: [
    { slug: 'alpha', name: 'Alpha Shop', aliases: [], paths: [], listed: true, status: null, links: [] },
    { slug: 'beta', name: 'Beta Client', aliases: [], paths: [], listed: true, status: null, links: [] },
  ] });
  const doc = async (path: string, project: string | null, kind: string, body: string) => store.rpc('brain_upsert_document', {
    p_doc: { path, project_slug: project, kind, title: path, doc_date: '2026-11-01', frontmatter: {}, body, content_sha: sha(path), git_sha: null },
    p_chunks: [{ heading: '', text: body, text_sha: sha(body) }], p_decisions: [], p_next_steps: [],
  });
  await doc('projects/alpha/memory.md', 'alpha', 'memory', 'Alpha memory: uses Shopify widgets');
  await doc('projects/beta/memory.md', 'beta', 'memory', 'Beta memory: secret client widgets plan');
  await doc('projects/alpha/sessions/2026-11-01-code-abc123ef.md', 'alpha', 'transcript', 'Alpha transcript widgets talk');
  await doc('profile/profile.md', null, 'profile', 'Julev profile widgets');
  await store.rpc('brain_refresh_projects');

  // invite (CEO API; a direct session passes hq_guard like the tests elsewhere)
  const inv = await store.rpc<{ id: string; code: string }>('brain_person_invite', { p: { email: 'Ana@Example.com', name: 'Ana', role: 'member', grants: [{ slug: 'alpha', access: 'read' }] } });
  assert.match(inv.code, /^[0-9a-f]{40}$/);
  assert.deepEqual((await peekInvite(store, inv.code))?.email, 'ana@example.com');
  assert.equal((await joinWithInvite(store, inv.code, 'short', () => {}))[0], 400);
  const joined = await joinWithInvite(store, inv.code, 'a-strong-password-1', () => {});
  assert.equal(joined[0], 200);
  assert.equal((await joinWithInvite(store, inv.code, 'a-strong-password-1', () => {}))[0], 410, 'single use');
  const [u] = await store.exec(`select user_id from brain_people where id = $1`, [inv.id]);

  // a connector token for her (what the OAuth flow issues after she approves)
  const token = 'hqb_at_test_person_token_000000000000000';
  await store.rpc('brain_token_issue', { p: { family_id: '33333333-3333-4333-8333-333333333333', client_id: null, user_id: u.user_id, subject: 'person', scopes: ['brain:read', 'brain:write'], resource: null, access: { hash: sha(token), ttl_seconds: 3600 } } });

  const writes: string[] = [];
  const deps: McpDeps = {
    store, embedder: null, vaultDir: '/nonexistent', log: () => {},
    service: { write: async (_op: unknown, actor: string) => { writes.push(actor); return { project: 'alpha', paths: ['x'], summary: 's', sha: 'abcdef1', detail: {} }; } } as unknown as BrainService,
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await handleMcpPost(deps, `Bearer ${token}`, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })));
    const res = (r.body as { result: { content: Array<{ text: string }>; isError: boolean } }).result;
    if (!res) throw new Error(`MCP ${name}: ${r.status} ${JSON.stringify(r.body)}`);
    return { text: res.content[0]!.text, isError: res.isError };
  };

  const list = await call('brain_list_projects');
  assert.match(list.text, /Alpha Shop/);
  assert.doesNotMatch(list.text, /Beta/);

  const loadBeta = await call('brain_load_project', { project: 'beta' });
  assert.equal(loadBeta.isError, true);
  assert.doesNotMatch(loadBeta.text, /Beta Client/, 'the error never names a hidden project');

  const load = await call('brain_load_project', { project: 'alpha' });
  assert.match(load.text, /Alpha memory/);
  assert.doesNotMatch(load.text, /profile/i, 'no owner profile for people');

  const search = await call('brain_search', { query: 'widgets', include_transcripts: true });
  assert.match(search.text, /projects\/alpha\/memory\.md/);
  assert.doesNotMatch(search.text, /beta|profile|code-abc123ef/);

  assert.equal((await call('brain_get_document', { path: 'projects/beta/memory.md' })).isError, true);
  assert.equal((await call('brain_get_document', { path: 'profile/profile.md' })).isError, true);
  assert.equal((await call('brain_get_document', { path: 'projects/alpha/memory.md' })).isError, false);

  const save = await call('brain_save_session', { project: 'alpha', title: 'x' });
  assert.equal(save.isError, true);
  assert.match(save.text, /can read alpha but not edit/);

  // edit access → saves go through, attributed to her
  await store.rpc('brain_set_grants', { p_person: inv.id, p_grants: [{ slug: 'alpha', access: 'write' }] });
  assert.equal((await call('brain_save_session', { project: 'alpha', title: 'x' })).isError, false);
  assert.deepEqual(writes, ['user:ana@example.com']);
  assert.equal((await call('brain_create_project', { name: 'New' })).isError, true, 'members cannot create projects');

  const tools = await handleMcpPost(deps, `Bearer ${token}`, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })));
  assert.ok(!(tools.body as { result: { tools: Array<{ name: string }> } }).result.tools.some((t) => t.name === 'brain_create_project'));

  // disable → cut off at once
  await store.rpc('brain_person_disable', { p_person: inv.id, p_disabled: true });
  const gone = await handleMcpPost(deps, `Bearer ${token}`, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })));
  assert.equal(gone.status, 401);

  // viewers never get write scope from the consent step
  const v = await store.rpc<{ id: string; code: string }>('brain_person_invite', { p: { email: 'v@example.com', name: 'Vi', role: 'viewer', grants: [{ slug: 'alpha', access: 'write' }] } });
  await joinWithInvite(store, v.code, 'another-strong-pass', () => {});
  const [vu] = await store.exec(`select user_id from brain_people where id = $1`, [v.id]);
  const cid = 'hqbc_testclient00000000';
  const h1 = sha('code-1');
  await store.exec(`insert into brain_oauth_clients (client_id, client_name, redirect_uris) values ($1, 'Claude', '{https://claude.ai/cb}')`, [cid]);
  await store.rpc('brain_oauth_issue_code', { p: { code_hash: h1, client_id: cid, user_id: vu.user_id, redirect_uri: 'https://claude.ai/cb', code_challenge: 'x'.repeat(43), scopes: ['brain:read', 'brain:write'] } });
  const [code] = await store.exec(`select scopes from brain_oauth_codes where code_hash = $1`, [h1]);
  assert.deepEqual(code.scopes, ['brain:read']);
  const redeemed = await store.rpc<{ subject: string }>('brain_oauth_redeem_code', { p_code_hash: h1, p_client_id: cid });
  assert.equal(redeemed.subject, 'person');
  await store.close?.();
});
