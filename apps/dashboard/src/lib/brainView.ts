// HQ Brain UI (/brain, docs/16-BRAIN.md "UI"): the pure parts, shared by the server loaders and the client views, and
// covered by lib/brainView.test.ts. No React, no I/O.

// ---------- shapes (as the brain_* CEO functions return them) ----------
export interface BrainProject {
  slug: string; name: string; aliases: string[]; status: string | null; listed: boolean;
  doc_count: number; last_activity: string | null; sessions: number; open_next_steps: number;
}
export interface BrainEvent { id: number; ts: string; actor: string; action: string; project_slug: string | null; path: string | null; summary: string }
export interface BrainHealth {
  status: string; error: string | null; head_sha: string | null; embed_model: string | null;
  last_pull_at: string | null; last_index_at: string | null; last_webhook_at: string | null;
  projects: number; documents: number; chunks: number; embedded: number;
}
export interface BrainConnection {
  family_id: string; client_id: string | null; client_name: string | null; redirect_uris: string[] | null; subject: string;
  scopes: string[]; approved_at: string; last_used_at: string | null; expires_at: string;
}
export interface BrainDoc { path: string; title: string; kind?: string; doc_date: string | null; body?: string }
export interface BrainBundle {
  project: BrainProject & { links?: Array<{ label?: string; url?: string } | string> };
  memory: { path: string; title: string; doc_date: string | null; body: string } | null;
  sessions: Array<{ path: string; title: string; doc_date: string | null; body: string }>;
  decisions: Array<{ decided_on: string | null; text: string }>;
  next_steps: Array<{ text: string; done: boolean }>;
  documents: Array<{ path: string; title: string; kind: string; doc_date: string | null }>;
}
export interface BrainHit { path: string; title: string; kind: string; project: string | null; doc_date: string | null; heading: string | null; text: string; score: number }

// ---------- platform (node colour) ----------
export type Platform = 'shopify' | 'webflow' | 'wordpress' | 'custom';
export const PLATFORM_COLOR: Record<Platform, string> = {
  shopify: '#5eead4',   // teal
  webflow: '#60a5fa',   // blue
  wordpress: '#c4b5fd', // violet
  custom: '#fbbf24',    // amber
};
export const PLATFORM_LABEL: Record<Platform, string> = { shopify: 'Shopify', webflow: 'Webflow', wordpress: 'WordPress', custom: 'Custom app' };

/** Best guess from the name, aliases and status line (the index has no platform column). */
export function platformOf(p: Pick<BrainProject, 'name' | 'aliases' | 'status'>): Platform {
  const text = [p.name, ...(p.aliases ?? []), p.status ?? ''].join(' ').toLowerCase();
  if (/shopify|horizon|myshopify/.test(text)) return 'shopify';
  if (/webflow/.test(text)) return 'webflow';
  if (/wordpress|woocommerce|\bwp\b|elementor/.test(text)) return 'wordpress';
  return 'custom';
}

