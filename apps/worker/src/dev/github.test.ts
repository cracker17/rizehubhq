// github tool: branch naming, token only via GIT_ASKPASS env (never argv), no force, merge refused, redaction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { agentBranch, checkBranch, checkRepo, GithubRefusal, unsafeConfigKeys } from './github';
import { devSetup, fakeEnv, fakeVault, json, run, type RunCall } from './testkit';

const TOKEN = 'github_pat_DEMO_not_real_1234567890abcdef';

/** Fake git: answers by subcommand (after the -c hardening flags). */
function gitSub(c: RunCall): string { return c.args.filter((a, i) => !(a === '-c' || c.args[i - 1] === '-c'))[0] ?? ''; }

function setup(o: { head?: string; config?: string; staged?: string; pushFails?: string } = {}) {
  const f = fakeEnv({
    env: { GITHUB_TOKEN_DEFAULT: TOKEN },
    run: (c) => {
      const sub = gitSub(c);
      const rest = c.args.slice(c.args.indexOf(sub) + 1);
      if (sub === 'clone') { fs.mkdirSync(path.join(rest.at(-1)!, '.git'), { recursive: true }); return {}; }
      if (sub === 'rev-parse' && rest.includes('--abbrev-ref')) return { stdout: `${o.head ?? 'main'}\n` };
      if (sub === 'rev-parse' && rest[0] === 'HEAD') return { stdout: 'abcdef1234567890\n' };
      if (sub === 'rev-parse') return { code: 1 };
      if (sub === 'config') return { stdout: o.config ?? 'core.bare=false\nremote.origin.url=https://github.com/acme/theme.git\n' };
      if (sub === 'remote') return { stdout: 'https://github.com/acme/theme.git\n' };
      if (sub === 'diff') return { stdout: o.staged ?? 'sections/hero.liquid\n' };
      if (sub === 'push' && o.pushFails) return { code: 1, stderr: o.pushFails };
      return {};
    },
    fetch: (c) => {
      if (c.url.endsWith('/repos/acme/theme')) return json({ default_branch: 'main' });
      if (c.url.endsWith('/pulls') && c.method === 'POST') {
        // Worst case: the API echoes the auth header back.
        return json({ number: 7, html_url: 'https://github.com/acme/theme/pull/7', state: 'open', echo: c.headers.get('authorization') }, 201);
      }
      if (/\/pulls\/7$/.test(c.url)) return json({ number: 7, state: 'open', merged: false, mergeable: true, html_url: 'u', title: 't', head: { ref: `agent/${taskId}`, sha: 'abc123' }, base: { ref: 'main' } });
      if (/\/pulls\/8$/.test(c.url)) return json({ number: 8, head: { ref: 'feature/client-work', sha: 'x' }, base: { ref: 'main' } });
      if (c.url.includes('/check-runs')) return json({ check_runs: [{ name: 'theme-check', status: 'completed', conclusion: 'success' }] });
      if (c.url.endsWith('/status')) return json({ state: 'success', statuses: [] });
      if (c.url.endsWith('/issues/7/comments')) return json({ html_url: 'https://github.com/acme/theme/pull/7#c1' }, 201);
      return json({ message: `unexpected ${c.url} ${TOKEN}` }, 500);
    },
  });
  const s = devSetup(f.env, 'fullstack-dev');
  const taskId = s.task.id;
  return { ...f, ...s };
}

test('branch naming: only agent/<task-id>; main/master/others refused', () => {
  assert.equal(checkBranch('t1'), 'agent/t1');
  assert.equal(checkBranch('t1', 'agent/t1'), 'agent/t1');
  for (const b of ['main', 'master', 'agent/t2', 'agent/t1-x', 'feature/x', 'refs/heads/main']) assert.throws(() => checkBranch('t1', b), GithubRefusal, b);
  assert.equal(agentBranch('abc'), 'agent/abc');
});

test('repo names are validated', () => {
  assert.equal(checkRepo('https://github.com/acme/theme.git'), 'acme/theme');
  for (const r of ['acme', '../x/y', 'acme/theme; rm', 'a/b/c', 'acme/..']) assert.throws(() => checkRepo(r), GithubRefusal, r);
});

test('unsafe local git config keys are detected', () => {
  const bad = unsafeConfigKeys('core.bare=false\ncore.fsmonitor=./x\nalias.st=!sh\ncredential.helper=store\nurl.https://evil/.insteadof=https://github.com/\ncore.hookspath=h\nremote.origin.pushurl=x\n');
  assert.deepEqual(bad, ['core.fsmonitor', 'alias.st', 'credential.helper', 'url.https://evil/.insteadof', 'core.hookspath', 'remote.origin.pushurl']);
  assert.deepEqual(unsafeConfigKeys('core.bare=false\nremote.origin.url=https://github.com/a/b\nbranch.main.remote=origin'), []);
});

