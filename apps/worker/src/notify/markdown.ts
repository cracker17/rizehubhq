// A small, safe Markdown → HTML renderer for the CEO's emails (notify/ceoEmail.ts). Agent output is untrusted text:
// EVERYTHING is escaped first, and only the tags written here are ever produced (headings, paragraphs, lists, quotes,
// code, tables, rules, bold/italic/strike, links). Links keep only http(s) and mailto URLs; anything else (javascript:,
// data:, relative paths) is shown as plain text. No raw HTML from the input ever passes through. Styles are inline
// because mail clients drop <style> blocks.

export function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** An absolute http(s) or mailto URL, normalized; null for anything else. */
export function safeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 2000 || /[\s<>"'`]/.test(s)) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'mailto:') return null;
    if (u.protocol !== 'mailto:' && !u.hostname) return null;
    return u.href;
  } catch {
    return null;
  }
}

export const S = {
  a: 'color:#2f54eb;text-decoration:underline;word-break:break-word;',
  code: 'font-family:Consolas,Menlo,monospace;font-size:13px;background:#f1f3f6;border-radius:4px;padding:1px 4px;',
  pre: 'font-family:Consolas,Menlo,monospace;font-size:13px;line-height:1.5;background:#f1f3f6;border-radius:8px;padding:12px;margin:0 0 14px;white-space:pre-wrap;word-break:break-word;',
  p: 'margin:0 0 14px;line-height:1.6;',
  h: ['font-size:20px;margin:18px 0 10px;', 'font-size:18px;margin:18px 0 10px;', 'font-size:16px;margin:16px 0 8px;', 'font-size:15px;margin:14px 0 8px;'],
  list: 'margin:0 0 14px;padding-left:22px;line-height:1.6;',
  li: 'margin:0 0 4px;',
  quote: 'margin:0 0 14px;padding:4px 0 4px 12px;border-left:3px solid #d0d5dd;color:#475467;',
  hr: 'border:0;border-top:1px solid #e4e7ec;margin:18px 0;',
  table: 'border-collapse:collapse;margin:0 0 14px;font-size:14px;',
  th: 'border:1px solid #d0d5dd;padding:6px 8px;background:#f8f9fb;text-align:left;vertical-align:top;',
  td: 'border:1px solid #e4e7ec;padding:6px 8px;text-align:left;vertical-align:top;',
} as const;

/** Bold / italic / strike on already-escaped text (the markers themselves are plain characters). */
function emphasis(escaped: string): string {
  return escaped
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+?)__/g, '<strong>$1</strong>')
    .replace(/~~([^~\n]+?)~~/g, '<s>$1</s>')
    .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\s][^_\n]*?)_(?![_\w])/g, '$1<em>$2</em>');
}

const TRAILING = /[.,;:!?]+$/;

/** One line of inline Markdown → HTML. */
export function inline(src: string): string {
  const out: string[] = [];
  const re = /`([^`\n]+)`|\[([^\]\n]{1,500})\]\(([^()\s]{1,2000})\)|<?((?:https?:\/\/|mailto:)[^\s<>()"'`]{1,2000})>?/g;
  let last = 0;
  for (const m of src.matchAll(re)) {
    const at = m.index ?? 0;
    out.push(emphasis(esc(src.slice(last, at))));
    if (m[1] !== undefined) {
      out.push(`<code style="${S.code}">${esc(m[1])}</code>`);
    } else if (m[2] !== undefined) {
      const href = safeUrl(m[3]);
      out.push(href ? `<a href="${esc(href)}" style="${S.a}">${emphasis(esc(m[2]))}</a>` : `${emphasis(esc(m[2]))} (${esc(m[3])})`);
    } else {
      // Bare or <angle-bracketed> URL: trailing sentence punctuation stays outside the link; an unpaired bracket stays text.
      const open = m[0].startsWith('<');
      const close = m[0].endsWith('>');
      const trail = TRAILING.exec(m[4])?.[0] ?? '';
      const raw = m[4].slice(0, m[4].length - trail.length);
      const href = safeUrl(raw);
      const before = open && !close ? '&lt;' : '';
      const after = `${esc(trail)}${close && !open ? '&gt;' : ''}`;
      out.push(href ? `${before}<a href="${esc(href)}" style="${S.a}">${esc(raw)}</a>${after}` : esc(m[0]));
    }
    last = at + m[0].length;
  }
  out.push(emphasis(esc(src.slice(last))));
  return out.join('');
}

const isRule = (l: string) => /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l);
const heading = (l: string) => /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
const bullet = (l: string) => /^\s*[-*+]\s+(.*)$/.exec(l);
const ordered = (l: string) => /^\s*(\d{1,9})[.)]\s+(.*)$/.exec(l);
const fence = (l: string) => /^\s{0,3}(```|~~~)/.exec(l);
const isTableSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l) && l.includes('-');
const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

/** Block-level Markdown → HTML (escaped, inline-styled). */
export function markdownToHtml(md: string): string {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const f = fence(line);
    if (f) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(f[1])) body.push(lines[i++]);
      i++; // closing fence (or end of input)
      html.push(`<pre style="${S.pre}"><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    if (isRule(line)) { html.push(`<hr style="${S.hr}">`); i++; continue; }
    const h = heading(line);
    if (h) {
      const level = Math.min(h[1].length, 4);
      html.push(`<h${level + 1} style="${S.h[level - 1]}">${inline(h[2])}</h${level + 1}>`);
      i++;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      html.push(`<table role="presentation" style="${S.table}"><tr>${head.map((c) => `<th style="${S.th}">${inline(c)}</th>`).join('')}</tr>`
        + rows.map((r) => `<tr>${head.map((_, k) => `<td style="${S.td}">${inline(r[k] ?? '')}</td>`).join('')}</tr>`).join('')
        + '</table>');
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) body.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      html.push(`<blockquote style="${S.quote}">${markdownToHtml(body.join('\n'))}</blockquote>`);
      continue;
    }
    if (bullet(line) || ordered(line)) {
      const isOl = !bullet(line);
      const items: string[] = [];
      while (i < lines.length) {
        const m = isOl ? ordered(lines[i]) : bullet(lines[i]);
        if (m) { items.push(inline(isOl ? m[2] : m[1])); i++; continue; }
        // A wrapped item: an indented line that is not a new block continues the previous item.
        if (items.length && /^\s{2,}\S/.test(lines[i]) && !bullet(lines[i]) && !ordered(lines[i])) { items[items.length - 1] += `<br>${inline(lines[i].trim())}`; i++; continue; }
        break;
      }
      const tag = isOl ? 'ol' : 'ul';
      html.push(`<${tag} style="${S.list}">${items.map((x) => `<li style="${S.li}">${x}</li>`).join('')}</${tag}>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !fence(lines[i]) && !heading(lines[i]) && !isRule(lines[i]) && !bullet(lines[i]) && !ordered(lines[i])
      && !/^\s{0,3}>/.test(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))) {
      para.push(inline(lines[i].trim()));
      i++;
    }
    if (!para.length) { html.push(`<p style="${S.p}">${inline(lines[i].trim())}</p>`); i++; continue; }
    html.push(`<p style="${S.p}">${para.join('<br>')}</p>`);
  }
  return html.join('\n');
}
