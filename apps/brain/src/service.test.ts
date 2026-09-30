// End to end without network: a temp git repo plays GitHub, PGlite runs the real migrations, embeddings are fake.
// Covers clone → index → incremental edit/delete → rewritten upstream history → the HTTP API and the GitHub webhook.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createPgliteStore, defaultMigrationsDir } from './store/pglite';
import type { Store } from './store/types';
import { fakeEmbedder } from './index/embed';
import { indexVault } from './index/indexer';
import { createBrainService, type BrainService } from './service';
import { createHttpServer } from './http';
import { changedFiles } from './git/sync';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-brain-test-'));
const origin = path.join(tmp, 'origin');
const clone = path.join(tmp, 'clone', 'vault');
const g = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Julev', '-c', 'user.email=j@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' }).toString().trim();
const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(origin, rel)), { recursive: true }); fs.writeFileSync(path.join(origin, rel), text); };
const commit = (msg: string) => { g(origin, 'add', '-A'); g(origin, 'commit', '-q', '-m', msg); return g(origin, 'rev-parse', 'HEAD'); };

const MEMORY = (extra = '') => `---\nproject: demo\nupdated: 2026-09-30\n---\n# Demo\n\n## Status\n- M1 in build\n\n## Decisions log\n- 2026-09-29: Deploy with an SSH deploy key.\n${extra}\n## Open next steps\n- Build the indexer\n`;
const SECRET_FILE = `# oops\nopenai = sk-proj-${'abcd'.repeat(10)}\n`;

let store: Store;
let service: BrainService;
const logs: string[] = [];
const git = { repoUrl: origin, branch: 'main', dir: clone };

before(async () => {
  fs.mkdirSync(origin, { recursive: true });
  g(origin, 'init', '-q', '-b', 'main');
  write('projects.json', JSON.stringify({ projects: [{ slug: 'demo', name: 'Demo Project', aliases: ['demo'] }, { slug: 'other', name: 'Other' }] }));
  write('projects/demo/memory.md', MEMORY());
  write('projects/demo/sessions/2026-09-30-first.md', '# First session\n\nWe set up Hostinger Git auto-deploy.');
  write('projects/demo/sessions/LOG.md', '# Session log\n- 2026-09-30 first');
  write('projects/other/memory.md', '# Other\n\n## Status\n- idle');
  write('profile/profile.md', '# Julev\n\n- Web developer in Davao.');
  write('projects/demo/leak.md', SECRET_FILE);
  write('projects/demo/sessions/2026-09-30-code-abc123.md', '# Claude Code session\n\nzebrafish transcript line');
  write('projects/demo/huge.md', `# Huge\n\n${'lorem ipsum '.repeat(50_000)}`);
  commit('init');
  store = await createPgliteStore(defaultMigrationsDir());
  service = createBrainService({ store, embedder: fakeEmbedder(), git, log: (m) => logs.push(m) });
});

