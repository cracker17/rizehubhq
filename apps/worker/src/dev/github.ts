// github: clone / branch / commit+push / PR / status / comment. Rules enforced here:
// * the only branch an agent may create or push is agent/<task-id> (never main/master, never another name)
// * pushes use a fixed refspec HEAD:refs/heads/agent/<task-id> — no force, no deletes, no tags
// * merge / branch delete / force push are refused → request_external_action
// * the token reaches git only through a GIT_ASKPASS helper in a worker-private dir, via the env of git
//   processes started by this tool; never in argv, never in the repo config, never in the agent's bash env
// * git runs with hooks disabled and the repo's local config is checked for command-executing keys first
import fs from 'node:fs';
import path from 'node:path';
import type { DevEnv } from './env';
import { apiError, httpRequest, truncate, type HttpRes, type Redactor } from './http';
import { inside, isSecretName, resolveIn, type Jail } from './jail';
import { externalAction, type Token } from './creds';
import { sandboxEnv } from './shell';

export const API = 'https://api.github.com';
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
export const agentBranch = (taskId: string) => `agent/${taskId}`;

export class GithubRefusal extends Error {}
const refuse = (m: string): never => { throw new GithubRefusal(m); };

export function checkRepo(repo: string): string {
  const r = repo.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/i, '');
  if (!REPO_RE.test(r) || r.split('/').some((p) => p === '.' || p === '..')) refuse(`repo must look like "owner/name" (got "${repo}")`);
  return r;
}

/** The only branch name allowed for a task. */
export function checkBranch(taskId: string, branch?: string | null): string {
  const want = agentBranch(taskId);
  if (branch && branch.trim() !== want) {
    refuse(`Branch "${branch}" is not allowed. Agents work only on "${want}" (main/master and other branches are protected).`);
  }
  return want;
}

/** Local git config keys that make git run commands or change where it talks to. */
const UNSAFE_CONFIG = /^(core\.(fsmonitor|sshcommand|pager|editor|askpass|hookspath|gitproxy|worktree)|credential\.|alias\.|include\.|includeif\.|filter\.|diff\..+\.(textconv|command)|merge\..+\.driver|http\.|url\.|remote\..+\.(receivepack|uploadpack|pushurl|proxy|vcs)|protocol\.|gpg\.|sequence\.editor|uploadpack\.|receive\.|pager\.|interactive\.difffilter|push\.)/i;

export function unsafeConfigKeys(configList: string): string[] {
  return configList.split('\n').map((l) => l.split('=')[0]!.trim()).filter((k) => k && UNSAFE_CONFIG.test(k));
}

const ASKPASS = '#!/bin/sh\ncase "$1" in\n  Username*) printf \'%s\\n\' "x-access-token" ;;\n  *) printf \'%s\\n\' "$RIZEHUB_GIT_TOKEN" ;;\nesac\n';

export function askpassPath(env: DevEnv): string {
  const p = path.join(env.helperDir(), 'askpass.sh');
  if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== ASKPASS) {
    fs.writeFileSync(p, ASKPASS, { mode: 0o700 });
    fs.chmodSync(p, 0o700);
  }
  return p;
}

/** Hardening flags on every git call made by this tool. */
export const GIT_SAFE_FLAGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'credential.helper=', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always'];

export interface GitCtx { env: DevEnv; jail: Jail; red: Redactor }

async function git(g: GitCtx, cwd: string, args: string[], token?: Token, timeoutMs = 300_000) {
  const base = sandboxEnv(g.jail, g.env.env, g.env.sandboxPath);
  const env: Record<string, string> = { ...base, HOME: g.env.helperDir(), GIT_CONFIG_GLOBAL: '/dev/null' };
  if (token) {
    env.GIT_ASKPASS = askpassPath(g.env);
    env.RIZEHUB_GIT_TOKEN = token.token;
  }
  const r = await g.env.run('git', [...GIT_SAFE_FLAGS, ...args], { cwd, env, timeoutMs });
  const text = g.red.apply(`${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`.trim());
  return { ok: r.code === 0 && !r.timedOut, text: r.timedOut ? `timed out. ${text}` : text, stdout: r.stdout };
}

function repoDir(jail: Jail, dir: string): string {
  const abs = resolveIn(jail, dir);
  if (!fs.existsSync(path.join(abs, '.git'))) refuse(`"${dir}" is not a git repository in the workspace (clone it first)`);
  const real = fs.realpathSync(path.join(abs, '.git'));
  if (!inside(jail.root, real)) refuse('.git resolves outside the workspace');
  return abs;
}

async function assertSafeConfig(g: GitCtx, cwd: string) {
  const r = await git(g, cwd, ['config', '--local', '--list']);
  const bad = unsafeConfigKeys(r.stdout);
  if (bad.length) refuse(`The repo's .git/config contains keys the worker will not run with a token (${bad.join(', ')}). Re-clone the repo.`);
}

