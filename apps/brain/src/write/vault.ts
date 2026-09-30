// Vault write operations for the connector (docs/16-BRAIN.md "Write path"). Each one is a pure function of the working
// tree: it reads the current files, edits them and returns what it changed. The service runs it on a freshly pulled
// clone and, when the push loses a race with the PC, resets and runs it again on the new tree (so it never merges).
// Same file conventions as the vault's /save and /new-project commands (claude-commands/*.md).
import fs from 'node:fs';
import path from 'node:path';
import { findSecret } from '../secretScan';
import { appendToSection, oneLine, setFrontmatter, setSection, slugify } from './markdown';

export class WriteError extends Error {}

export interface ProjectEntry { slug: string; name?: string; aliases?: string[]; paths?: string[] }
export interface WriteResult { paths: string[]; project: string | null; summary: string; message: string; detail?: Record<string, unknown> }
export type VaultOp = (dir: string, today: string) => WriteResult;

const MAX_FIELD = 20_000;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function readProjects(dir: string): ProjectEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'projects.json'), 'utf8')) as { projects?: ProjectEntry[] };
    return Array.isArray(raw.projects) ? raw.projects.filter((p) => p && typeof p.slug === 'string') : [];
  } catch { return []; }
}

/** Slug, name or alias (case-insensitive; partial match only when it is unique) → the project's slug. */
export function resolveProject(dir: string, ask: string): string {
  const q = oneLine(ask, 100).toLowerCase();
  if (!q) throw new WriteError('project is required');
  const all = readProjects(dir);
  const exact = all.filter((p) => p.slug === q || p.name?.toLowerCase() === q || (p.aliases ?? []).some((a) => a.toLowerCase() === q));
  if (exact.length === 1) return exact[0]!.slug;
  const partial = exact.length ? exact : all.filter((p) => p.slug.includes(q) || p.name?.toLowerCase().includes(q) || (p.aliases ?? []).some((a) => a.toLowerCase().includes(q)));
  if (partial.length === 1) return partial[0]!.slug;
  if (!partial.length) throw new WriteError(`no project matches "${ask}". Use brain_list_projects, or brain_create_project for a new one.`);
  throw new WriteError(`"${ask}" matches several projects: ${partial.slice(0, 8).map((p) => p.slug).join(', ')}. Use the exact slug.`);
}

/** Refuse text that looks like a secret: the brain stores where a key lives, never the key (vault rule 7). */
function clean(label: string, v: unknown, max = MAX_FIELD): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new WriteError(`${label} must be text`);
  if (v.length > max) throw new WriteError(`${label} is too long (max ${max} characters)`);
  const hit = findSecret(v);
  if (hit) throw new WriteError(`${label} looks like it contains a secret (${hit}). Write where the secret is stored instead, never the value.`);
  return v.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}
function list(label: string, v: unknown, maxItems = 50): string[] {
  if (v === undefined || v === null) return [];
  const arr = typeof v === 'string' ? [v] : v;
  if (!Array.isArray(arr)) throw new WriteError(`${label} must be a list of text lines`);
  if (arr.length > maxItems) throw new WriteError(`${label}: at most ${maxItems} items`);
  return arr.map((x, i) => oneLine(clean(`${label}[${i}]`, x, 2000), 2000)).filter(Boolean);
}

const rel = (...p: string[]) => p.join('/');
const writeFile = (dir: string, relPath: string, text: string) => {
  const abs = path.join(dir, ...relPath.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text.endsWith('\n') ? text : `${text}\n`);
};
const readFile = (dir: string, relPath: string) => {
  const abs = path.join(dir, ...relPath.split('/'));
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
};

function memoryPath(dir: string, slug: string): string {
  const p = rel('projects', slug, 'memory.md');
  if (readFile(dir, p) === null) throw new WriteError(`projects/${slug}/memory.md does not exist`);
  return p;
}

export interface MemoryUpdate {
  decisions?: unknown;         // new "- YYYY-MM-DD: …" lines in ## Decisions log
  next_steps?: unknown;        // replaces ## Open next steps (the current list, done items removed)
  add_next_steps?: unknown;    // bullets added to ## Open next steps (agent proposals)
  status?: unknown;            // replaces ## Status
  facts?: unknown;             // [{section, lines[]}]: bullets added to a section (Links, Contacts, Overview…)
}

