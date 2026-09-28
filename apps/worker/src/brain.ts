// Read-only access to brain/ for agents (docs/05 "Workspaces & safety"): only .md files inside the
// brain root, no traversal or symlink escapes, size-capped, plus a small keyword search.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';

export const BRAIN_MAX_BYTES = 64 * 1024;

export class BrainAccessError extends Error {}

export interface BrainHit { path: string; score: number; snippet: string }

export interface Brain {
  root: string;
  /** Reads brain/<rel>. Accepts "clients/x/profile.md" or "brain/clients/x/profile.md". */
  read(rel: string, maxBytes?: number): string;
  /** Like read() but returns null when the file is missing or not allowed. */
  tryRead(rel: string, maxBytes?: number): string | null;
  exists(rel: string): boolean;
  list(dir?: string): string[];
  search(query: string, limit?: number): BrainHit[];
}

export function createBrain(root = config.brainDir): Brain {
  const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);

  function resolveSafe(rel: string): string {
    if (typeof rel !== 'string' || !rel.trim()) throw new BrainAccessError('path is required');
    if (rel.includes('\0')) throw new BrainAccessError('invalid path');
    let p = rel.trim().replace(/\\/g, '/');
    if (p.startsWith('brain/')) p = p.slice('brain/'.length);
    if (path.isAbsolute(p) || p.split('/').includes('..')) throw new BrainAccessError(`path "${rel}" is outside brain/`);
    const abs = path.resolve(realRoot, p);
    if (abs !== realRoot && !abs.startsWith(realRoot + path.sep)) throw new BrainAccessError(`path "${rel}" is outside brain/`);
    return abs;
  }

  function checkedFile(rel: string): string {
    const abs = resolveSafe(rel);
    if (path.extname(abs).toLowerCase() !== '.md') throw new BrainAccessError('only .md files can be read from brain/');
    if (!fs.existsSync(abs)) throw new BrainAccessError(`brain/${path.relative(realRoot, abs)} does not exist`);
    const real = fs.realpathSync(abs); // symlinks must not escape either
    if (!real.startsWith(realRoot + path.sep)) throw new BrainAccessError(`path "${rel}" is outside brain/`);
    if (!fs.statSync(real).isFile()) throw new BrainAccessError(`"${rel}" is not a file`);
    return real;
  }

  function read(rel: string, maxBytes = BRAIN_MAX_BYTES): string {
    const file = checkedFile(rel);
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(size, maxBytes));
      fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.toString('utf8');
      return size > maxBytes ? `${text}\n\n[truncated: file is ${size} bytes, showing first ${maxBytes}]` : text;
    } finally { fs.closeSync(fd); }
  }

  function list(dir = ''): string[] {
    const base = dir ? resolveSafe(dir) : realRoot;
    if (!fs.existsSync(base)) return [];
    const out: string[] = [];
    const walk = (d: string, depth: number) => {
      if (depth > 6) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const abs = path.join(d, e.name);
        if (e.isDirectory()) walk(abs, depth + 1);
        else if (e.isFile() && e.name.endsWith('.md')) out.push(path.relative(realRoot, abs).split(path.sep).join('/'));
      }
    };
    walk(base, 0);
    return out.sort();
  }

  function search(query: string, limit = 5): BrainHit[] {
    const terms = [...new Set(query.toLowerCase().split(/[^a-z0-9-]+/).filter((t) => t.length > 2))];
    if (!terms.length) return [];
    const hits: BrainHit[] = [];
    for (const rel of list()) {
      let text: string;
      try { text = read(rel); } catch { continue; }
      const lower = text.toLowerCase();
      const name = rel.toLowerCase();
      let score = 0;
      for (const t of terms) {
        let n = 0; let i = lower.indexOf(t);
        while (i !== -1 && n < 20) { n++; i = lower.indexOf(t, i + t.length); }
        score += n + (name.includes(t) ? 5 : 0);
      }
      if (score === 0) continue;
      const first = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
      const start = Math.max(0, first - 120);
      hits.push({ path: `brain/${rel}`, score, snippet: text.slice(start, start + 300).replace(/\s+/g, ' ').trim() });
    }
    return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, Math.max(1, Math.min(limit, 20)));
  }

  return {
    root: realRoot,
    read,
    tryRead: (rel, maxBytes) => { try { return read(rel, maxBytes); } catch { return null; } },
    exists: (rel) => { try { checkedFile(rel); return true; } catch { return false; } },
    list,
    search,
  };
}
