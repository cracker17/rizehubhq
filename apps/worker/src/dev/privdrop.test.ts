// Finding #1 (bash_sandboxed could read the worker's secrets): code-running bypasses are refused without
// isolation, the production gate refuses the shell entirely, and agent commands are spawned under AGENT_UID/GID.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { openJail } from './jail';
import { defaultSandboxPath, makeRunProcess, runProcess } from './env';
import { agentIdentity, chownTreeToAgent, sandboxStatus } from './agentUser';
import { BASE_ALLOWED_HOSTS, planCommand, runSandboxed, ShellRefusal, tokenize, type ShellPolicyCtx } from './shell';
import { devSetup, fakeEnv, policySandboxPath, run, tmpDir } from './testkit';
import { mkdirpInJail, readInJail, writeInJail } from './safefs';
import { JailError } from './jail';

const SP = policySandboxPath();
function ctx(isolated = false): ShellPolicyCtx {
  const j = openJail(path.join(tmpDir(), 'ws'), 'task-pd');
  fs.mkdirSync(path.join(j.root, 'src'));
  fs.writeFileSync(path.join(j.root, 'src', 'leak.js'), "console.log(require('fs').readFileSync('/proc/' + process.ppid + '/environ', 'utf8'))");
  fs.writeFileSync(path.join(j.root, 'package.json'), JSON.stringify({ scripts: { build: "node -e \"console.log(require('fs').readFileSync('/proc/'+process.ppid+'/environ','utf8'))\"" } }));
  return { jail: j, cwd: j.root, allowedHosts: [...BASE_ALLOWED_HOSTS], isolated };
}
const plan = (c: ShellPolicyCtx, line: string) => planCommand(tokenize(line).argv, c, SP);
const refused = (c: ShellPolicyCtx, line: string, re?: RegExp) =>
  assert.throws(() => plan(c, line), (e: unknown) => e instanceof ShellRefusal && (!re || re.test((e as Error).message)), line);

test('review bypasses are refused without isolation (node -e, npm run with an agent-written package.json, npx, /proc)', () => {
  const c = ctx(false);
  for (const line of [
    `node -e "console.log(require('fs').readFileSync('/proc/'+process.ppid+'/environ','utf8'))"`,
    'node -p process.env', 'node --eval=1', 'node --print 1', 'node -r ./src/leak.js src/leak.js', 'node --require ./src/leak.js src/leak.js',
    'node --import ./src/leak.js src/leak.js', 'node --loader ./src/leak.js src/leak.js', 'node --env-file=.env.example src/leak.js',
    'node --inspect=0.0.0.0:9229 src/leak.js', 'node -i', 'node',
  ]) refused(c, line, /not allowed|needs a script/);
  refused(c, 'node src/leak.js', /isolated/);
  refused(c, 'node /proc/self/environ', /absolute/);
  refused(c, 'node ../other/leak.js', /\.\./);
  refused(c, 'node missing.js', /does not exist/);
  for (const line of ['npm run build', 'npm run-script build', 'npm test', 'npm t', 'npm start', 'npm init vite', 'pnpm build', 'pnpm run build',
    'pnpm test', 'pnpm start', 'npx playwright test', 'npx vitest', 'npx @playwright/test test', 'playwright test', 'lighthouse https://github.com --config-path=x.js']) {
    refused(c, line, /isolated/);
  }
  refused(c, 'npm exec evil', /not allowed/);
  refused(c, 'pnpm exec evil', /not allowed|isolated/);
  refused(c, 'pnpm dlx evil', /not allowed/);
  refused(c, 'npx evil-package', /not allowed/);
  refused(c, 'cat /proc/1/environ', /absolute/);
  refused(c, 'cat ../../../../proc/self/environ', /\.\./);
  // The small safe list still works without isolation.
  for (const ok of ['npx --yes @shopify/cli@3 theme check --path src', 'shopify theme check --path src', 'npx prettier --check src', 'npx eslint src', 'npx tsc --noEmit',
    'npm ci', 'npm install', 'npm init -y', 'pnpm install', 'node --check src/leak.js', 'node --version']) assert.ok(plan(c, ok), ok);
});

test('with isolation, scripts may run (inside the jail only); inline code and outside scripts stay refused', () => {
  const c = ctx(true);
  for (const ok of ['node src/leak.js', 'npm run build', 'pnpm build', 'npx playwright test', 'playwright test']) assert.ok(plan(c, ok), ok);
  refused(c, 'node -e 1', /not allowed/);
  refused(c, 'node /tmp/x.js', /absolute/);
  const outside = tmpDir('rzh-out-');
  fs.writeFileSync(path.join(outside, 'x.js'), '1');
  fs.symlinkSync(path.join(outside, 'x.js'), path.join(c.jail.root, 'x.js'));
  refused(c, 'node x.js', /symlink|outside/);
});

