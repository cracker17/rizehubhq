// Vault file → brain document: kind + project from the path, frontmatter, title and date.
// Layout (claude-memory-vault): projects/<slug>/memory.md · projects/<slug>/sessions/YYYY-MM-DD-topic.md (+ LOG.md,
// -code- transcripts) · projects/<slug>/*.md · profile/ · scheduled-tasks/ · prompts/ · claude-commands/ · README/CLAUDE.md.
import matter from 'gray-matter';

export type DocKind = 'memory' | 'session' | 'transcript' | 'session_log' | 'project_doc' | 'profile' | 'scheduled_task'
  | 'prompt' | 'command' | 'readme' | 'other';

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function classify(relPath: string): { kind: DocKind; project: string | null } {
  const parts = relPath.split('/');
  const file = parts[parts.length - 1];
  if (parts[0] === 'projects' && parts.length >= 3 && SLUG_RE.test(parts[1])) {
    const project = parts[1];
    if (parts.length === 3 && file === 'memory.md') return { kind: 'memory', project };
    if (parts[2] === 'sessions' && parts.length === 4) {
      if (file === 'LOG.md') return { kind: 'session_log', project };
      return { kind: /-code-/.test(file) ? 'transcript' : 'session', project };
    }
    return { kind: 'project_doc', project };
  }
  if (parts.length === 1) return { kind: /^(readme|claude)\.md$/i.test(file) ? 'readme' : 'other', project: null };
  const top: Record<string, DocKind> = { profile: 'profile', 'scheduled-tasks': 'scheduled_task', prompts: 'prompt', 'claude-commands': 'command' };
  return { kind: top[parts[0]] ?? 'other', project: null };
}

/** gray-matter turns YAML dates into Date objects: make everything JSON-safe (dates → YYYY-MM-DD / ISO strings). */
function jsonSafe(v: unknown): unknown {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().replace(/T00:00:00\.000Z$/, '');
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonSafe(x)]));
  return v;
}

export function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } {
  if (!raw.startsWith('---')) return { data: {}, body: raw };
  try {
    const m = matter(raw);
    return { data: (jsonSafe(m.data) as Record<string, unknown>) ?? {}, body: m.content.replace(/^\r?\n/, '') };
  } catch {
    return { data: {}, body: raw }; // broken YAML: index the whole file as text
  }
}

const DATE_RE = /^(\d{4}-\d{2}-\d{2})/;
const validDate = (s: string) => { const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s); };

/** frontmatter date/updated → leading YYYY-MM-DD of the file name → null. */
export function docDate(relPath: string, fm: Record<string, unknown>): string | null {
  for (const key of ['date', 'updated']) {
    const m = typeof fm[key] === 'string' ? DATE_RE.exec(fm[key] as string) : null;
    if (m && validDate(m[1])) return m[1];
  }
  const m = DATE_RE.exec(relPath.split('/').pop() ?? '');
  return m && validDate(m[1]) ? m[1] : null;
}

/** frontmatter title/name → first "# " heading → file name. */
export function docTitle(relPath: string, fm: Record<string, unknown>, body: string): string {
  for (const key of ['title', 'name']) if (typeof fm[key] === 'string' && (fm[key] as string).trim()) return (fm[key] as string).trim().slice(0, 200);
  const h = /^#\s+(.+)$/m.exec(body);
  if (h) return h[1].trim().slice(0, 200);
  return (relPath.split('/').pop() ?? relPath).replace(/\.md$/, '');
}
