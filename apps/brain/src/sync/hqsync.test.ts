// P3 HQ Sync against the real migrations + a temp vault: a member's PC sees only granted files, uploads need edit
// access, conflicts keep both, secrets are refused, owner PCs and removed devices are turned away.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPgliteStore, defaultMigrationsDir } from '../store/pglite';
import { setupScript } from '../setup/devices';
import { joinWithInvite } from '../people';
import { sha256 } from '../index/chunk';
import { conflictName, handleSync } from './hqsync';
import type { BrainService } from '../service';
import type { VaultOp } from '../write/vault';

const files: Record<string, string> = {
  'projects/alpha/memory.md': '# Alpha\n\n## Status\n- live\n',
  'projects/alpha/notes.md': '# Notes\n\nfirst\n',
  'projects/alpha/sessions/2026-11-01-code-abcdef12.md': '# transcript\n',
  'projects/alpha/secrets-map.md': '# where secrets live\n',
  'projects/beta/memory.md': '# Beta\n',
  'profile/profile.md': '# Julev\n',
};

test('HQ Sync: filtered manifest, guarded uploads, keep-both conflicts', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-sync-'));
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true }); fs.writeFileSync(path.join(vault, rel), text); }
  const store = await createPgliteStore(defaultMigrationsDir());
  const writes: string[] = [];
  const service = { write: async (op: VaultOp, actor: string) => { const r = op(vault, '2026-11-11'); writes.push(`${actor} ${r.paths[0]}`); return { ...r, sha: 'abcdef1234' }; } } as unknown as BrainService;
  const d = { store, service, vaultDir: vault, log: () => {} };

  const inv = await store.rpc<{ id: string; code: string }>('brain_person_invite', { p: { email: 'ana@example.com', name: 'Ana', role: 'member', grants: [{ slug: 'alpha', access: 'write' }] } });
  await joinWithInvite(store, inv.code, 'a-strong-password-1', () => {});
  const dev = await store.rpc<{ id: string; code: string }>('brain_device_create_for', { p_name: "Ana's laptop", p_kind: 'pc', p_person: inv.id });
  const script = await setupScript({ store, publicUrl: 'https://hq.example', repoUrl: '', log: () => {} }, dev.code);
  assert.match(script, /\$Track = 'member'/);
  assert.match(script, /\$HqSyncScript = @'/, 'member installers carry the sync script');
  const token = /\$Token = '(hqd_[A-Za-z0-9_-]{43})'/.exec(script)![1]!;

  const [st, m] = await handleSync(d, 'manifest', { token }) as [number, { files: Array<{ path: string; sha: string }>; projects: unknown[] }];
  assert.equal(st, 200);
  assert.deepEqual(m.files.map((f) => f.path).sort(), ['projects/alpha/memory.md', 'projects/alpha/notes.md'], 'no beta, profile, transcript or secrets map');
  assert.deepEqual(m.projects, [{ slug: 'alpha', access: 'write' }]);

  assert.equal((await handleSync(d, 'file', { token, path: 'projects/beta/memory.md' }))[0], 404);
  const [, f] = await handleSync(d, 'file', { token, path: 'projects/alpha/notes.md' }) as [number, { content: string; sha: string }];
  assert.equal(f.content, files['projects/alpha/notes.md']);

  // upload on top of the current version
  const up = await handleSync(d, 'upload', { token, path: 'projects/alpha/notes.md', content: '# Notes\n\nsecond\n', base_sha: f.sha }) as [number, { path: string; conflict: boolean }];
  assert.equal(up[0], 200);
  assert.equal(up[1].conflict, false);
  assert.equal(fs.readFileSync(path.join(vault, 'projects/alpha/notes.md'), 'utf8'), '# Notes\n\nsecond\n');
  assert.deepEqual(writes, ['user:ana@example.com projects/alpha/notes.md']);

  // stale base → keep both: the server version stays, hers lands as a conflict copy
  const stale = await handleSync(d, 'upload', { token, path: 'projects/alpha/notes.md', content: '# Notes\n\nthird\n', base_sha: f.sha }) as [number, { path: string; conflict: boolean }];
  assert.equal(stale[1].conflict, true);
  assert.match(stale[1].path, /^projects\/alpha\/notes\.conflict-ana-s-laptop-\d{8}-\d{4}\.md$/);
  assert.equal(fs.readFileSync(path.join(vault, 'projects/alpha/notes.md'), 'utf8'), '# Notes\n\nsecond\n');

  // refused: other project, owner-only file, secrets, non-markdown
  assert.equal((await handleSync(d, 'upload', { token, path: 'projects/beta/x.md', content: 'x' }))[0], 403);
  assert.equal((await handleSync(d, 'upload', { token, path: 'projects/alpha/secrets-map.md', content: 'x' }))[0], 403);
  assert.equal((await handleSync(d, 'upload', { token, path: 'profile/profile.md', content: 'x' }))[0], 403);
  assert.equal((await handleSync(d, 'upload', { token, path: 'projects/alpha/run.ps1', content: 'x' }))[0], 403);
  assert.equal((await handleSync(d, 'upload', { token, path: 'projects/alpha/k.md', content: 'key sk-ant-' + 'a'.repeat(30) }))[0], 422);

  // read-only now → uploads refused; revoked device → turned away
  await store.rpc('brain_set_grants', { p_person: inv.id, p_grants: [{ slug: 'alpha', access: 'read' }] });
  assert.equal((await handleSync(d, 'upload', { token, path: 'projects/alpha/notes.md', content: 'y', base_sha: sha256('# Notes\n\nsecond\n') }))[0], 403);
  await store.rpc('brain_device_revoke', { p_id: dev.id });
  assert.equal((await handleSync(d, 'manifest', { token }))[0], 401);

  // owner PCs use git, not HQ Sync
  const own = await store.rpc<{ code: string }>('brain_device_create_for', { p_name: 'Office PC', p_kind: 'pc', p_person: null });
  const ownToken = /\$Token = '(hqd_[A-Za-z0-9_-]{43})'/.exec(await setupScript({ store, publicUrl: 'https://hq.example', repoUrl: '', log: () => {} }, own.code))![1]!;
  assert.equal((await handleSync(d, 'manifest', { token: ownToken }))[0], 409);

  assert.equal(conflictName('projects/a/n.md', 'Ana PC', new Date('2026-11-11T10:05:00Z')), 'projects/a/n.conflict-ana-pc-20261111-1005.md');
  await store.close?.();
  fs.rmSync(vault, { recursive: true, force: true });
});