test('sandboxStatus: privilege drop needs root + AGENT_UID; production without isolation refuses the shell', () => {
  assert.deepEqual(agentIdentity({ AGENT_UID: '1001' }, () => 0), { uid: 1001, gid: 1001 });
  assert.deepEqual(agentIdentity({ AGENT_UID: '1001', AGENT_GID: '1002' }, () => 0), { uid: 1001, gid: 1002 });
  assert.equal(agentIdentity({ AGENT_UID: '1001' }, () => 1000), null, 'only root can setuid');
  assert.equal(agentIdentity({ AGENT_UID: '0' }, () => 0), null, 'never "drop" to root');
  assert.equal(agentIdentity({}, () => 0), null);

  const prodNoIso = sandboxStatus({ NODE_ENV: 'production' }, () => 1000);
  assert.ok(prodNoIso.refusal && /disabled/.test(prodNoIso.refusal));
  assert.match(prodNoIso.warning!, /DISABLED/);
  assert.match(sandboxStatus({ NODE_ENV: 'production' }, () => 0).refusal!, /AGENT_UID is not set/);
  assert.equal(sandboxStatus({ NODE_ENV: 'production', AGENT_UID: '1001' }, () => 0).refusal, null);
  assert.equal(sandboxStatus({ NODE_ENV: 'production', DEV_SANDBOX_PREFIX: '["bwrap"]' }, () => 1000).refusal, null);
  const dev = sandboxStatus({}, () => 1000);
  assert.equal(dev.refusal, null);
  assert.equal(dev.isolated, false);
  assert.match(dev.warning!, /local dev/);
});

test('bash_sandboxed: production without isolation refuses before spawning anything', async () => {
  const f = fakeEnv({ env: { NODE_ENV: 'production' } });
  f.env.getuid = () => 1000;
  const s = devSetup(f.env);
  assert.match(await run(s.tools, 'bash_sandboxed', { command: 'ls' }), /^Refused: the shell is disabled/);
  assert.equal(f.runCalls.length, 0);
});

test('bash_sandboxed: with AGENT_UID/GID (worker root) every command is spawned with uid/gid; git without a token too', async () => {
  const f = fakeEnv({ env: { NODE_ENV: 'production', AGENT_UID: '1001', AGENT_GID: '1002' } });
  f.env.getuid = () => 0;
  f.env.agentUser = { uid: 1001, gid: 1002 };
  f.env.run = async (file, args, opts) => { f.runCalls.push({ file, args, opts }); if (opts.stdoutFd !== undefined) fs.closeSync(opts.stdoutFd); return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }; };
  const s = devSetup(f.env);
  const realChown = fs.lchownSync; const realFchown = fs.fchownSync;
  const chowned: string[] = [];
  // Not every test run is root: record ownership changes instead of performing them.
  (fs as { lchownSync: typeof fs.lchownSync }).lchownSync = ((p: fs.PathLike) => { chowned.push(String(p)); }) as typeof fs.lchownSync;
  (fs as { fchownSync: typeof fs.fchownSync }).fchownSync = (() => undefined) as typeof fs.fchownSync;
  try {
    assert.match(await run(s.tools, 'bash_sandboxed', { command: 'ls -la' }), /exit 0/);
    assert.equal(f.runCalls[0]!.opts.uid, 1001);
    assert.equal(f.runCalls[0]!.opts.gid, 1002);
    assert.ok(chowned.includes(s.jailDir), 'the jail is handed to the agent uid');
    assert.match(await run(s.tools, 'bash_sandboxed', { command: 'git status > st.txt' }), /exit 0/);
    assert.equal(f.runCalls[1]!.opts.uid, 1001);
    // node scripts are allowed now (isolated), still as the agent uid
    fs.writeFileSync(path.join(s.jailDir, 'a.js'), '1');
    assert.match(await run(s.tools, 'bash_sandboxed', { command: 'node a.js' }), /exit 0/);
    assert.equal(f.runCalls[2]!.opts.uid, 1001);
  } finally {
    (fs as { lchownSync: typeof fs.lchownSync }).lchownSync = realChown;
    (fs as { fchownSync: typeof fs.fchownSync }).fchownSync = realFchown;
  }
});

