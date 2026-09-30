// Section edits on the vault's memory.md files, the same shape /save keeps them in (claude-commands/save.md):
// frontmatter with `updated:`, "## <Section>" headings, bullet lists. Pure string functions (no I/O).

const norm = (s: string) => s.replace(/\r\n/g, '\n');
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

interface Section { name: string; start: number; bodyStart: number; end: number }

/** "## Name" sections of a document (line indexes; end is exclusive). */
function sections(lines: string[]): Section[] {
  const out: Section[] = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^```/.test(l)) fence = !fence;
    const m = !fence && /^##\s+(.+?)\s*#*\s*$/.exec(l);
    if (m) {
      if (out.length) out[out.length - 1]!.end = i;
      out.push({ name: m[1]!, start: i, bodyStart: i + 1, end: lines.length });
    }
  });
  return out;
}

const bullet = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return /^[-*] /.test(t) ? `- ${t.slice(2).trim()}` : `- ${t}`;
};
const isPlaceholder = (l: string) => /^[-*]\s*$/.test(l.trim()) || /^<!--.*-->$/.test(l.trim()) || /^[-*] [^:]{1,40}:\s*$/.test(l.trim());

/** Replace a section's body with bullets (created before "## Decisions log", or at the end, when missing). */
export function setSection(md: string, name: string, items: string[]): string {
  const lines = norm(md).split('\n');
  const body = [...items.map(bullet), ''];
  const s = sections(lines).find((x) => same(x.name, name));
  if (s) {
    lines.splice(s.bodyStart, s.end - s.bodyStart, ...body);
    return lines.join('\n');
  }
  return insertSection(lines, name, body);
}

/**
 * Add bullets to a section, skipping lines it already has (case-insensitive) and dropping template placeholders
 * ("-", "- Site:", "<!-- … -->"). Creates the section when missing.
 */
export function appendToSection(md: string, name: string, items: string[]): { md: string; added: number } {
  const lines = norm(md).split('\n');
  const s = sections(lines).find((x) => same(x.name, name));
  if (!s) {
    const fresh = [...new Set(items.map(bullet))];
    return { md: insertSection(lines, name, [...fresh, '']), added: fresh.length };
  }
  const existing = lines.slice(s.bodyStart, s.end);
  const kept = existing.filter((l) => !isPlaceholder(l) || /:\s*\S/.test(l));
  const have = kept.map((l) => l.trim());
  const add = [...new Set(items.map(bullet))].filter((b) => !have.some((h) => same(h, b)));
  while (kept.length && !kept[kept.length - 1]!.trim()) kept.pop();
  lines.splice(s.bodyStart, s.end - s.bodyStart, ...kept, ...add, '');
  return { md: lines.join('\n'), added: add.length };
}

function insertSection(lines: string[], name: string, body: string[]): string {
  const all = sections(lines);
  const before = all.find((x) => same(x.name, 'Decisions log')) ?? all.find((x) => same(x.name, 'Open next steps'));
  const at = before ? before.start : lines.length;
  if (!before && lines.length && lines[lines.length - 1]!.trim()) lines.push('');
  lines.splice(at, 0, `## ${name}`, ...body);
  return lines.join('\n');
}

/** Set (or add) a frontmatter key. Adds a frontmatter block when the file has none. */
export function setFrontmatter(md: string, key: string, value: string): string {
  const text = norm(md);
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return `---\n${key}: ${value}\n---\n${text}`;
  const fm = m[1]!.split('\n');
  const i = fm.findIndex((l) => l.startsWith(`${key}:`));
  if (i >= 0) fm[i] = `${key}: ${value}`; else fm.push(`${key}: ${value}`);
  return `---\n${fm.join('\n')}\n---\n${text.slice(m[0].length)}`;
}

/** The body of one section as trimmed lines (no heading). */
export function readSection(md: string, name: string): string[] {
  const lines = norm(md).split('\n');
  const s = sections(lines).find((x) => same(x.name, name));
  return s ? lines.slice(s.bodyStart, s.end).map((l) => l.trim()).filter(Boolean) : [];
}

/** ASCII slug, words joined by "-", max `max` chars (the /new-project rule). */
export function slugify(s: string, max = 40): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
}

/** One line of free text, no control characters, capped. */
export const oneLine = (s: string, max = 300) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
