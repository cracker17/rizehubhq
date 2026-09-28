// Per-task workspace jail (docs/05 "Workspaces & safety", docs/09 "Worker guardrails"): every path an agent
// gives is relative to WORKSPACES_DIR/<task-id>; absolute paths, `..`, symlinks that resolve outside the jail
// and secret-looking files (.env*, *.pem, id_*, …) are refused here, in code.
import fs from 'node:fs';
import path from 'node:path';

export class JailError extends Error {}

/** Secret-looking file names: never readable/writable by agents, never passed to commands, never committed. */
const SECRET_NAME = [
  /^\.env(\..*)?$/i, /\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i, /^id_[a-z0-9_]+(\.pub)?$/i,
  /^\.npmrc$/i, /^\.netrc$/i, /^\.git-credentials$/i, /^\.pgpass$/i, /^credentials(\.json)?$/i,
];
/** Templates that only list variable names (docs: ".env.example updated with names only"). */
const SECRET_TEMPLATE = /^\.env\.(example|sample|template|dist)$/i;

export function isSecretName(name: string): boolean {
  const base = name.split('/').pop() ?? name;
  if (SECRET_TEMPLATE.test(base)) return false;
  return SECRET_NAME.some((r) => r.test(base));
}

/** Any path segment secret-looking (a/b/.env/c counts too). */
export function pathHasSecret(rel: string): boolean {
  return rel.split(/[\\/]+/).some((seg) => seg && isSecretName(seg));
}

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;

export interface Jail {
  root: string; // realpath of WORKSPACES_DIR/<task-id>
  taskId: string;
}

/** Creates WORKSPACES_DIR/<task-id> on first use and returns its real path. */
export function openJail(workspacesDir: string, taskId: string): Jail {
  if (!SAFE_TASK_ID.test(taskId)) throw new JailError('invalid task id for a workspace');
  fs.mkdirSync(workspacesDir, { recursive: true });
  const base = fs.realpathSync(workspacesDir);
  const dir = path.join(base, taskId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  const root = fs.realpathSync(dir);
  if (root !== dir) throw new JailError('workspace directory is a symlink; refusing');
  return { root, taskId };
}

export function inside(root: string, abs: string): boolean {
  return abs === root || abs.startsWith(root + path.sep);
}

/** Checks the syntax of an agent-supplied relative path. Returns the normalised relative form ('.' for root). */
export function checkRel(rel: string): string {
  if (typeof rel !== 'string') throw new JailError('path is required');
  const p = rel.trim().replace(/\\/g, '/');
  if (!p) throw new JailError('path is required');
  if (p.includes('\0')) throw new JailError('invalid path');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.startsWith('~')) throw new JailError(`absolute paths are not allowed ("${rel}"); use a path relative to the workspace`);
  if (p.split('/').includes('..')) throw new JailError(`".." is not allowed ("${rel}")`);
  if (pathHasSecret(p)) throw new JailError(`"${rel}" looks like a secret file (.env, key, token file); it is off limits`);
  const norm = path.posix.normalize(p).replace(/\/+$/, '');
  return norm === '' ? '.' : norm;
}

/** Real path of the deepest existing ancestor of abs (abs itself if it exists). */
function realDeepest(abs: string): { real: string; rest: string } {
  let cur = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      return { real: fs.realpathSync(cur), rest: rest.reverse().join(path.sep) };
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) throw new JailError('path does not resolve');
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Resolves a relative path inside the jail. Existing components are resolved through symlinks and must stay
 * inside; with `noFinalSymlink` the target itself may not be a symlink (writes/deletes never follow links).
 */
export function resolveIn(jail: Jail, rel: string, opts: { noFinalSymlink?: boolean } = {}): string {
  const norm = checkRel(rel);
  const abs = path.resolve(jail.root, norm);
  if (!inside(jail.root, abs)) throw new JailError(`"${rel}" is outside the workspace`);
  const { real, rest } = realDeepest(abs);
  const finalReal = rest ? path.join(real, rest) : real;
  if (!inside(jail.root, finalReal)) throw new JailError(`"${rel}" resolves outside the workspace (symlink)`);
  if (opts.noFinalSymlink) {
    try { if (fs.lstatSync(abs).isSymbolicLink()) throw new JailError(`"${rel}" is a symlink; refusing to write through it`); } catch (e) { if (e instanceof JailError) throw e; }
  }
  return abs;
}

/** Relative path (posix) of an absolute path inside the jail. */
export const relOf = (jail: Jail, abs: string) => path.relative(jail.root, abs).split(path.sep).join('/') || '.';

/** True for paths inside a .git directory (agents manage git through the `github` tool, not by editing .git). */
export const isGitInternal = (rel: string) => rel.split('/').includes('.git');
