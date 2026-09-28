// workspace_fs: list/read/write/patch/delete/mkdir inside the task jail; `brain/…` is read-only (via Brain).
import fs from 'node:fs';
import path from 'node:path';
import type { Brain } from '../brain';
import { checkRel, isGitInternal, isSecretName, JailError, relOf, resolveIn, type Jail } from './jail';

export const READ_MAX_BYTES = 100 * 1024;
export const WRITE_MAX_BYTES = 1024 * 1024;
const LIST_MAX = 500;
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', '.turbo', '.cache']);

export type FsOp = 'list' | 'read' | 'write' | 'patch' | 'delete' | 'mkdir';
export interface FsInput {
  op: FsOp;
  path: string;
  content?: string;
  old_string?: string;
  new_string?: string;
  replace_all?: boolean;
  recursive?: boolean;
  start_line?: number;
  end_line?: number;
}

const isBrain = (p: string) => /^brain(\/|$)/.test(p.trim().replace(/\\/g, '/'));

function brainOp(brain: Brain, i: FsInput): string {
  const rel = i.path.trim().replace(/\\/g, '/').replace(/^brain\/?/, '');
  if (i.op === 'read') return brain.read(rel);
  if (i.op === 'list') {
    const files = brain.list(rel);
    return files.length ? files.map((f) => `brain/${f}`).join('\n') : '(empty)';
  }
  throw new JailError('brain/ is read-only. Put your work in the workspace (paths without the brain/ prefix).');
}

function listDir(jail: Jail, abs: string, recursive: boolean): string {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= LIST_MAX) return;
      const p = path.join(dir, e.name);
      const rel = relOf(jail, p);
      if (e.isSymbolicLink()) { out.push(`${rel} -> (symlink)`); continue; }
      if (e.isDirectory()) {
        const skip = SKIP_DIRS.has(e.name);
        out.push(`${rel}/${skip && recursive ? ' (not expanded)' : ''}`);
        if (recursive && !skip && depth < 6) walk(p, depth + 1);
      } else {
        const note = isSecretName(e.name) ? ' [secret: off limits]' : '';
        let size = 0;
        try { size = fs.statSync(p).size; } catch { /* ignore */ }
        out.push(`${rel} (${size} B)${note}`);
      }
    }
  };
  walk(abs, 0);
  if (!out.length) return '(empty)';
  return out.length >= LIST_MAX ? `${out.join('\n')}\n…[stopped at ${LIST_MAX} entries; list a subfolder]` : out.join('\n');
}

function readFile(abs: string, rel: string, i: FsInput): string {
  const st = fs.statSync(abs);
  if (st.isDirectory()) throw new JailError(`"${rel}" is a directory; use op "list"`);
  const fd = fs.openSync(abs, 'r');
  let text: string;
  try {
    const buf = Buffer.alloc(Math.min(st.size, i.start_line || i.end_line ? 4 * READ_MAX_BYTES : READ_MAX_BYTES));
    fs.readSync(fd, buf, 0, buf.length, 0);
    if (buf.subarray(0, 8000).includes(0)) return `"${rel}" is a binary file (${st.size} B); not shown.`;
    text = buf.toString('utf8');
  } finally { fs.closeSync(fd); }
  if (i.start_line || i.end_line) {
    const lines = text.split('\n');
    const s = Math.max(1, i.start_line ?? 1);
    const e = Math.min(lines.length, i.end_line ?? s + 400);
    return lines.slice(s - 1, e).map((l, k) => `${s + k}\t${l}`).join('\n').slice(0, READ_MAX_BYTES);
  }
  return st.size > READ_MAX_BYTES
    ? `${text}\n…[truncated: file is ${st.size} bytes; read more with start_line/end_line]`
    : text;
}

/** Runs one workspace_fs call. Throws JailError for refusals (the tool turns it into text). */
export function workspaceFs(jail: Jail, brain: Brain, i: FsInput): string {
  if (isBrain(i.path)) return brainOp(brain, i);
  const rel = checkRel(i.path);
  const writing = i.op === 'write' || i.op === 'patch' || i.op === 'delete' || i.op === 'mkdir';
  if (writing && isGitInternal(rel)) throw new JailError('.git internals are managed by the github tool; do not edit them.');
  const abs = resolveIn(jail, rel, { noFinalSymlink: writing });

  switch (i.op) {
    case 'list': {
      if (!fs.existsSync(abs)) throw new JailError(`"${rel}" does not exist`);
      if (!fs.statSync(abs).isDirectory()) return `${rel} (${fs.statSync(abs).size} B)`;
      return listDir(jail, abs, i.recursive ?? false);
    }
    case 'read': {
      if (!fs.existsSync(abs)) throw new JailError(`"${rel}" does not exist`);
      return readFile(abs, rel, i);
    }
    case 'write': {
      if (i.content === undefined) throw new JailError('write needs `content`');
      const bytes = Buffer.byteLength(i.content);
      if (bytes > WRITE_MAX_BYTES) throw new JailError(`content is ${bytes} B; max ${WRITE_MAX_BYTES} per write`);
      if (rel === '.') throw new JailError('cannot write to the workspace root');
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) throw new JailError(`"${rel}" is a directory`);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      resolveIn(jail, rel, { noFinalSymlink: true }); // re-check after creating parents
      const existed = fs.existsSync(abs);
      fs.writeFileSync(abs, i.content);
      return `${existed ? 'Overwrote' : 'Created'} ${rel} (${bytes} B).`;
    }
    case 'patch': {
      if (i.old_string === undefined || i.new_string === undefined) throw new JailError('patch needs `old_string` and `new_string`');
      if (!i.old_string) throw new JailError('old_string must not be empty');
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new JailError(`"${rel}" does not exist`);
      const text = fs.readFileSync(abs, 'utf8');
      const count = text.split(i.old_string).length - 1;
      if (count === 0) throw new JailError(`old_string not found in ${rel}. Read the file and copy the exact text (whitespace counts).`);
      if (count > 1 && !i.replace_all) throw new JailError(`old_string occurs ${count} times in ${rel}; add surrounding lines to make it unique, or set replace_all.`);
      const next = i.replace_all ? text.split(i.old_string).join(i.new_string) : text.replace(i.old_string, () => i.new_string!);
      if (Buffer.byteLength(next) > WRITE_MAX_BYTES * 4) throw new JailError('resulting file is too large');
      fs.writeFileSync(abs, next);
      return `Patched ${rel} (${i.replace_all ? count : 1} replacement${(i.replace_all ? count : 1) > 1 ? 's' : ''}).`;
    }
    case 'delete': {
      if (rel === '.') throw new JailError('cannot delete the workspace root');
      if (!fs.existsSync(abs) && !isLink(abs)) throw new JailError(`"${rel}" does not exist`);
      const dir = !isLink(abs) && fs.statSync(abs).isDirectory();
      if (dir && !i.recursive) throw new JailError(`"${rel}" is a directory; set recursive: true to delete it`);
      fs.rmSync(abs, { recursive: dir, force: false });
      return `Deleted ${rel}${dir ? '/' : ''}.`;
    }
    case 'mkdir': {
      fs.mkdirSync(abs, { recursive: true });
      resolveIn(jail, rel);
      return `Directory ${rel}/ ready.`;
    }
  }
}

function isLink(abs: string): boolean {
  try { return fs.lstatSync(abs).isSymbolicLink(); } catch { return false; }
}