test('clone: token only reaches git through GIT_ASKPASS env; never argv, URL or the agent sandbox', async () => {
  const s = setup();
  const out = await run(s.tools, 'github', { op: 'clone', repo: 'acme/theme' });
  assert.match(out, /Cloned acme\/theme into theme\//);
  const c = s.runCalls.find((x) => gitSub(x) === 'clone')!;
  assert.ok(!c.args.join(' ').includes(TOKEN), 'token not in argv');
  assert.ok(c.args.includes('https://github.com/acme/theme.git'));
  for (const f of ['core.hooksPath=/dev/null', 'credential.helper=', 'core.fsmonitor=false']) assert.ok(c.args.includes(f), f);
  assert.equal(c.opts.env.RIZEHUB_GIT_TOKEN, TOKEN);
  const askpass = c.opts.env.GIT_ASKPASS!;
  assert.ok(!askpass.startsWith(s.jailDir), 'helper lives outside the jail');
  assert.equal(fs.statSync(askpass).mode & 0o777, 0o700);
  assert.ok(!fs.readFileSync(askpass, 'utf8').includes(TOKEN), 'helper file holds no token');
  assert.equal(c.opts.env.GIT_CONFIG_GLOBAL, '/dev/null');
  // The agent's own bash never gets it.
  await run(s.tools, 'bash_sandboxed', { command: 'git status', cwd: 'theme' });
  const b = s.runCalls.at(-1)!;
  assert.ok(!JSON.stringify(b.opts.env).includes(TOKEN));
  assert.equal(b.opts.env.GIT_ASKPASS, undefined);
});

test('create_branch refuses main and other names; commit_push only from agent/<task-id>', async () => {
  const s = setup({ head: 'main' });
  await run(s.tools, 'github', { op: 'clone', repo: 'acme/theme' });
  assert.match(await run(s.tools, 'github', { op: 'create_branch', dir: 'theme', branch: 'main' }), /^Refused: Branch "main" is not allowed/);
  assert.match(await run(s.tools, 'github', { op: 'create_branch', dir: 'theme', branch: 'master' }), /^Refused/);
  assert.match(await run(s.tools, 'github', { op: 'create_branch', dir: 'theme' }), new RegExp(`On branch agent/${s.task.id}`));
  const co = s.runCalls.find((x) => gitSub(x) === 'checkout')!;
  assert.deepEqual(co.args.slice(-2), ['-b', `agent/${s.task.id}`]);
  assert.match(await run(s.tools, 'github', { op: 'commit_push', dir: 'theme', message: 'x' }), /^Refused: You are on "main"/);
  assert.ok(!s.runCalls.some((x) => gitSub(x) === 'push'));
});

/** Like setup(), but HEAD is on the task's agent branch. */
function onAgentBranch(o: Parameters<typeof setup>[0] = {}) {
  const t = setup(o);
  const orig = t.env.run;
  t.env.run = async (file, args, opts) => {
    if (!args.includes('--abbrev-ref')) return orig(file, args, opts);
    t.runCalls.push({ file, args, opts });
    return { code: 0, signal: null, stdout: `agent/${t.task.id}\n`, stderr: '', timedOut: false };
  };
  return t;
}

test('commit_push: explicit URL + fixed refspec, never --force, hooks off, token only on push', async () => {
  const t = onAgentBranch();
  await run(t.tools, 'github', { op: 'clone', repo: 'acme/theme' });
  const out = await run(t.tools, 'github', { op: 'commit_push', dir: 'theme', message: 'Add hero section' });
  assert.match(out, new RegExp(`pushed abcdef123456 to acme/theme@agent/${t.task.id}`));
  const push = t.runCalls.find((x) => gitSub(x) === 'push')!;
  assert.ok(push.args.includes(`HEAD:refs/heads/agent/${t.task.id}`));
  assert.ok(push.args.includes('https://github.com/acme/theme.git'));
  assert.ok(!push.args.some((a) => /^(-f|--force|--force-with-lease|--mirror|--delete|-d|\+)/.test(a)), 'no force/delete');
  assert.ok(push.args.includes('--no-verify') && push.args.includes('core.hooksPath=/dev/null'));
  assert.equal(push.opts.env.RIZEHUB_GIT_TOKEN, TOKEN);
  const commit = t.runCalls.find((x) => gitSub(x) === 'commit')!;
  assert.equal(commit.opts.env.RIZEHUB_GIT_TOKEN, undefined, 'token only on network ops');
  assert.equal(commit.opts.env.GIT_AUTHOR_NAME, 'RizeHub Agent');
});

test('commit_push refuses secret files and unsafe repo config; reports non-fast-forward without forcing', async () => {
  const mk = onAgentBranch;
  const a = mk({ staged: 'sections/a.liquid\n.env\nconfig/id_rsa\n' });
  await run(a.tools, 'github', { op: 'clone', repo: 'acme/theme' });
  assert.match(await run(a.tools, 'github', { op: 'commit_push', dir: 'theme', message: 'm' }), /secret-looking files: \.env, config\/id_rsa/);
  assert.ok(!a.runCalls.some((x) => gitSub(x) === 'push' || gitSub(x) === 'commit'));

  const b = mk({ config: 'core.bare=false\ncore.fsmonitor=./steal.sh\n' });
  await run(b.tools, 'github', { op: 'clone', repo: 'acme/theme' });
  assert.match(await run(b.tools, 'github', { op: 'commit_push', dir: 'theme', message: 'm' }), /core\.fsmonitor/);
  assert.ok(!b.runCalls.some((x) => gitSub(x) === 'push'));

  const c = mk({ pushFails: `! [rejected] HEAD -> agent/x (non-fast-forward) ${TOKEN}` });
  await run(c.tools, 'github', { op: 'clone', repo: 'acme/theme' });
  const out = await run(c.tools, 'github', { op: 'commit_push', dir: 'theme', message: 'm' });
  assert.match(out, /force-push is never allowed/);
  assert.doesNotMatch(out, /github_pat_DEMO/);
  assert.equal(c.runCalls.filter((x) => gitSub(x) === 'push').length, 1);
});

test('merge / delete_branch / force_push are refused with the request_external_action to propose', async () => {
  const s = setup();
  const m = await run(s.tools, 'github', { op: 'merge', repo: 'acme/theme', number: 7 });
  assert.match(m, /^Refused/);
  assert.match(m, /request_external_action\(\{ type: "merge_pr"/);
  assert.match(m, /acme\/theme#7/);
  assert.match(await run(s.tools, 'github', { op: 'delete_branch', repo: 'acme/theme' }), /delete_branch/);
  assert.match(await run(s.tools, 'github', { op: 'force_push', repo: 'acme/theme' }), /force_push/);
  assert.equal(s.fetchCalls.length + s.runCalls.length, 0);
});

test('open_pr from agent/<task-id>, token redacted even when echoed; status and comment', async () => {
  const s = setup();
  const out = await run(s.tools, 'github', { op: 'open_pr', repo: 'acme/theme', title: 'Hero section', body: 'Plan…' });
  const post = s.fetchCalls.find((c) => c.method === 'POST')!;
  assert.equal(JSON.parse(post.body).head, `agent/${s.task.id}`);
  assert.equal(JSON.parse(post.body).base, 'main');
  assert.equal(post.headers.get('authorization'), `Bearer ${TOKEN}`);
  assert.match(out, /"number":7/);
  assert.doesNotMatch(out, /github_pat/);
  const st = await run(s.tools, 'github', { op: 'pr_status', repo: 'acme/theme', number: 7 });
  assert.match(st, /"checks":\[\{"name":"theme-check","status":"completed","conclusion":"success"\}\]/);
  assert.match(await run(s.tools, 'github', { op: 'comment', repo: 'acme/theme', number: 7, body: 'Ready for review' }), /Commented on acme\/theme#7/);
  assert.match(await run(s.tools, 'github', { op: 'comment', repo: 'acme/theme', number: 8, body: 'hi' }), /^Refused: You may only comment on this task's PR/);
  const logs = (s.deps as unknown as { logs: string[] }).logs.join('\n');
  assert.doesNotMatch(logs, /github_pat/);
});

test('vault credential: grant checked, use audited, token from the vault only', async () => {
  const v = fakeVault();
  const cred = v.add({ platform: 'github', secret: 'github_pat_VAULT_demo_987654321', urlAllowlist: ['https://api.github.com/repos/acme', 'https://github.com/acme'] });
  const wrong = v.add({ platform: 'shopify', secret: 'shpat_x_demo_123456' });
  const f = fakeEnv({ vault: v.vault, fetch: (c) => json({ default_branch: 'main', echo: c.headers.get('authorization') }) });
  const s = devSetup(f.env, 'fullstack-dev');
  const r = await run(s.tools, 'github', { op: 'pr_status', repo: 'acme/theme', number: 1, credential_id: cred });
  assert.doesNotMatch(r, /VAULT_demo/);
  assert.equal(f.fetchCalls[0]!.headers.get('authorization'), 'Bearer github_pat_VAULT_demo_987654321');
  assert.ok(v.store.log.some((e) => e.credentialId === cred && e.action === 'api_call' && e.detail?.tool === 'github'));
  assert.match(await run(s.tools, 'github', { op: 'pr_status', repo: 'acme/theme', number: 1, credential_id: wrong }), /is for shopify/);
  const s2 = devSetup(f.env, 'seo-1');
  assert.match(await run(s2.tools, 'github', { op: 'pr_status', repo: 'acme/theme', number: 1, credential_id: cred }), /not granted/);
});

test('no token configured → clear instruction, no calls', async () => {
  const f = fakeEnv();
  const s = devSetup(f.env, 'fullstack-dev');
  assert.match(await run(s.tools, 'github', { op: 'open_pr', repo: 'acme/theme', title: 't' }), /GITHUB_TOKEN_DEFAULT is not set/);
  assert.equal(f.fetchCalls.length, 0);
});
