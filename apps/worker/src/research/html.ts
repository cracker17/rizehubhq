// Dependency-free HTML → readable text, SEO facts and link extraction. Regex-based on purpose:
// good enough for articles/landing pages, never executes anything, bounded work per input.

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®',
  trade: '™', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', laquo: '«', raquo: '»', bull: '•', middot: '·', euro: '€',
  pound: '£', yen: '¥', cent: '¢', deg: '°', times: '×', divide: '÷', eacute: 'é', ntilde: 'ñ', uuml: 'ü', ouml: 'ö', auml: 'ä',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : null;
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function absolutize(href: string, base: string): string | null {
  try { return new URL(href, base).toString(); } catch { return null; }
}

const DROP_BLOCKS = ['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'canvas', 'object', 'nav', 'head'];

/** Removes non-content blocks (and comments) before text conversion. */
function dropNoise(html: string, dropChrome: boolean): string {
  let h = html.replace(/<!--[\s\S]*?-->/g, ' ');
  const blocks = dropChrome ? [...DROP_BLOCKS, 'footer', 'form', 'aside'] : DROP_BLOCKS;
  for (const t of blocks) h = h.replace(new RegExp(`<${t}\\b[\\s\\S]*?</${t}\\s*>`, 'gi'), ' ');
  h = h.replace(/<(script|style|noscript)\b[^>]*\/?>/gi, ' ');
  return h;
}

/** Readable text: headings as markdown #, links as [text](absolute url), list items as "- ", paragraphs separated. */
export function htmlToText(html: string, baseUrl: string, opts: { dropChrome?: boolean } = {}): string {
  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i);
  let h = dropNoise(bodyMatch ? bodyMatch[1]! : html, opts.dropChrome ?? false);
  const main = h.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (main && stripTags(main[1]!).length > 200) h = main[1]!;

  h = h.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_m, lvl: string, inner: string) => `\n\n${'#'.repeat(Number(lvl))} ${stripTags(inner)}\n\n`);
  h = h.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_m, attrs: string, inner: string) => {
    const text = stripTags(inner);
    const href = attr(` ${attrs}`, 'href');
    const abs = href && !/^(javascript|data|vbscript):/i.test(href.trim()) ? absolutize(href, baseUrl) : null;
    if (!abs) return ` ${text} `;
    if (!text) return ' ';
    return ` [${text}](${abs}) `;
  });
  h = h.replace(/<img\b([^>]*)>/gi, (_m, attrs: string) => {
    const alt = attr(` ${attrs}`, 'alt');
    return alt ? ` [image: ${alt}] ` : ' ';
  });
  h = h.replace(/<li\b[^>]*>/gi, '\n- ');
  h = h.replace(/<br\s*\/?>/gi, '\n');
  h = h.replace(/<\/(p|div|section|article|ul|ol|table|tr|blockquote|pre|header|footer|dl|figure)\s*>/gi, '\n\n');
  h = h.replace(/<(p|div|section|article|tr|blockquote|pre|header|footer|dt|dd|figure)\b[^>]*>/gi, '\n');
  h = h.replace(/<\/t[dh]\s*>/gi, ' | ');
  h = decodeEntities(h.replace(/<[^>]*>/g, ' '));
  return h
    .split('\n')
    .map((l) => l.replace(/[ \t\f\v ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface SeoFacts {
  title: string | null;
  meta_description: string | null;
  h1s: string[];
  canonical: string | null;
  robots: string | null;
  x_robots_tag: string | null;
  lang: string | null;
  og_title: string | null;
  og_image: string | null;
  h2_count: number;
  images_missing_alt: number;
  word_count: number;
}

function metaContent(html: string, key: 'name' | 'property', value: string): string | null {
  const re = /<meta\b[^>]*>/gi;
  for (const m of html.matchAll(re)) {
    const tag = m[0];
    if ((attr(tag, key) ?? '').toLowerCase() === value) return attr(tag, 'content');
  }
  return null;
}

export function seoFacts(html: string, baseUrl: string, headers?: Headers): SeoFacts {
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  let canonical: string | null = null;
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    if ((attr(m[0], 'rel') ?? '').toLowerCase().split(/\s+/).includes('canonical')) {
      const href = attr(m[0], 'href');
      canonical = href ? absolutize(href, baseUrl) : null;
      break;
    }
  }
  const noScript = dropNoise(html, false);
  const h1s = [...noScript.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/gi)].map((m) => stripTags(m[1]!)).filter(Boolean);
  const imgs = [...noScript.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const text = htmlToText(html, baseUrl);
  const lang = html.match(/<html\b[^>]*>/i);
  return {
    title: title ? stripTags(title[1]!) : null,
    meta_description: metaContent(html, 'name', 'description'),
    h1s,
    canonical,
    robots: metaContent(html, 'name', 'robots'),
    x_robots_tag: headers?.get('x-robots-tag') ?? null,
    lang: lang ? attr(lang[0], 'lang') : null,
    og_title: metaContent(html, 'property', 'og:title'),
    og_image: metaContent(html, 'property', 'og:image'),
    h2_count: [...noScript.matchAll(/<h2\b/gi)].length,
    images_missing_alt: imgs.filter((t) => attr(t, 'alt') === null).length,
    word_count: text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length,
  };
}

export interface PageLink { url: string; text: string }

/** All http(s) <a href> targets (absolute, fragment stripped) with their anchor text. */
export function extractLinks(html: string, baseUrl: string): PageLink[] {
  const out: PageLink[] = [];
  // Nav/footer links are kept (they break too); only comments and script/style/template bodies are dropped.
  const src = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  for (const m of src.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const href = attr(` ${m[1]}`, 'href');
    if (!href || /^(javascript|mailto|tel|data|sms|#)/i.test(href.trim())) continue;
    const abs = absolutize(href.trim(), baseUrl);
    if (!abs || !/^https?:/i.test(abs)) continue;
    const u = new URL(abs);
    u.hash = '';
    const img = m[2]!.match(/<img\b[^>]*>/i);
    const text = stripTags(m[2]!) || (img ? `[image: ${attr(img[0], 'alt') ?? 'no alt'}]` : attr(` ${m[1]}`, 'aria-label') ?? '');
    out.push({ url: u.toString(), text: text.slice(0, 120) });
  }
  return out;
}