function applyMemory(md: string, u: MemoryUpdate, today: string): { md: string; changes: string[] } {
  const changes: string[] = [];
  const decisions = list('decisions', u.decisions).map((d) => (/^\d{4}-\d{2}-\d{2}:/.test(d) ? d : `${today}: ${d}`));
  if (decisions.length) {
    const r = appendToSection(md, 'Decisions log', decisions);
    md = r.md;
    if (r.added) changes.push(`${r.added} decision${r.added > 1 ? 's' : ''}`);
  }
  if (u.status !== undefined) {
    const s = list('status', u.status, 20);
    if (s.length) { md = setSection(md, 'Status', s); changes.push('status'); }
  }
  if (u.facts !== undefined) {
    if (!Array.isArray(u.facts) || u.facts.length > 10) throw new WriteError('facts must be a list of {section, lines}');
    for (const [i, f] of u.facts.entries()) {
      const section = oneLine(clean(`facts[${i}].section`, (f as { section?: unknown })?.section, 60), 60);
      if (!section || /^(decisions log|open next steps|status)$/i.test(section)) throw new WriteError(`facts[${i}].section must name another section (e.g. Links, Contacts, Overview)`);
      const r = appendToSection(md, section, list(`facts[${i}].lines`, (f as { lines?: unknown })?.lines, 30));
      md = r.md;
      if (r.added) changes.push(`${r.added} fact${r.added > 1 ? 's' : ''} in ${section}`);
    }
  }
  if (u.add_next_steps !== undefined) {
    const r = appendToSection(md, 'Open next steps', list('add_next_steps', u.add_next_steps, 10));
    md = r.md;
    if (r.added) changes.push(`${r.added} next step${r.added > 1 ? 's' : ''}`);
  }
  if (u.next_steps !== undefined) {
    const s = list('next_steps', u.next_steps, 30);
    md = setSection(md, 'Open next steps', s.length ? s : ['(none)']);
    changes.push('next steps');
  }
  return { md, changes };
}

export function updateMemoryOp(project: string, u: MemoryUpdate): VaultOp {
  return (dir, today) => {
    const slug = resolveProject(dir, project);
    const p = memoryPath(dir, slug);
    const { md, changes } = applyMemory(readFile(dir, p)!, u, today);
    if (!changes.length) throw new WriteError('nothing to change: give decisions, next_steps, status or facts (or it is already there)');
    writeFile(dir, p, setFrontmatter(md, 'updated', today));
    const summary = `memory: ${changes.join(', ')}`;
    return { paths: [p], project: slug, summary, message: `brain: update ${slug} memory (${changes.join(', ')})` };
  };
}

export interface SessionInput extends MemoryUpdate {
  project: unknown;
  title: unknown;
  source?: unknown;
  goal?: unknown;
  what_we_did?: unknown;
  files?: unknown;
}
const SOURCES = ['web', 'desktop', 'mobile', 'claude-code', 'agent'];

/** /save: a session summary file + a LOG.md line + the memory.md updates, in one commit. */
export function saveSessionOp(s: SessionInput): VaultOp {
  return (dir, today) => {
    const slug = resolveProject(dir, String(s.project ?? ''));
    const title = oneLine(clean('title', s.title, 200), 120);
    if (!title) throw new WriteError('title is required');
    const source = typeof s.source === 'string' && SOURCES.includes(s.source) ? s.source : 'web';
    const decisions = list('decisions', s.decisions);
    const nextSteps = list('next_steps', s.next_steps, 30);
    const did = list('what_we_did', s.what_we_did);
    const files = list('files', s.files);
    const goal = clean('goal', s.goal, 2000).trim();
    const bullets = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '- (none)');
    const body = [
      '---', `project: ${slug}`, `source: ${source}`, `date: ${today}`, '---', `# ${title}`,
      '## Goal', goal || '-', '## What we did', bullets(did), '## Decisions', bullets(decisions),
      '## Files / URLs / repos', bullets(files), '## Open next steps', bullets(nextSteps),
    ].join('\n');
    const base = `${today}-${slugify(title, 50) || 'session'}`;
    let name = `${base}.md`;
    for (let i = 2; readFile(dir, rel('projects', slug, 'sessions', name)) !== null; i++) name = `${base}-${i}.md`;
    const sessionPath = rel('projects', slug, 'sessions', name);
    writeFile(dir, sessionPath, body);

    const logPath = rel('projects', slug, 'sessions', 'LOG.md');
    const log = (readFile(dir, logPath) ?? '# Session log\n').replace(/\s+$/, '');
    writeFile(dir, logPath, `${log}\n- ${today} [${source}] ${title} -> ${name}`);

    const paths = [sessionPath, logPath];
    const mem = rel('projects', slug, 'memory.md');
    const current = readFile(dir, mem);
    if (current !== null) {
      const { md } = applyMemory(current, { decisions, next_steps: s.next_steps === undefined ? undefined : nextSteps, status: s.status, facts: s.facts }, today);
      writeFile(dir, mem, setFrontmatter(md, 'updated', today));
      paths.push(mem);
    }
    return { paths, project: slug, summary: `session saved: ${title}`, message: `brain: save ${slug} - ${title}`, detail: { file: sessionPath } };
  };
}

