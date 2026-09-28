// workspace_fs jail: escapes, secrets, symlinks, patch uniqueness, brain/ read-only. Temp dirs only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createBrain } from '../brain';
import { checkRel, isSecretName, JailError, openJail } from './jail';
import { workspaceFs, READ_MAX_BYTES } from './workspace';
import { devSetup, fakeEnv, run, tmpDir } from './testkit';

const brain = createBrain();
function jail() {
  const base = tmpDir();
  return openJail(path.join(base, 'workspaces'), 'task-1');
}

test('secret names: .env*, keys, id_* are secret; .env.example is not', () => {
  for (const n of ['.env', '.env.local', '.env.production', 'server.pem', 'tls.key', 'id_rsa', 'id_ed25519.pub', '.npmrc', '.netrc', '.git-credentials']) {
    assert.equal(isSecretName(n), true, n);
  }
  for (const n of ['.env.example', '.env.sample', 'index.ts', 'env.ts', 'identity.liquid', 'keys.md']) assert.equal(isSecretName(n), false, n);
});

test('checkRel refuses absolute paths, .., ~ and secret paths', () => {
  for (const p of ['/etc/passwd', '../x', 'a/../../b', '~/x', 'C:/x', 'app/.env', 'certs/site.pem', '.ssh/id_rsa', 'a\0b', '']) {
    assert.throws(() => checkRel(p), JailError, p);
  }
  assert.equal(checkRel('./theme/sections/'), 'theme/sections');
  assert.equal(checkRel('.'), '.');
});

test('openJail refuses unsafe task ids', () => {
  assert.throws(() => openJail(tmpDir(), '../evil'), JailError);
  assert.throws(() => openJail(tmpDir(), 'a/b'), JailError);
});

test('write/read/list/mkdir/delete inside the jail', () => {
  const j = jail();
  assert.match(workspaceFs(j, brain, { op: 'write', path: 'theme/sections/hero.liquid', content: '<h1>{{ section.settings.title }}</h1>' }), /Created/);
  assert.match(workspaceFs(j, brain, { op: 'read', path: 'theme/sections/hero.liquid' }), /section\.settings\.title/);
  assert.match(workspaceFs(j, brain, { op: 'list', path: '.', recursive: true }), /theme\/sections\/hero\.liquid/);
  assert.match(workspaceFs(j, brain, { op: 'mkdir', path: 'a/b/c' }), /ready/);
  assert.throws(() => workspaceFs(j, brain, { op: 'delete', path: 'theme' }), /recursive/);
  assert.match(workspaceFs(j, brain, { op: 'delete', path: 'theme', recursive: true }), /Deleted theme\//);
  assert.throws(() => workspaceFs(j, brain, { op: 'delete', path: '.', recursive: true }), /root/);
  assert.equal(fs.existsSync(j.root), true);
});

test('patch needs a unique old_string unless replace_all', () => {
  const j = jail();
  workspaceFs(j, brain, { op: 'write', path: 'a.css', content: '.x{color:red}\n.y{color:red}\n' });
  assert.throws(() => workspaceFs(j, brain, { op: 'patch', path: 'a.css', old_string: 'color:blue', new_string: 'c' }), /not found/);
  assert.throws(() => workspaceFs(j, brain, { op: 'patch', path: 'a.css', old_string: 'color:red', new_string: 'color:blue' }), /occurs 2 times/);
  workspaceFs(j, brain, { op: 'patch', path: 'a.css', old_string: '.x{color:red}', new_string: '.x{color:$&blue}' });
  assert.equal(fs.readFileSync(path.join(j.root, 'a.css'), 'utf8'), '.x{color:$&blue}\n.y{color:red}\n'); // no $& expansion
  assert.match(workspaceFs(j, brain, { op: 'patch', path: 'a.css', old_string: 'red', new_string: 'green', replace_all: true }), /1 replacement/);
});

test('symlinks cannot escape the jail (read, write through, write into a linked dir)', () => {
  const j = jail();
  const outside = tmpDir('rzh-outside-');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(j.root, 'link.txt'));
  fs.symlinkSync(outside, path.join(j.root, 'outdir'));
  assert.throws(() => workspaceFs(j, brain, { op: 'read', path: 'link.txt' }), /outside the workspace/);
  assert.throws(() => workspaceFs(j, brain, { op: 'write', path: 'link.txt', content: 'x' }), JailError);
  assert.throws(() => workspaceFs(j, brain, { op: 'write', path: 'outdir/new.txt', content: 'x' }), /outside the workspace/);
  assert.throws(() => workspaceFs(j, brain, { op: 'list', path: 'outdir' }), /outside the workspace/);
  assert.equal(fs.existsSync(path.join(outside, 'new.txt')), false);
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'TOP SECRET');
});