async function originRepo(g: GitCtx, cwd: string): Promise<string> {
  const r = await git(g, cwd, ['remote', 'get-url', 'origin']);
  const m = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+?)(\.git)?\s*$/i.exec(r.stdout.trim());
  if (!r.ok || !m) refuse('origin must be an https://github.com/<owner>/<repo> URL (clone with the github tool)');
  return checkRepo(m![1]!);
}

// ---------- git operations ----------
export async function clone(g: GitCtx, token: Token, repoIn: string, dirIn?: string, depth?: number): Promise<string> {
  const repo = checkRepo(repoIn);
  const dir = (dirIn?.trim() || repo.split('/')[1]!);
  const abs = resolveIn(g.jail, dir, { noFinalSymlink: true });
  if (abs === g.jail.root) refuse('clone into a subfolder, not the workspace root');
  if (fs.existsSync(abs) && fs.readdirSync(abs).length) refuse(`"${dir}" already exists and is not empty`);
  const args = ['clone', '--no-recurse-submodules'];
  if (depth) args.push('--depth', String(Math.min(Math.max(1, Math.floor(depth)), 1000)));
  args.push('--', `https://github.com/${repo}.git`, abs);
  const r = await git(g, g.jail.root, args, token);
  if (!r.ok) return `Clone failed: ${truncate(r.text, 2000)}`;
  return `Cloned ${repo} into ${dir}/. Next: github op "create_branch" with dir "${dir}".`;
}

