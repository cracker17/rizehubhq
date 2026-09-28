// Race-safe file access inside a task jail for the WORKER's own reads/writes (workspace_fs, theme pull/push,
// media upload, shell redirects). resolveIn() checks a path, but an agent process running in the background could
// swap a checked path (or a parent folder) for a symlink before the worker opens it. The worker runs as root in
// production, so a swapped path could otherwise make it read /proc/1/environ or write outside the jail.
// Every open here: O_NOFOLLOW on the last component, O_NONBLOCK (a planted FIFO cannot hang the worker), then
// the kernel's view of the opened file (/proc/self/fd/N) must be inside the jail and a regular file/directory.
// Writes never truncate before that check.
import fs from 'node:fs';
import path from 'node:path';
import { chownToAgent, type AgentIdentity } from './agentUser';
import { inside, JailError, type Jail } from './jail';

const C = fs.constants;
const NOFOLLOW = C.O_NOFOLLOW ?? 0;
const NONBLOCK = C.O_NONBLOCK ?? 0;
const DIRECTORY = C.O_DIRECTORY ?? 0;

/** Where fd really points (Linux /proc). null when /proc is unavailable. */
export function fdPath(fd: number): string | null {
  try { return fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { return null; }
}

function verify(jail: Jail, fd: number, abs: string, kind: 'file' | 'dir'): void {
  const real = fdPath(fd) ?? (() => { try { return fs.realpathSync(abs); } catch { return abs; } })();
  const st = fs.fstatSync(fd);
  if (!inside(jail.root, real)) throw new JailError('path resolves outside the workspace (symlink)');
  if (kind === 'file' && !st.isFile()) throw new JailError(`"${path.relative(jail.root, abs)}" is not a regular file`);
  if (kind === 'dir' && !st.isDirectory()) throw new JailError(`"${path.relative(jail.root, abs)}" is not a directory`);
}

function openChecked(jail: Jail, abs: string, flags: number, kind: 'file' | 'dir', mode = 0o644): number {
  if (!inside(jail.root, abs)) throw new JailError('path is outside the workspace');
  let fd: number;
  try { fd = fs.openSync(abs, flags | NOFOLLOW | NONBLOCK, mode); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || (code === 'ENOTDIR' && kind === 'dir')) throw new JailError(`"${path.relative(jail.root, abs)}" is a symlink; refusing`);
    if (code === 'ENXIO') throw new JailError(`"${path.relative(jail.root, abs)}" is not a regular file`);
    throw e;
  }
  try { verify(jail, fd, abs, kind); } catch (e) {
    // A race sent an O_CREAT open somewhere else: remove the empty file we just made there, if it is ours.
    if (flags & C.O_CREAT) {
      try {
        const real = fdPath(fd); const st = fs.fstatSync(fd);
        if (real && st.isFile() && st.size === 0 && st.nlink === 1 && st.uid === (process.getuid?.() ?? -1)) fs.unlinkSync(real);
      } catch { /* best effort */ }
    }
    fs.closeSync(fd);
    throw e;
  }
  return fd;
}

/** Reads a file in the jail (at most maxBytes when given) and returns its full size too. */
export function readInJailSized(jail: Jail, abs: string, maxBytes?: number): { data: Buffer; size: number } {
  const fd = openChecked(jail, abs, C.O_RDONLY, 'file');
  try {
    const size = fs.fstatSync(fd).size;
    const n = maxBytes === undefined ? size : Math.min(size, maxBytes);
    const buf = Buffer.alloc(n);
    let off = 0;
    while (off < n) { const r = fs.readSync(fd, buf, off, n - off, off); if (!r) break; off += r; }
    return { data: buf.subarray(0, off), size };
  } finally { fs.closeSync(fd); }
}

/** Reads a whole file in the jail (race-safe). */
export const readInJail = (jail: Jail, abs: string, maxBytes?: number): Buffer => readInJailSized(jail, abs, maxBytes).data;

/** Size of a regular file in the jail (verified like a read). */
export function statInJail(jail: Jail, abs: string): fs.Stats {
  const fd = openChecked(jail, abs, C.O_RDONLY, 'file');
  try { return fs.fstatSync(fd); } finally { fs.closeSync(fd); }
}

/** mkdir -p inside the jail, one verified component at a time; new folders are owned by the agent uid. */
export function mkdirpInJail(jail: Jail, absDir: string, owner?: AgentIdentity | null): void {
  if (!inside(jail.root, absDir)) throw new JailError('path is outside the workspace');
  const rel = path.relative(jail.root, absDir);
  let cur = jail.root;
  for (const seg of rel ? rel.split(path.sep) : []) {
    cur = path.join(cur, seg);
    let made = false;
    try { fs.mkdirSync(cur, { mode: 0o755 }); made = true; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    const fd = openChecked(jail, cur, C.O_RDONLY | DIRECTORY, 'dir');
    try { if (made && owner) fs.fchownSync(fd, owner.uid, owner.gid); } finally { fs.closeSync(fd); }
  }
}

/** Opens (creating if needed) a file for writing without following links; truncates only after the check. */
export function openForWrite(jail: Jail, abs: string, o: { append?: boolean; owner?: AgentIdentity | null } = {}): number {
  const fd = openChecked(jail, abs, C.O_WRONLY | C.O_CREAT | (o.append ? C.O_APPEND : 0), 'file');
  try {
    if (!o.append) fs.ftruncateSync(fd, 0);
    if (o.owner) fs.fchownSync(fd, o.owner.uid, o.owner.gid);
  } catch (e) { fs.closeSync(fd); throw e; }
  return fd;
}

/** Writes a whole file in the jail (parents created and verified). Returns whether it existed. */
export function writeInJail(jail: Jail, abs: string, data: string | Buffer, owner?: AgentIdentity | null): boolean {
  mkdirpInJail(jail, path.dirname(abs), owner);
  let existed = true;
  try { fs.lstatSync(abs); } catch { existed = false; }
  const fd = openForWrite(jail, abs, { owner });
  try { fs.writeSync(fd, typeof data === 'string' ? Buffer.from(data) : data); } finally { fs.closeSync(fd); }
  return existed;
}

/** Deletes a file or folder in the jail. With an agent identity the delete runs AS the agent (a race can then
 * only touch what the agent may touch anyway); otherwise fs.rmSync in-process. */
export function removeInJail(jail: Jail, abs: string, recursive: boolean, owner: AgentIdentity | null | undefined,
  spawnSync: typeof import('node:child_process').spawnSync): void {
  if (!inside(jail.root, abs) || abs === jail.root) throw new JailError('cannot delete that path');
  if (!owner) { fs.rmSync(abs, { recursive, force: false }); return; }
  const r = spawnSync('rm', [recursive ? '-rf' : '-f', '--', abs], { uid: owner.uid, gid: owner.gid, env: { PATH: '/usr/bin:/bin' }, timeout: 120_000, stdio: 'pipe' });
  if (r.error || r.status !== 0) throw new JailError(`delete failed: ${String(r.stderr ?? r.error?.message ?? '').trim().slice(0, 300)}`);
}