test('runProcess passes uid/gid to child_process.spawn (mocked) and still no shell / own process group', async () => {
  const calls: { file: string; args: readonly string[]; opts: Record<string, unknown> }[] = [];
  const fakeSpawn = ((file: string, args: readonly string[], opts: Record<string, unknown>) => {
    calls.push({ file, args, opts });
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; pid: number; kill: () => boolean };
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 4242; child.kill = () => true;
    setImmediate(() => { child.stdout.end('hi'); child.stderr.end(); child.emit('close', 0, null); });
    return child;
  }) as unknown as typeof spawn;
  const rp = makeRunProcess(fakeSpawn);
  const r = await rp('/usr/bin/ls', ['-a'], { cwd: '/w', env: { PATH: '/usr/bin' }, timeoutMs: 1000, uid: 1001, gid: 1002 });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'hi');
  assert.equal(calls[0]!.opts.uid, 1001);
  assert.equal(calls[0]!.opts.gid, 1002);
  assert.equal(calls[0]!.opts.shell, false);
  assert.equal(calls[0]!.opts.detached, true);
  await rp('/usr/bin/ls', [], { cwd: '/w', env: {}, timeoutMs: 1000 });
  assert.equal('uid' in calls[1]!.opts, false, 'no uid without a privilege drop');
});

const isRoot = process.getuid?.() === 0;
test('REAL privilege drop (runs only as root): agent code cannot read the worker\'s /proc/<pid>/environ', { skip: !isRoot && 'needs root' }, async () => {
  const base = tmpDir('rzh-pd-');
  fs.chmodSync(base, 0o755);
  const j = openJail(path.join(base, 'ws'), 'task-real-drop');
  fs.chmodSync(path.dirname(j.root), 0o755);
  fs.writeFileSync(path.join(j.root, 'leak.js'),
    "let r; try { r = require('fs').readFileSync('/proc/' + process.ppid + '/environ', 'utf8').length + ' bytes LEAKED'; } catch (e) { r = e.code; }\n"
    + "console.log('uid=' + process.getuid() + ' gid=' + process.getgid() + ' groups=' + process.getgroups().join(',') + ' ' + r);");
  const id = { uid: 1001, gid: 1001 };
  chownTreeToAgent(j.root, id);
  const f = fakeEnv({ env: { AGENT_UID: '1001', NODE_ENV: 'production' } });
  f.env.run = runProcess;
  f.env.agentUser = id;
  const out = await runSandboxed(f.env, j, BASE_ALLOWED_HOSTS, { command: 'node leak.js' });
  assert.match(out, /uid=1001 gid=1001 groups=(1001)? EACCES/, out);
  assert.doesNotMatch(out, /LEAKED/);
  // Redirect files are created for the agent (it can overwrite them next time).
  await runSandboxed(f.env, j, BASE_ALLOWED_HOSTS, { command: 'node leak.js > out.txt' });
  assert.equal(fs.statSync(path.join(j.root, 'out.txt')).uid, 1001);
  assert.match(fs.readFileSync(path.join(j.root, 'out.txt'), 'utf8'), /EACCES/);
});

test('safefs: the worker never reads or writes through a symlink swapped in by an agent process', () => {
  const j = openJail(path.join(tmpDir(), 'ws'), 'task-safefs');
  const outside = tmpDir('rzh-out-');
  fs.writeFileSync(path.join(outside, 'secret'), 'TOP SECRET');
  fs.symlinkSync(path.join(outside, 'secret'), path.join(j.root, 'link'));
  assert.throws(() => readInJail(j, path.join(j.root, 'link')), JailError);
  assert.throws(() => writeInJail(j, path.join(j.root, 'link'), 'x'), JailError);
  assert.equal(fs.readFileSync(path.join(outside, 'secret'), 'utf8'), 'TOP SECRET', 'never truncated');
  fs.symlinkSync(outside, path.join(j.root, 'dirlink'));
  assert.throws(() => writeInJail(j, path.join(j.root, 'dirlink', 'new.txt'), 'x'), JailError);
  assert.equal(fs.existsSync(path.join(outside, 'new.txt')), false, 'a file created outside by a race is removed again');
  assert.throws(() => readInJail(j, path.join(j.root, 'dirlink', 'secret')), JailError);
  assert.throws(() => mkdirpInJail(j, path.join(j.root, 'dirlink', 'sub')), JailError);
  writeInJail(j, path.join(j.root, 'a', 'b', 'c.txt'), 'ok');
  assert.equal(readInJail(j, path.join(j.root, 'a', 'b', 'c.txt')).toString(), 'ok');
});
