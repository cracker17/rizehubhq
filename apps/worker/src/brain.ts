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

// ---------- role-specific context: the Content Writer's voice samples (brain/style/writing-samples/) ----------

export const WRITING_SAMPLES_DIR = 'style/writing-samples';
export interface WritingSample { path: string; text: string; truncated: boolean }
export interface WritingSampleLimits { maxFiles: number; maxFileChars: number; maxTotalChars: number }
export const WRITING_SAMPLE_LIMITS: WritingSampleLimits = { maxFiles: 5, maxFileChars: 6000, maxTotalChars: 20_000 };

/**
 * The CEO's own writing (.md / .txt dropped into brain/style/writing-samples/, README excluded), in name order,
 * capped per file and in total so a big sample never floods the prompt. Symlinks and non-files are skipped.
 */
export function loadWritingSamples(brain: Pick<Brain, 'root'>, limits: Partial<WritingSampleLimits> = {}): WritingSample[] {
  const lim = { ...WRITING_SAMPLE_LIMITS, ...limits };
  const dir = path.join(brain.root, ...WRITING_SAMPLES_DIR.split('/'));
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const files = names
    .filter((n) => /\.(md|txt)$/i.test(n) && !n.startsWith('.') && !/^readme\b/i.test(n))
    .sort((a, b) => a.localeCompare(b));
  const out: WritingSample[] = [];
  let total = 0;
  for (const name of files) {
    if (out.length >= lim.maxFiles || total >= lim.maxTotalChars) break;
    const abs = path.join(dir, name);
    let st: fs.Stats;
    try { st = fs.lstatSync(abs); } catch { continue; }
    if (!st.isFile()) continue; // no symlinks, no directories
    const cap = Math.min(lim.maxFileChars, lim.maxTotalChars - total);
    const fd = fs.openSync(abs, 'r');
    let raw: string;
    try {
      const buf = Buffer.alloc(Math.min(st.size, cap * 4));
      fs.readSync(fd, buf, 0, buf.length, 0);
      raw = buf.toString('utf8').replace(/�+$/, '').trim();
    } finally { fs.closeSync(fd); }
    if (!raw) continue;
    const text = raw.length > cap ? raw.slice(0, cap) : raw;
    const truncated = text.length < raw.length || st.size > cap * 4;
    total += text.length;
    out.push({ path: `brain/${WRITING_SAMPLES_DIR}/${name}`, text, truncated });
  }
  return out;
}

/** Prompt section with the writing samples, or '' when there are none. */
export function writingSamplesContext(brain: Pick<Brain, 'root'>, limits?: Partial<WritingSampleLimits>): string {
  const samples = loadWritingSamples(brain, limits);
  if (!samples.length) {
    return `## Writing samples\nNo samples in brain/${WRITING_SAMPLES_DIR}/ yet: follow brain/company/brand-voice.md and your role's style rules.`;
  }
  return [
    `## Writing samples (read before drafting: match this voice, not generic AI copy)`,
    'These are the CEO\'s own writing. Copy the rhythm, sentence length mix, word choice and warmth; never copy their facts or claims into client work.',
    ...samples.map((s) => `### ${s.path}${s.truncated ? ' (excerpt)' : ''}\n${s.text}`),
  ].join('\n\n');
}

/** Extra brain context a role always gets in its task prompt (agent id → section). Writer: the voice samples. */
export function roleBrainContext(brain: Pick<Brain, 'root'>, agentId: string): string {
  return agentId === 'writer' ? writingSamplesContext(brain) : '';
}