export interface NewProject { name: unknown; slug?: unknown; aliases?: unknown; description?: unknown; client?: unknown; platform?: unknown; links?: unknown }

/** /new-project: projects.json entry + memory.md from projects/_template + sessions/LOG.md. */
export function createProjectOp(n: NewProject): VaultOp {
  return (dir, today) => {
    const name = oneLine(clean('name', n.name, 200), 100);
    if (!name) throw new WriteError('name is required');
    const slug = typeof n.slug === 'string' && n.slug ? n.slug.trim() : slugify(name);
    if (!SLUG_RE.test(slug)) throw new WriteError(`bad slug "${slug}": lowercase letters, digits and "-"`);
    const aliases = [...new Set([name.toLowerCase(), slug, ...list('aliases', n.aliases, 20).map((a) => a.toLowerCase())])];
    const all = readProjects(dir);
    const clash = all.find((p) => p.slug === slug || p.name?.toLowerCase() === name.toLowerCase()
      || (p.aliases ?? []).some((a) => aliases.includes(a.toLowerCase())));
    if (clash) throw new WriteError(`already exists as "${clash.slug}" (${clash.name ?? clash.slug}). Load it with brain_load_project instead.`);
    if (fs.existsSync(path.join(dir, 'projects', slug))) throw new WriteError(`projects/${slug}/ already exists`);

    const rawJson = readFile(dir, 'projects.json');
    const doc = rawJson ? JSON.parse(rawJson) as { projects: ProjectEntry[] } : { projects: [] };
    doc.projects.push({ slug, name, aliases, paths: [] });
    writeFile(dir, 'projects.json', JSON.stringify(doc, null, 2));

    let md = readFile(dir, rel('projects', '_template', 'memory.md'))
      ?? `---\nproject: SLUG\nname: NAME\nupdated: YYYY-MM-DD\n---\n# NAME\n\n## Overview\n-\n\n## Links\n-\n\n## Status\n-\n\n## Decisions log\n\n## Open next steps\n-\n`;
    md = md.replace(/^project: SLUG$/m, `project: ${slug}`).replace(/^name: NAME$/m, `name: ${name}`)
      .replace(/^updated: YYYY-MM-DD$/m, `updated: ${today}`).replace(/^# NAME$/m, `# ${name}`);
    const overview = [
      ...(n.description ? [`What it is: ${oneLine(clean('description', n.description, 500), 500)}`] : []),
      ...(n.client ? [`Client / owner: ${oneLine(clean('client', n.client, 200), 200)}`] : []),
      ...(n.platform ? [`Platform / stack: ${oneLine(clean('platform', n.platform, 200), 200)}`] : []),
    ];
    // Filled fields replace the template's empty "- What it is:" lines.
    for (const line of overview) {
      const key = line.slice(0, line.indexOf(':') + 1);
      const re = new RegExp(`^- ${key.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\s*$`, 'm');
      md = re.test(md) ? md.replace(re, `- ${line}`) : appendToSection(md, 'Overview', [line]).md;
    }
    const links = list('links', n.links, 20);
    if (links.length) md = appendToSection(md, 'Links', links).md;
    const memPath = rel('projects', slug, 'memory.md');
    const logPath = rel('projects', slug, 'sessions', 'LOG.md');
    writeFile(dir, memPath, md);
    writeFile(dir, logPath, '# Session log');
    return { paths: ['projects.json', memPath, logPath], project: slug, summary: `new project ${name}`, message: `brain: new project ${slug}`, detail: { slug } };
  };
}
