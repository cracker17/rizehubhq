// Heading-aware chunking: each chunk carries its heading path ("Title › Section › Sub") and stays under MAX chars,
// splitting on blank lines / bullets first and hard-wrapping only oversized paragraphs. Neighbouring pieces of one
// section overlap by OVERLAP chars so a fact that straddles a cut is still found.
import { createHash } from 'node:crypto';

export const MAX_CHARS = 1200;
export const OVERLAP = 150;

export interface Chunk { heading: string; text: string; text_sha: string }

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** What gets embedded (and hashed): title and heading give a short chunk its context. */
export const embedInput = (title: string, heading: string, text: string) => [title, heading, text].filter(Boolean).join('\n');

function pieces(text: string): string[] {
  // blocks = paragraphs; a bullet list splits per bullet so a cut never lands mid-bullet
  const blocks = text.split(/\n\s*\n/).flatMap((b) => (/^\s*[-*]\s/m.test(b) ? b.split(/\n(?=\s*[-*]\s)/) : [b]));
  return blocks.map((b) => b.trim()).filter(Boolean).flatMap((b) => {
    if (b.length <= MAX_CHARS) return [b];
    const out: string[] = [];
    for (let i = 0; i < b.length; i += MAX_CHARS - OVERLAP) out.push(b.slice(i, i + MAX_CHARS));
    return out;
  });
}

function pack(parts: string[]): string[] {
  const out: string[] = [];
  let cur = '';
  for (const p of parts) {
    if (!cur) { cur = p; continue; }
    if (cur.length + 2 + p.length <= MAX_CHARS) { cur += `\n\n${p}`; continue; }
    out.push(cur);
    const tail = cur.slice(-OVERLAP);
    const cut = tail.search(/\s/); // start the overlap at a word boundary
    const lead = cut >= 0 ? tail.slice(cut + 1) : '';
    cur = lead && lead.length + 2 + p.length <= MAX_CHARS ? `…${lead}\n\n${p}` : p;
  }
  if (cur) out.push(cur);
  return out;
}

export function chunkMarkdown(title: string, body: string): Chunk[] {
  const stack: string[] = [];
  const sections: Array<{ heading: string; lines: string[] }> = [{ heading: '', lines: [] }];
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const h = inFence ? null : /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      stack.length = h[1].length - 1;
      stack[h[1].length - 1] = h[2].trim();
      sections.push({ heading: stack.filter(Boolean).join(' › '), lines: [] });
      continue;
    }
    sections[sections.length - 1].lines.push(line);
  }
  const chunks: Chunk[] = [];
  for (const s of sections) {
    const text = s.lines.join('\n').trim();
    if (!text) continue;
    for (const t of pack(pieces(text))) chunks.push({ heading: s.heading, text: t, text_sha: sha256(embedInput(title, s.heading, t)) });
  }
  return chunks;
}
