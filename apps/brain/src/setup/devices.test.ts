// P1 device setup against the real migrations (PGlite): link → installer → reports → round trip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPgliteStore, defaultMigrationsDir } from '../store/pglite';
import { checkRoundTrips, cleanReport, deviceReport, setupScript } from './devices';
import { httpsRepoUrl, psq, renderInstaller } from './installer';

const log = () => {};

test('installer: values are PowerShell-quoted, the body has no stray template escapes', () => {
  assert.equal(psq("Julev's PC"), "'Julev''s PC'");
  assert.equal(psq('a\nb'), "'a b'");
  const s = renderInstaller({ server: 'https://hq.rizehub.ph/', token: 'hqd_x', deviceId: 'd1', name: "Ana's laptop", track: 'owner', repoUrl: 'git@github.com:cracker17/claude-memory-vault.git' });
  assert.match(s, /\$Server = 'https:\/\/hq\.rizehub\.ph'/);
  assert.match(s, /\$DeviceName = 'Ana''s laptop'/);
  assert.match(s, /\$RepoUrl = 'https:\/\/github\.com\/cracker17\/claude-memory-vault\.git'/);
  assert.doesNotMatch(s, /\\`/, 'no backslash-backtick from String.raw');
  assert.doesNotMatch(s, /\$\{/, 'no JS interpolation left over');
  assert.equal(httpsRepoUrl('https://github.com/a/b.git'), 'https://github.com/a/b.git');
});

test('reports are cleaned to known steps, states and fields', () => {
  assert.deepEqual(cleanReport({ step: 'git', s: 'done', detail: 'Git 2.47', info: { git: '2.47', evil: 'x' }, extra: 1 }),
    { step: 'git', s: 'done', detail: 'Git 2.47', info: { git: '2.47' } });
  assert.deepEqual(cleanReport({ step: 'drop table', s: 'done' }), {});
  assert.deepEqual(cleanReport({ step: 'clone', s: 'weird' }), { step: 'clone', s: 'done', detail: '' });
  assert.deepEqual(cleanReport({ roundtrip: { nonce: 'a'.repeat(32), written_at: '2026-11-11T10:00:00.000Z', pushed_at: 'soon' } }),
    { roundtrip: { nonce: 'a'.repeat(32), written_at: '2026-11-11T10:00:00.000Z' } });
});

test('setup link: one use, 30 minutes; reports tick the checklist; the round trip marks the device ready', async () => {
  const store = await createPgliteStore(defaultMigrationsDir());
  const deps = { store, publicUrl: 'https://hq.example', repoUrl: 'git@github.com:cracker17/claude-memory-vault.git', log };

  const dev = await store.rpc<{ id: string; code: string; kind: string }>('brain_device_create', { p_name: 'Office PC', p_kind: 'pc' });
  assert.match(dev.code, /^[0-9a-f]{20}$/);
  const [row] = await store.exec('select setup_code_hash from brain_devices where id = $1', [dev.id]);
  assert.notEqual(row.setup_code_hash, dev.code, 'only the hash is stored');

  const script = await setupScript(deps, dev.code);
  const token = /\$Token = '(hqd_[A-Za-z0-9_-]{43})'/.exec(script)?.[1];
  assert.ok(token, 'installer carries a device token');
  assert.match(await setupScript(deps, dev.code), /expired or was already used/, 'single use');
  assert.match(await setupScript(deps, 'nope'), /not valid/);

  assert.deepEqual(await deviceReport(deps, undefined, { token, step: 'git', s: 'done', detail: 'Git 2.47', info: { git: '2.47' } }), [200, { ok: true }]);
  assert.deepEqual(await deviceReport(deps, `Bearer ${token}`, { step: 'clone', s: 'fail', detail: 'sign-in cancelled' }), [200, { ok: true }]);
  assert.equal((await deviceReport(deps, undefined, { token: 'hqd_' + 'x'.repeat(43), step: 'git' }))[0], 401);

  const nonce = 'b'.repeat(32);
  await deviceReport(deps, undefined, { token, step: 'roundtrip', s: 'run', roundtrip: { nonce, written_at: new Date().toISOString() } });
  let view = await store.rpc<Record<string, any>>('brain_device_get', { p_id: dev.id });
  assert.equal(view.checklist.git.s, 'done');
  assert.equal(view.checklist.clone.s, 'fail');
  assert.equal(view.info.git, '2.47');
  assert.equal(view.roundtrip.nonce, undefined, 'the nonce is not shown to the browser');
  assert.equal(view.ready_at, null);

  // the indexer sees devices/<id>.md: it must be readable back through the API before the device counts as ready
  await store.rpc('brain_upsert_document', {
    p_doc: { path: `devices/${dev.id}.md`, project_slug: null, kind: 'other', title: 'Device', doc_date: null, frontmatter: { roundtrip: nonce }, body: 'x', content_sha: 's1', git_sha: null },
    p_chunks: [], p_decisions: [], p_next_steps: [],
  });
  await checkRoundTrips(store, [{ path: `devices/${dev.id}.md`, frontmatter: { roundtrip: nonce } }], new Set([`devices/${dev.id}.md`]), log);
  view = await store.rpc<Record<string, any>>('brain_device_get', { p_id: dev.id });
  assert.ok(view.roundtrip.indexed_at && view.roundtrip.readable_at);
  assert.ok(view.ready_at, 'ready after the round trip');

  // revoke: the token stops working
  await store.rpc('brain_device_revoke', { p_id: dev.id });
  assert.equal((await deviceReport(deps, undefined, { token, step: 'sync', s: 'done' }))[0], 401);
  assert.deepEqual(await store.rpc('brain_devices_list'), []);

  // an expired link
  const old = await store.rpc<{ id: string; code: string }>('brain_device_create', { p_name: 'Old PC', p_kind: 'pc' });
  await store.exec(`update brain_devices set setup_expires_at = now() - interval '1 minute' where id = $1`, [old.id]);
  assert.match(await setupScript(deps, old.code), /expired/);
  const fresh = await store.rpc<{ code: string }>('brain_device_new_link', { p_id: old.id });
  assert.match(await setupScript(deps, fresh.code), /\$Token = 'hqd_/);

  // a Claude-only device has no link
  const app = await store.rpc<{ code: string | null }>('brain_device_create', { p_name: 'Phone', p_kind: 'claude' });
  assert.equal(app.code, null);
  await store.close?.();
});