test('.git internals and secret files are off limits; .env.example is fine', () => {
  const j = jail();
  assert.throws(() => workspaceFs(j, brain, { op: 'write', path: 'repo/.git/hooks/pre-push', content: '#!/bin/sh' }), /\.git internals/);
  assert.throws(() => workspaceFs(j, brain, { op: 'write', path: '.env', content: 'A=1' }), /secret/);
  assert.throws(() => workspaceFs(j, brain, { op: 'read', path: 'repo/.env.local' }), /secret/);
  assert.match(workspaceFs(j, brain, { op: 'write', path: '.env.example', content: 'API_KEY=' }), /Created/);
});

test('read is size-capped and supports line ranges', () => {
  const j = jail();
  const big = 'x'.repeat(READ_MAX_BYTES + 5000);
  fs.writeFileSync(path.join(j.root, 'big.txt'), big);
  assert.match(workspaceFs(j, brain, { op: 'read', path: 'big.txt' }), /truncated: file is/);
  fs.writeFileSync(path.join(j.root, 'l.txt'), 'a\nb\nc\nd');
  assert.equal(workspaceFs(j, brain, { op: 'read', path: 'l.txt', start_line: 2, end_line: 3 }), '2\tb\n3\tc');
});

test('brain/ is readable but read-only', () => {
  const j = jail();
  assert.match(workspaceFs(j, brain, { op: 'read', path: 'brain/sops/shopify-section.md' }), /\S/);
  assert.match(workspaceFs(j, brain, { op: 'list', path: 'brain/sops' }), /brain\/sops\/shopify-section\.md/);
  assert.throws(() => workspaceFs(j, brain, { op: 'write', path: 'brain/sops/x.md', content: 'hi' }), /read-only/);
  assert.throws(() => workspaceFs(j, brain, { op: 'read', path: 'brain/../CLAUDE.md' }));
});

test('workspace_fs tool: creates WORKSPACES_DIR/<task-id>, returns refusals as text and logs every call', async () => {
  const f = fakeEnv();
  const s = devSetup(f.env);
  assert.match(await run(s.tools, 'workspace_fs', { op: 'write', path: 'notes.md', content: 'hello' }), /Created notes\.md/);
  assert.equal(fs.readFileSync(path.join(s.jailDir, 'notes.md'), 'utf8'), 'hello');
  assert.match(await run(s.tools, 'workspace_fs', { op: 'read', path: '/etc/passwd' }), /^Refused: absolute paths/);
  assert.match(await run(s.tools, 'workspace_fs', { op: 'read', path: '../../x' }), /^Refused/);
  const logs = (s.deps as unknown as { logs: string[] }).logs;
  assert.ok(logs.some((l) => /workspace_fs op=write path=notes\.md → ok/.test(l)));
  assert.ok(logs.some((l) => /workspace_fs op=read path=\/etc\/passwd → refused/.test(l)));
  assert.ok(!logs.some((l) => l.includes('hello')), 'content is never logged');
});