after(async () => {
  await store?.close?.();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('first sync clones and indexes everything except the secret file', async () => {
  const r = await service.sync({ reason: 'boot' });
  assert.ok(r);
  assert.equal(r.files, 6);
  assert.equal(r.added.length, 6);
  assert.deepEqual(r.blocked.map((b) => `${b.kind} ${b.path}`), ['size projects/demo/huge.md', 'secret projects/demo/leak.md']);
  assert.equal(r.pendingEmbeddings, 0);
  const h = await store.rpc<Record<string, unknown>>('brain_health');
  assert.equal(h.documents, 6);
  assert.equal(h.embedded, h.chunks);
  assert.equal(h.embed_model, 'fake:hash-1536');
  const bundle = await store.rpc<any>('brain_project_bundle', { p_slug: 'demo', p_sessions: 2 });
  assert.equal(bundle.project.name, 'Demo Project');
  assert.equal(bundle.project.status, 'M1 in build');
  assert.deepEqual(bundle.decisions, [{ decided_on: '2026-09-29', text: 'Deploy with an SSH deploy key.' }]);
  assert.deepEqual(bundle.next_steps, [{ text: 'Build the indexer', done: false }]);
  assert.deepEqual(bundle.sessions.map((s: any) => s.path), ['projects/demo/sessions/2026-09-30-first.md'], 'LOG.md is not a session');
  const events = await store.rpc<any[]>('brain_recent_events', { p_limit: 50 });
  assert.ok(events.some((e) => e.action === 'blocked_secret' && e.path === 'projects/demo/leak.md' && !JSON.stringify(e).includes('sk-proj')));
  assert.ok(events.some((e) => e.action === 'blocked_size' && e.path === 'projects/demo/huge.md'));
});

test('nothing changed → nothing re-indexed or re-embedded', async () => {
  const r = await indexVault({ store, embedder: fakeEmbedder(), vaultDir: clone });
  assert.deepEqual([r.added.length, r.changed.length, r.removed.length, r.embedded], [0, 0, 0, 0]);
});

test('an edit re-embeds only the changed chunks; a deleted file leaves the index', async () => {
  const from = g(clone, 'rev-parse', 'HEAD');
  write('projects/demo/memory.md', MEMORY('- 2026-09-30: Backups go to Cloudflare R2.\n'));
  fs.rmSync(path.join(origin, 'projects/other/memory.md'));
  const to = commit('edit + delete');
  const r = await service.sync({ reason: 'test', actor: 'github:julev' });
  assert.ok(r);
  assert.deepEqual(r.changed, ['projects/demo/memory.md']);
  assert.deepEqual(r.removed, ['projects/other/memory.md']);
  assert.equal(r.embedded, 1, 'only the Decisions log chunk changed');
  assert.deepEqual((await changedFiles(git, from, to)).map((f) => `${f.status} ${f.path}`).sort(),
    ['D projects/other/memory.md', 'M projects/demo/memory.md']);
  const bundle = await store.rpc<any>('brain_project_bundle', { p_slug: 'demo', p_sessions: 2 });
  assert.equal(bundle.decisions[0].text, 'Backups go to Cloudflare R2.');
  const events = await store.rpc<any[]>('brain_recent_events', { p_limit: 20 });
  assert.ok(events.some((e) => e.action === 'doc_changed' && e.actor === 'github:julev'));
  assert.ok(events.some((e) => e.action === 'pulled' && e.meta.author === 'Julev'));
});

test('rewritten upstream history → the clone resets to origin', async () => {
  write('projects/demo/sessions/2026-10-01-second.md', '# Second\n\nAmended.');
  g(origin, 'add', '-A');
  g(origin, 'commit', '-q', '--amend', '-m', 'rewritten');
  await service.sync({ reason: 'test' });
  assert.equal(g(clone, 'rev-parse', 'HEAD'), g(origin, 'rev-parse', 'HEAD'));
  const events = await store.rpc<any[]>('brain_recent_events', { p_limit: 20 });
  assert.ok(events.some((e) => e.action === 'pulled' && e.meta.reset === true));
  assert.ok((await store.rpc<any>('brain_get_document', { p_path: 'projects/demo/sessions/2026-10-01-second.md' })));
});

test('HTTP API: secret required; health, projects, search, documents; GitHub webhook', async () => {
  const server = createHttpServer({
    store, embedder: fakeEmbedder(), service, internalSecret: 's3cret-internal', webhookSecret: 'hook-secret', branch: 'main', log: () => {},
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (p: string, secret = 's3cret-internal') => fetch(`${base}${p}`, { headers: { 'x-brain-secret': secret } });
  try {
    assert.equal((await get('/health', 'wrong')).status, 401);
    assert.equal((await fetch(`${base}/health`)).status, 401);
    assert.deepEqual(await (await fetch(`${base}/livez`)).json(), { ok: true });
    const health = await (await get('/health')).json() as any;
    assert.equal(health.documents, 6, 'one removed, one added since');
    assert.equal(health.embeddings, 'fake:hash-1536');
    const projects = await (await get('/projects')).json() as any;
    assert.deepEqual(projects.projects.map((p: any) => p.slug).sort(), ['demo', 'other']);
    const search = await (await get('/search?q=deploy%20key')).json() as any;
    assert.equal(search.semantic, 'on');
    assert.equal(search.results[0].path, 'projects/demo/memory.md');
    assert.ok(search.results[0].via.includes('keyword'));
    const auto = await (await get('/search?q=hostinger%20auto-deploy&project=demo&kind=session')).json() as any;
    assert.equal(auto.results[0].path, 'projects/demo/sessions/2026-09-30-first.md');
    assert.equal((await get('/search')).status, 400);
    const hits = async (qs: string) => ((await (await get(`/search?${qs}`)).json()) as any).results.map((h: any) => h.path);
    assert.deepEqual(await hits('q=zebrafish'), [], 'transcripts are left out by default');
    assert.deepEqual(await hits('q=zebrafish&kind=all'), ['projects/demo/sessions/2026-09-30-code-abc123.md']);
    assert.deepEqual(await hits('q=zebrafish&kind=transcript'), ['projects/demo/sessions/2026-09-30-code-abc123.md']);
    assert.equal((await get('/projects/nope')).status, 404);
    assert.equal(((await (await get('/projects/demo')).json()) as any).memory.path, 'projects/demo/memory.md');
    assert.equal((await get('/documents?path=profile/profile.md')).status, 200);
    assert.equal((await get('/documents?path=projects/demo/leak.md')).status, 404, 'the secret file was never indexed');

    const hook = (body: object, event: string, secret = 'hook-secret') => {
      const raw = JSON.stringify(body);
      return fetch(`${base}/hooks/github`, { method: 'POST', body: raw, headers: {
        'content-type': 'application/json', 'x-github-event': event,
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
      } });
    };
    assert.equal((await hook({ zen: 'hi' }, 'ping', 'wrong')).status, 401);
    assert.equal((await hook({ zen: 'hi' }, 'ping')).status, 200);
    assert.deepEqual(await (await hook({ ref: 'refs/heads/dev' }, 'push')).json(), { ok: true, ignored: 'refs/heads/dev' });
    write('projects/demo/sessions/2026-10-02-third.md', '# Third\n\nWebhook arrived.');
    commit('third');
    const res = await hook({ ref: 'refs/heads/main', pusher: { name: 'cracker17' }, head_commit: { id: 'abcdef1234' } }, 'push');
    assert.equal(res.status, 202);
    for (let i = 0; i < 100 && !(await store.rpc('brain_get_document', { p_path: 'projects/demo/sessions/2026-10-02-third.md' })); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(await store.rpc('brain_get_document', { p_path: 'projects/demo/sessions/2026-10-02-third.md' }), 'webhook → pull → index');
    const events = await store.rpc<any[]>('brain_recent_events', { p_limit: 10 });
    assert.ok(events.some((e) => e.actor === 'github:cracker17' && e.action === 'doc_added'));
    assert.ok(((await store.rpc<any>('brain_health')).last_webhook_at));
  } finally {
    server.close();
  }
});