export async function createBranch(g: GitCtx, dir: string, branchIn?: string | null): Promise<string> {
  const branch = checkBranch(g.jail.taskId, branchIn);
  const cwd = repoDir(g.jail, dir);
  const exists = await git(g, cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  const r = await git(g, cwd, exists.ok ? ['checkout', branch] : ['checkout', '-b', branch]);
  if (!r.ok) return `Could not switch to ${branch}: ${truncate(r.text, 2000)}`;
  return `On branch ${branch} in ${dir}/.`;
}

export async function commitPush(g: GitCtx, token: Token, dir: string, message: string): Promise<string> {
  const branch = agentBranch(g.jail.taskId);
  const cwd = repoDir(g.jail, dir);
  const head = await git(g, cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (head.stdout.trim() !== branch) refuse(`You are on "${head.stdout.trim()}". Commit and push only from ${branch} (github op "create_branch").`);
  if (!message.trim()) refuse('commit message is required');
  await assertSafeConfig(g, cwd);
  const repo = await originRepo(g, cwd);

  const add = await git(g, cwd, ['add', '-A']);
  if (!add.ok) return `git add failed: ${truncate(add.text, 2000)}`;
  const staged = (await git(g, cwd, ['diff', '--cached', '--name-only'])).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const secrets = staged.filter((f) => f.split('/').some(isSecretName));
  if (secrets.length) {
    await git(g, cwd, ['reset', '-q', '--', ...secrets]);
    refuse(`Refused to commit secret-looking files: ${secrets.join(', ')}. Delete them or add them to .gitignore, then try again.`);
  }
  let committed = 'nothing new to commit';
  if (staged.length) {
    const c = await git(g, cwd, ['commit', '--no-verify', '--no-gpg-sign', '-m', message.slice(0, 5000)]);
    if (!c.ok) return `git commit failed: ${truncate(c.text, 2000)}`;
    committed = `committed ${staged.length} file(s)`;
  }
  // Explicit URL + fixed refspec: remote config (pushurl, mirror, force refspecs) is never used.
  const p = await git(g, cwd, ['push', '--no-verify', '--porcelain', `https://github.com/${repo}.git`, `HEAD:refs/heads/${branch}`], token);
  if (!p.ok) {
    const nonFf = /non-fast-forward|fetch first|rejected/i.test(p.text);
    return `Push failed${nonFf ? ' (the remote branch has commits you do not have; force-push is never allowed — pull/rebase onto origin first)' : ''}: ${truncate(p.text, 2000)}`;
  }
  const sha = (await git(g, cwd, ['rev-parse', 'HEAD'])).stdout.trim();
  return `${committed}; pushed ${sha.slice(0, 12)} to ${repo}@${branch}. Next: github op "open_pr".`;
}

// ---------- REST ----------
export interface GhCtx { env: DevEnv; token: Token; red: Redactor; taskId: string }

async function gh(c: GhCtx, method: string, p: string, body?: unknown): Promise<HttpRes> {
  return httpRequest(c.env, {
    url: `${API}${p}`, method,
    headers: {
      authorization: `Bearer ${c.token.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
      'user-agent': 'rizehub-hq-worker', ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

export async function openPr(c: GhCtx, repoIn: string, title: string, body: string, base?: string, draft?: boolean): Promise<string> {
  const repo = checkRepo(repoIn);
  const head = agentBranch(c.taskId);
  if (!title.trim()) refuse('title is required');
  let baseBranch = base?.trim();
  if (!baseBranch) {
    const r = await gh(c, 'GET', `/repos/${repo}`);
    if (!r.ok) return apiError('Reading the repo', r);
    baseBranch = String((r.json as { default_branch?: string }).default_branch ?? 'main');
  }
  if (baseBranch === head) refuse('base and head are the same branch');
  const r = await gh(c, 'POST', `/repos/${repo}/pulls`, { title: title.slice(0, 250), body: body.slice(0, 60_000), head, base: baseBranch, draft: Boolean(draft) });
  if (r.status === 422 && /already exists/i.test(r.text)) {
    const ex = await gh(c, 'GET', `/repos/${repo}/pulls?head=${encodeURIComponent(`${repo.split('/')[0]}:${head}`)}&state=open`);
    const pr = Array.isArray(ex.json) ? (ex.json as { number: number; html_url: string }[])[0] : undefined;
    if (pr) return JSON.stringify({ ok: true, existing: true, number: pr.number, url: pr.html_url, head, base: baseBranch, note: 'A PR for this branch already exists; new pushes update it.' });
  }
  if (!r.ok) return apiError('Opening the PR', r);
  const pr = r.json as { number: number; html_url: string; state: string };
  return JSON.stringify({ ok: true, number: pr.number, url: pr.html_url, head, base: baseBranch, state: pr.state,
    note: 'Never merge: merging is request_external_action({ type: "merge_pr", … }).' });
}

async function prOfTask(c: GhCtx, repo: string, n: number) {
  if (!Number.isInteger(n) || n < 1) refuse('number must be a PR number');
  const r = await gh(c, 'GET', `/repos/${repo}/pulls/${n}`);
  return r;
}

export async function prStatus(c: GhCtx, repoIn: string, n: number): Promise<string> {
  const repo = checkRepo(repoIn);
  const r = await prOfTask(c, repo, n);
  if (!r.ok) return apiError('Reading the PR', r);
  const pr = r.json as { number: number; state: string; merged: boolean; mergeable: boolean | null; mergeable_state?: string; draft?: boolean; html_url: string; head: { ref: string; sha: string }; base: { ref: string }; title: string };
  const [checks, status] = await Promise.all([
    gh(c, 'GET', `/repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=50`),
    gh(c, 'GET', `/repos/${repo}/commits/${pr.head.sha}/status`),
  ]);
  const runs = ((checks.json as { check_runs?: { name: string; status: string; conclusion: string | null; html_url?: string }[] } | null)?.check_runs ?? [])
    .map((x) => ({ name: x.name, status: x.status, conclusion: x.conclusion }));
  const st = status.json as { state?: string; statuses?: { context: string; state: string; description?: string }[] } | null;
  return truncate(JSON.stringify({
    number: pr.number, title: pr.title, url: pr.html_url, state: pr.state, merged: pr.merged, draft: pr.draft ?? false,
    mergeable: pr.mergeable, mergeable_state: pr.mergeable_state, head: pr.head.ref, base: pr.base.ref, sha: pr.head.sha.slice(0, 12),
    checks: runs, combined_status: st?.state ?? null,
    statuses: (st?.statuses ?? []).map((s) => ({ context: s.context, state: s.state, description: s.description })),
  }));
}

export async function comment(c: GhCtx, repoIn: string, n: number, body: string): Promise<string> {
  const repo = checkRepo(repoIn);
  if (!body.trim()) refuse('comment body is required');
  const r = await prOfTask(c, repo, n);
  if (!r.ok) return apiError('Reading the PR', r);
  const ref = (r.json as { head?: { ref?: string } }).head?.ref;
  if (ref !== agentBranch(c.taskId)) refuse(`You may only comment on this task's PR (head ${agentBranch(c.taskId)}); PR #${n} is from "${ref}".`);
  const w = await gh(c, 'POST', `/repos/${repo}/issues/${n}/comments`, { body: body.slice(0, 20_000) });
  if (!w.ok) return apiError('Commenting', w);
  return `Commented on ${repo}#${n}: ${(w.json as { html_url?: string }).html_url ?? ''}`;
}

export function refusedGithubOp(op: string, repo?: string, number?: number): string {
  const target = `${repo ?? '<owner/repo>'}${number ? `#${number}` : ''}`;
  if (op === 'merge') return externalAction('merge_pr', `Merge PR ${target} into its base branch`);
  if (op === 'delete_branch') return externalAction('delete_branch', `Delete a branch on ${target}`);
  return externalAction('force_push', `Force-push on ${target} (normally never needed: rebase and push a new commit instead)`);
}
