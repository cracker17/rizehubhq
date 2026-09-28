// Quick syntax for /assign (docs/05 §1): "/assign !urgent @madam-muse due:fri Build a bundle page"
export interface ParsedRequest {
  text: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  clientSlug: string | null;
  dueDate: string | null; // YYYY-MM-DD
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function iso(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** `now` is the current time in the CEO's timezone (Asia/Manila); injectable for tests. */
export function parseAssign(input: string, now = new Date()): ParsedRequest {
  let priority: ParsedRequest['priority'] = 'normal';
  let clientSlug: string | null = null;
  let dueDate: string | null = null;
  const rest: string[] = [];
  for (const tok of input.trim().split(/\s+/)) {
    const t = tok.toLowerCase();
    if (/^!(urgent|high|low|normal)$/.test(t)) { priority = t.slice(1) as ParsedRequest['priority']; continue; }
    if (/^@[a-z0-9][a-z0-9-]*$/.test(t)) { clientSlug = t.slice(1); continue; }
    const due = t.match(/^due:(.+)$/);
    if (due) {
      const v = due[1];
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { dueDate = v; continue; }
      if (v === 'today' || v === 'tomorrow') { const d = new Date(now); if (v === 'tomorrow') d.setDate(d.getDate() + 1); dueDate = iso(d); continue; }
      const day = DAYS.findIndex((x) => v.startsWith(x));
      if (day >= 0) { const d = new Date(now); const diff = (day - d.getDay() + 7) % 7 || 7; d.setDate(d.getDate() + diff); dueDate = iso(d); continue; }
    }
    rest.push(tok);
  }
  return { text: rest.join(' '), priority, clientSlug, dueDate };
}
