// The VPS copy of the vault: clone once, then fast-forward to origin/<branch>. M1 never writes to the clone, so a
// fast-forward always works; if history was rewritten upstream the clone is reset to origin (logged by the caller).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface GitOptions {
  repoUrl: string;
  branch: string;
  dir: string;
  /** SSH deploy key; empty = plain git (local path remotes in dev/tests) */
  deployKeyPath?: string;
  knownHostsPath?: string;
}

export interface PullResult { from: string | null; to: string; changed: boolean; reset: boolean; cloned: boolean }

function gitEnv(o: GitOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  if (o.deployKeyPath) {
    const q = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
    env.GIT_SSH_COMMAND = [
      'ssh', '-i', q(o.deployKeyPath), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
      ...(o.knownHostsPath ? ['-o', `UserKnownHostsFile=${q(o.knownHostsPath)}`] : []),
    ].join(' ');
  }
  return env;
}

async function git(o: GitOptions, args: string[], cwd = o.dir): Promise<string> {
  try {
    const { stdout } = await run('git', args, { cwd, env: gitEnv(o), timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error(`git ${args[0]} failed: ${(err.stderr || err.message).trim().split('\n').slice(-3).join(' | ')}`);
  }
}

export const isClone = (dir: string) => fs.existsSync(path.join(dir, '.git'));

export async function head(o: GitOptions): Promise<string> {
  return git(o, ['rev-parse', 'HEAD']);
}

/** Clone if needed, then fast-forward (or reset) to origin/<branch>. */
export async function pull(o: GitOptions): Promise<PullResult> {
  if (!o.repoUrl) throw new Error('BRAIN_REPO_URL is not set');
  if (!isClone(o.dir)) {
    fs.mkdirSync(path.dirname(o.dir), { recursive: true });
    await git(o, ['clone', '--branch', o.branch, '--single-branch', o.repoUrl, o.dir], path.dirname(o.dir));
    return { from: null, to: await head(o), changed: true, reset: false, cloned: true };
  }
  const from = await head(o);
  await git(o, ['fetch', '--prune', 'origin', `+refs/heads/${o.branch}:refs/remotes/origin/${o.branch}`]);
  const to = await git(o, ['rev-parse', `origin/${o.branch}`]);
  if (to === from) return { from, to, changed: false, reset: false, cloned: false };
  let reset = false;
  try {
    await git(o, ['merge-base', '--is-ancestor', from, to]);
    await git(o, ['merge', '--ff-only', '--quiet', to]);
  } catch {
    await git(o, ['reset', '--hard', '--quiet', to]); // upstream history was rewritten; the clone holds no local work
    reset = true;
  }
  return { from, to, changed: true, reset, cloned: false };
}

/** Files changed between two commits: {path, status A|M|D} (renames split into D + A). */
export async function changedFiles(o: GitOptions, from: string, to: string): Promise<Array<{ path: string; status: 'A' | 'M' | 'D' }>> {
  const out = await git(o, ['diff', '--name-status', '--no-renames', '-z', from, to]);
  const parts = out.split('\0').filter(Boolean);
  const files: Array<{ path: string; status: 'A' | 'M' | 'D' }> = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const s = parts[i][0];
    files.push({ path: parts[i + 1], status: s === 'A' ? 'A' : s === 'D' ? 'D' : 'M' });
  }
  return files;
}

/** Author of the newest commit (event actor for PC pushes: the vault's sync commits as the PC's git user). */
export async function lastAuthor(o: GitOptions): Promise<string> {
  return git(o, ['log', '-1', '--format=%an']).catch(() => '');
}
