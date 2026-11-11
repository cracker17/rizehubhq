// Runs the real hq-sync.ps1 (Windows PowerShell) against a local brain: download, edit + new note upload, conflict,
// revoke wipe. Windows only (CI on Linux skips it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createPgliteStore, defaultMigrationsDir } from '../store/pglite';
import { setupScript, deviceReport } from '../setup/devices';
import { joinWithInvite } from '../people';
import { handleSync } from './hqsync';
import { HQ_SYNC_PS } from './client';
import type { BrainService } from '../service';
import type { VaultOp } from '../write/vault';

test('hq-sync.ps1 end to end', { skip: process.platform !== 'win32' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-sync-ps-'));
  const vault = path.join(tmp, 'server-vault');
  const pc = path.join(tmp, 'pc', 'HQ Brain');
  const put = (rel: string, t: string) => { fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true }); fs.writeFileSync(path.join(vault, rel), t); };
  put('projects/alpha/memory.md', '# Alpha\n');
  put('projects/alpha/notes.md', '# Notes\n\nv1\n');
  put('projects/beta/memory.md', '# Beta\n');

  const store = await createPgliteStore(defaultMigrationsDir());
  const service = { write: async (op: VaultOp) => ({ ...op(vault, '2026-11-11'), sha: 'abcdef1234' }) } as unknown as BrainService;
  const d = { store, service, vaultDir: vault, log: () => {} };
  const inv = await store.rpc<{ id: string; code: string }>('brain_person_invite', { p: { email: 'ana@example.com', name: 'Ana', role: 'member', grants: [{ slug: 'alpha', access: 'write' }] } });
  await joinWithInvite(store, inv.code, 'a-strong-password-1', () => {});
  const dev = await store.rpc<{ id: string; code: string }>('brain_device_create_for', { p_name: 'Ana PC', p_kind: 'pc', p_person: inv.id });
  const token = /\$Token = '(hqd_[A-Za-z0-9_-]{43})'/.exec(await setupScript({ store, publicUrl: 'x', repoUrl: '', log: () => {} }, dev.code))![1]!;

  // the dashboard's public routes, in miniature
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = JSON.parse(raw.replace(/^﻿/, '') || '{}');
    const m = /^\/api\/brain\/sync\/(manifest|file|upload)$/.exec(req.url ?? '');
    const [status, out] = m ? await handleSync(d, m[1]!, body)
      : req.url === '/api/brain/device' ? await deviceReport({ store, publicUrl: '', repoUrl: '', log: () => {} }, undefined, body) : [404, {}];
    res.writeHead(status as number, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const cfg = path.join(tmp, 'hq-brain.json');
  fs.writeFileSync(cfg, JSON.stringify({ server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token, vaultPath: pc }));
  const script = path.join(tmp, 'hq-sync.ps1');
  fs.writeFileSync(script, `﻿${HQ_SYNC_PS}`);
  const run = () => new Promise<void>((resolve, reject) => {
    // async spawn so the in-process server keeps answering
    const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Config', cfg], { stdio: 'ignore' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`hq-sync exited ${code}`))));
  });
  const local = (rel: string) => path.join(pc, ...rel.split('/'));
  const logTail = () => fs.existsSync(path.join(pc, '.hq-sync.log')) ? fs.readFileSync(path.join(pc, '.hq-sync.log'), 'utf8').trim().split('\n').at(-1) : '(no log)';

  try {
    await run();
    assert.ok(fs.existsSync(local('projects/alpha/notes.md')), `first sync downloads alpha: ${logTail()}`);
    assert.ok(!fs.existsSync(local('projects/beta/memory.md')), 'beta never comes down');
    let view = await store.rpc<{ ready_at: string | null; checklist: Record<string, { s: string }> }>('brain_device_get', { p_id: dev.id });
    assert.ok(view.ready_at, 'first good sync marks the member PC ready');
    assert.equal(view.checklist.hqsync?.s, 'done');

    // edit a file and add a note on the PC → both reach the server
    fs.writeFileSync(local('projects/alpha/notes.md'), '# Notes\n\nv2 from Ana\n');
    fs.writeFileSync(local('projects/alpha/idea.md'), '# Idea\n\nnew note\n');
    await run();
    assert.equal(fs.readFileSync(path.join(vault, 'projects/alpha/notes.md'), 'utf8'), '# Notes\n\nv2 from Ana\n', logTail());
    assert.ok(fs.existsSync(path.join(vault, 'projects/alpha/idea.md')));

    // both sides change → keep both
    put('projects/alpha/notes.md', '# Notes\n\nv3 from Julev\n');
    fs.writeFileSync(local('projects/alpha/notes.md'), '# Notes\n\nv3 from Ana\n');
    await run();
    assert.equal(fs.readFileSync(local('projects/alpha/notes.md'), 'utf8'), '# Notes\n\nv3 from Julev\n', `server version wins the name: ${logTail()}`);
    const conflicts = fs.readdirSync(local('projects/alpha')).filter((f) => f.includes('.conflict-'));
    assert.equal(conflicts.length, 1, 'her version kept beside it');

    // access ends → the project leaves the PC
    await store.rpc('brain_set_grants', { p_person: inv.id, p_grants: [] });
    await run();
    assert.ok(!fs.existsSync(local('projects/alpha/memory.md')), `revoked files removed: ${logTail()}`);
  } finally {
    server.close();
    await store.close?.();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
