// memory.md sections the brain understands (the layout the vault's CLAUDE.md prescribes):
//   ## Status · ## Links · ## Decisions log ("- YYYY-MM-DD: text") · ## Open next steps ("- text" / "- [x] text")
// Anything else stays plain text (still indexed and searchable as chunks).

export interface MemoryFacts {
  status: string | null;
  links: Array<{ label: string; value: string }>;
  decisions: Array<{ decided_on: string | null; text: string }>;
  next_steps: Array<{ text: string; done: boolean }>;
}

/** "## Heading" → lines under it (until the next ## or #). HTML comments are dropped. */
export function sections(body: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of body.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    const h = /^(#{1,2})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      current = h[1] === '##' ? [] : null;
      if (current) out.set(h[2].trim().toLowerCase(), current);
      continue;
    }
    current?.push(line);
  }
  return out;
}

/** Top-level "- " / "* " bullets; indented or wrapped lines join the bullet above. */
export function bullets(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const b = /^[-*]\s+(.*)$/.exec(line);
    if (b) out.push(b[1].trim());
    else if (out.length && /^\s+\S/.test(line)) out[out.length - 1] += ` ${line.trim()}`;
  }
  return out.filter(Boolean);
}

const find = (s: Map<string, string[]>, re: RegExp) => [...s.entries()].find(([k]) => re.test(k))?.[1] ?? [];

export function parseMemory(body: string): MemoryFacts {
  const s = sections(body);
  const status = bullets(find(s, /^status\b/)).slice(0, 3).join(' · ').slice(0, 400) || null;
  const links = bullets(find(s, /^links\b/)).map((b) => {
    const i = b.indexOf(':');
    return i > 0 && i < 60 ? { label: b.slice(0, i).trim(), value: b.slice(i + 1).trim() } : { label: '', value: b };
  });
  const decisions = bullets(find(s, /^decisions?\b/)).map((b) => {
    const m = /^(\d{4}-\d{2}-\d{2})\s*[:—–-]\s*(.+)$/.exec(b);
    return m ? { decided_on: m[1], text: m[2].trim() } : { decided_on: null, text: b };
  });
  const next_steps = bullets(find(s, /next steps/)).map((b) => {
    const m = /^\[( |x|X)\]\s*(.*)$/.exec(b);
    return m ? { text: m[2].trim(), done: m[1] !== ' ' } : { text: b, done: false };
  }).filter((n) => n.text);
  return { status, links, decisions, next_steps };
}