// ---------- time ----------
export function daysSince(iso: string | null, now = Date.now()): number | null {
  if (!iso) return null;
  if (iso.length === 10) {
    // A calendar date (Manila): whole days between it and today, so "today" is 0.
    const today = new Date(now).toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
    const d = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${iso}T00:00:00Z`)) / 86400_000;
    return Number.isFinite(d) ? Math.max(0, d) : null;
  }
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? Math.max(0, (now - t) / 86400_000) : null;
}

export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(s)) return 'never';
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? 'yesterday' : d < 60 ? `${d} days ago` : `${Math.round(d / 30)} months ago`;
}

/** A calendar date (YYYY-MM-DD, Manila) in words: today, yesterday, 3 days ago. */
export function dayAgo(date: string | null, now = Date.now()): string {
  const d = daysSince(date, now);
  if (d === null) return 'never';
  const n = Math.round(d);
  return n === 0 ? 'today' : n === 1 ? 'yesterday' : n < 60 ? `${n} days ago` : `${Math.round(n / 30)} months ago`;
}

/** 1 = touched today, fading to 0.15 after ~60 days. */
export function recency(lastActivity: string | null, now = Date.now()): number {
  const d = daysSince(lastActivity, now);
  if (d === null) return 0.15;
  return Math.max(0.15, Math.min(1, 1 - Math.log10(1 + d) / Math.log10(61)));
}

// ---------- core layout ----------
export interface CoreNode { slug: string; name: string; color: string; size: number; glow: number; orbit: number; tilt: number; phase: number; speed: number }

/** Deterministic 0..1 from a string (stable node placement across reloads). */
export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

/** Orbiting project nodes: size = memory volume, glow = recent activity, colour = platform. */
export function coreNodes(projects: BrainProject[], now = Date.now()): CoreNode[] {
  const listed = projects.filter((p) => p.listed);
  const maxDocs = Math.max(1, ...listed.map((p) => p.doc_count));
  return listed.map((p, i) => {
    const h = hash01(p.slug);
    return {
      slug: p.slug, name: p.name, color: PLATFORM_COLOR[platformOf(p)],
      size: 3 + 6 * Math.sqrt(p.doc_count / maxDocs),
      glow: recency(p.last_activity, now),
      orbit: 1.45 + 0.55 * ((i % 3) / 2) + 0.12 * h,     // three loose rings outside the sphere (radius 1)
      tilt: (h - 0.5) * 1.1,
      phase: (i / Math.max(1, listed.length)) * Math.PI * 2 + h,
      speed: 0.035 + 0.03 * h,
    };
  });
}

/** Evenly spread points on a unit sphere (Fibonacci lattice). */
export function spherePoints(n: number): Array<[number, number, number]> {
  const pts: Array<[number, number, number]> = [];
  const g = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / Math.max(1, n - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    pts.push([Math.cos(g * i) * r, y, Math.sin(g * i) * r]);
  }
  return pts;
}

// ---------- activity ----------
export type Source = 'pc' | 'claude' | 'agent' | 'julev' | 'service';

export function sourceOf(actor: string): Source {
  if (actor.startsWith('claude:')) return 'claude';
  if (actor.startsWith('agent:')) return 'agent';
  if (actor === 'julev') return 'julev';
  if (actor.startsWith('github')) return 'pc';
  return 'service';
}

export const SOURCE_LABEL: Record<Source, string> = { pc: 'PC sync', claude: 'Claude', agent: 'Agent', julev: 'You', service: 'Brain' };

/** One human line per event. Tool-call audit rows are left out of the feed (isFeedEvent). */
export function describeEvent(e: BrainEvent): string {
  const who = e.actor.startsWith('claude:') ? e.actor.slice(7) : e.actor.startsWith('github:') ? `${e.actor.slice(7)} (PC)` : e.actor === 'julev' ? 'You' : e.actor;
  switch (e.action) {
    case 'saved': return `${who}: ${e.summary}`;
    case 'pulled': return `Vault synced ${e.summary}`;
    case 'indexed': return `Indexed ${e.summary}`;
    case 'doc_added': return `New file ${e.path ?? ''}`.trim();
    case 'doc_changed': return `Updated ${e.path ?? ''}`.trim();
    case 'doc_removed': return `Removed ${e.path ?? ''}`.trim();
    case 'blocked_secret': return `Kept out (looks like a secret): ${e.path ?? ''}`.trim();
    case 'blocked_size': return `Skipped, too big to index: ${e.path ?? ''}${/\((.+)\)/.exec(e.summary)?.[1] ? ` (${/\((.+)\)/.exec(e.summary)![1]})` : ''}`.trim();
    case 'tool_call': return `${who} used ${e.summary.replace(/^brain_/, '').replace(/_/g, ' ')}`;
    case 'connected': return `Connected: ${e.summary.replace(/^approved /, '')}`;
    case 'revoked': return 'Connector access revoked';
    case 'error': return `Sync error: ${e.summary}`;
    default: return `${who} · ${e.action}${e.summary ? `: ${e.summary}` : ''}`;
  }
}

export const isFeedEvent = (e: BrainEvent) => e.action !== 'tool_call';

/**
 * The activity feed: no tool-call audit rows, and the "kept out" / "too big" notices (re-logged on every index run)
 * only once per file. Newest first.
 */
export function feedEvents(events: BrainEvent[], max = 60): BrainEvent[] {
  const seen = new Set<string>();
  const out: BrainEvent[] = [];
  for (const e of [...events].sort((a, b) => b.id - a.id)) {
    if (!isFeedEvent(e)) continue;
    if (e.action === 'blocked_secret' || e.action === 'blocked_size') {
      const k = `${e.action}:${e.path}`;
      if (seen.has(k)) continue;
      seen.add(k);
    }
    out.push(e);
    if (out.length >= max) break;
  }
  return out;
}

/** Events that should pulse a project node. */
export const pulses = (e: BrainEvent) => !!e.project_slug && ['saved', 'doc_added', 'doc_changed', 'connected'].includes(e.action);

// ---------- markdown (safe subset, rendered as React elements: no HTML is ever injected) ----------
export type Inline = { t: 'text' | 'bold' | 'code' | 'em'; v: string } | { t: 'link'; v: string; href: string };
export type Block =
  | { t: 'h'; level: 1 | 2 | 3 | 4; text: Inline[] }
  | { t: 'p'; text: Inline[] }
  | { t: 'list'; items: Array<{ text: Inline[]; checked: boolean | null; depth: number }> }
  | { t: 'code'; v: string }
  | { t: 'quote'; text: Inline[] }
  | { t: 'table'; rows: Inline[][][] }
  | { t: 'hr' };

export function stripFrontmatter(md: string): string {
  return md.replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n?/, '');
}

const SAFE_HREF = /^(https?:\/\/|mailto:)/i;

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s)<>\]]+)|(\*[^*\s][^*]*\*)/g;
  let last = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > last) out.push({ t: 'text', v: s.slice(last, m.index) });
    const x = m[0];
    if (m[1]) out.push({ t: 'code', v: x.slice(1, -1) });
    else if (m[2]) out.push({ t: 'bold', v: x.slice(2, -2) });
    else if (m[3]) {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(x)!;
      if (SAFE_HREF.test(lm[2]!)) out.push({ t: 'link', v: lm[1]!, href: lm[2]! });
      else out.push({ t: 'text', v: lm[1]! });
    } else if (m[4]) {
      const url = x.replace(/[.,;:!?]+$/, '');
      out.push({ t: 'link', v: url, href: url });
      if (url.length < x.length) out.push({ t: 'text', v: x.slice(url.length) });
    } else out.push({ t: 'em', v: x.slice(1, -1) });
    last = m.index + x.length;
  }
  if (last < s.length) out.push({ t: 'text', v: s.slice(last) });
  return out;
}

export function parseMarkdown(md: string): Block[] {
  const lines = stripFrontmatter(md).split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { blocks.push({ t: 'p', text: parseInline(para.join(' ')) }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) code.push(lines[i]!);
      blocks.push({ t: 'code', v: code.join('\n') });
      continue;
    }
    if (/^\s*<!--.*-->\s*$/.test(line)) continue;
    const h = /^(#{1,4})\s+(.+?)\s*#*$/.exec(line);
    if (h) { flush(); blocks.push({ t: 'h', level: h[1]!.length as 1 | 2 | 3 | 4, text: parseInline(h[2]!) }); continue; }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) { flush(); blocks.push({ t: 'hr' }); continue; }
    const li = /^(\s*)[-*+]\s+(\[( |x|X)\]\s+)?(.*)$/.exec(line) ?? /^(\s*)\d+[.)]\s+()()(.*)$/.exec(line);
    if (li) {
      flush();
      const item = { text: parseInline(li[4]!), checked: li[2] ? li[3] !== ' ' : null, depth: Math.min(3, Math.floor(li[1]!.replace(/\t/g, '  ').length / 2)) };
      const prev = blocks[blocks.length - 1];
      if (prev?.t === 'list') prev.items.push(item); else blocks.push({ t: 'list', items: [item] });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flush();
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // the |---|---| separator
      const prev = blocks[blocks.length - 1];
      const row = cells.map(parseInline);
      if (prev?.t === 'table') prev.rows.push(row); else blocks.push({ t: 'table', rows: [row] });
      continue;
    }
    const q = /^>\s?(.*)$/.exec(line);
    if (q) { flush(); blocks.push({ t: 'quote', text: parseInline(q[1]!) }); continue; }
    if (!line.trim()) { flush(); continue; }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

// ---------- next steps editing ----------
/** Checklist → the lines brain /write/memory `next_steps` expects ("[x] text" for done items). */
export function nextStepLines(steps: Array<{ text: string; done: boolean }>): string[] {
  return steps.map((s) => s.text.replace(/\s+/g, ' ').trim()).map((t, i) => (steps[i]!.done ? `[x] ${t}` : t)).filter((t) => t && t !== '[x]');
}

/** Slug preview for the New Project wizard (same rule as the brain's slugify). */
export function slugPreview(name: string): string {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}

/** Alias suggestions from the name and links: name, domains, brand words (no generic words on their own). */
const GENERIC = new Set(['website', 'site', 'shopify', 'webflow', 'wordpress', 'app', 'the', 'and', 'project', 'store', 'theme', 'new', 'redesign']);
export function suggestAliases(name: string, links: string[] = []): string[] {
  const out = new Set<string>();
  const n = name.trim().toLowerCase();
  if (n) out.add(n);
  for (const l of links) {
    const m = /https?:\/\/(?:www\.)?([a-z0-9.-]+\.[a-z]{2,})/i.exec(l);
    if (m) out.add(m[1]!.toLowerCase());
  }
  const words = n.split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !GENERIC.has(w));
  if (words.length > 1) out.add(words.join(' '));
  for (const w of words) if (w.length >= 5) out.add(w);
  return [...out].slice(0, 8);
}
