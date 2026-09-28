// Keyed third-party connectors: Semrush (Analytics API v3), Figma (REST v1), a generic HTTP media provider,
// and the Google Workspace interface. Each returns a clear "not connected" message when its env is unset.
import type { ApiFetch } from './search';
import { wrapUntrusted } from './fetch';

type Env = Record<string, string | undefined>;

// ---------- Semrush ----------
export const SEMRUSH_NOT_CONNECTED = 'semrush is not connected: set SEMRUSH_API_KEY on the worker (Semrush API units are paid). '
  + 'Until then, do not invent keyword volumes or difficulty; mark them [PLACEHOLDER: semrush data] or ask_ceo.';

export type SemrushReport = 'keyword_overview' | 'related_keywords' | 'domain_organic';
const SEMRUSH_TYPES: Record<SemrushReport, { type: string; param: 'phrase' | 'domain'; columns: string }> = {
  keyword_overview: { type: 'phrase_this', param: 'phrase', columns: 'Ph,Nq,Cp,Co,Kd,Nr' },
  related_keywords: { type: 'phrase_related', param: 'phrase', columns: 'Ph,Nq,Cp,Co,Kd,Rr' },
  domain_organic: { type: 'domain_organic', param: 'domain', columns: 'Ph,Po,Nq,Cp,Kd,Ur,Tr' },
};

export function parseSemrushCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const head = lines[0]!.split(';').map((h) => h.trim());
  return lines.slice(1).map((l) => Object.fromEntries(l.split(';').map((v, i) => [head[i] ?? `col${i}`, v.trim()])));
}

export async function semrushQuery(report: SemrushReport, target: string, database: string, limit: number, env: Env, f: ApiFetch): Promise<string> {
  const key = env.SEMRUSH_API_KEY;
  if (!key) return SEMRUSH_NOT_CONNECTED;
  const spec = SEMRUSH_TYPES[report];
  const u = new URL('https://api.semrush.com/');
  u.searchParams.set('type', spec.type);
  u.searchParams.set('key', key);
  u.searchParams.set(spec.param, target);
  u.searchParams.set('database', database);
  u.searchParams.set('export_columns', spec.columns);
  if (report !== 'keyword_overview') u.searchParams.set('display_limit', String(limit));
  const res = await f(u, { signal: AbortSignal.timeout(30_000) });
  const text = (await res.text()).replaceAll(key, '[REDACTED]');
  if (!res.ok) return `Semrush HTTP ${res.status}: ${text.slice(0, 300)}`;
  if (/^ERROR\s+\d+/i.test(text.trim())) {
    return /NOTHING FOUND/i.test(text) ? `Semrush: no data for "${target}" in database ${database}.` : `Semrush error: ${text.trim().slice(0, 300)}`;
  }
  const rows = parseSemrushCsv(text).slice(0, limit);
  return `Semrush ${report} for "${target}" (${database}), ${rows.length} row(s):\n${JSON.stringify(rows, null, 1).slice(0, 12_000)}`;
}

// ---------- Figma ----------
export const FIGMA_NOT_CONNECTED = 'figma_read is not connected: set FIGMA_TOKEN (a personal access token with file read scope) on the worker, '
  + 'or ask the CEO to export the frames as images into the task workspace.';

export function parseFigmaRef(ref: string): { fileKey: string; nodeId: string | null } | null {
  const m = ref.match(/figma\.com\/(?:file|design|proto|board)\/([A-Za-z0-9]+)(?:\/branch\/([A-Za-z0-9]+))?/);
  if (m) {
    const node = ref.match(/[?&]node-id=([^&#]+)/);
    return { fileKey: m[2] ?? m[1]!, nodeId: node ? decodeURIComponent(node[1]!).replace(/-/g, ':') : null };
  }
  if (/^[A-Za-z0-9]{10,64}$/.test(ref.trim())) return { fileKey: ref.trim(), nodeId: null };
  return null;
}

interface FigmaNode {
  id?: string; name?: string; type?: string; characters?: string; children?: FigmaNode[];
  absoluteBoundingBox?: { width?: number; height?: number };
  style?: { fontFamily?: string; fontSize?: number; fontWeight?: number; lineHeightPx?: number };
  fills?: { type?: string; color?: { r: number; g: number; b: number; a?: number } }[];
}

const hex = (c: { r: number; g: number; b: number }) => `#${[c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;

export function outlineFigma(n: FigmaNode, depth = 0, maxDepth = 4, out: string[] = [], budget = { left: 400 }): string[] {
  if (budget.left-- <= 0) return out;
  const box = n.absoluteBoundingBox ? ` ${Math.round(n.absoluteBoundingBox.width ?? 0)}×${Math.round(n.absoluteBoundingBox.height ?? 0)}` : '';
  const fill = n.fills?.find((f) => f.type === 'SOLID' && f.color);
  const bits = [`${'  '.repeat(depth)}- ${n.type ?? '?'} "${n.name ?? ''}" (${n.id ?? ''})${box}`];
  if (fill?.color) bits.push(`fill ${hex(fill.color)}`);
  if (n.style?.fontFamily) bits.push(`font ${n.style.fontFamily} ${n.style.fontSize ?? ''}px/${n.style.fontWeight ?? ''}`);
  if (n.characters) bits.push(`text "${n.characters.replace(/\s+/g, ' ').slice(0, 160)}"`);
  out.push(bits.join(' · '));
  if (depth < maxDepth) for (const c of n.children ?? []) outlineFigma(c, depth + 1, maxDepth, out, budget);
  return out;
}

export async function figmaRead(ref: string, nodeIds: string[], exportImages: boolean, env: Env, f: ApiFetch): Promise<string> {
  const token = env.FIGMA_TOKEN;
  if (!token) return FIGMA_NOT_CONNECTED;
  const p = parseFigmaRef(ref);
  if (!p) return 'Could not read a Figma file key from that reference. Pass a figma.com/design/... URL or the file key.';
  const ids = [...new Set([...nodeIds, ...(p.nodeId ? [p.nodeId] : [])])].slice(0, 20);
  const headers = { 'x-figma-token': token };
  const get = async (path: string) => {
    const res = await f(`https://api.figma.com/v1/${path}`, { headers, signal: AbortSignal.timeout(30_000) });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(`Figma HTTP ${res.status}: ${String(j.err ?? j.message ?? '').slice(0, 200)}`);
    return j;
  };
  try {
    const parts: string[] = [];
    if (ids.length) {
      const j = await get(`files/${p.fileKey}/nodes?ids=${encodeURIComponent(ids.join(','))}&depth=4`) as { name?: string; nodes?: Record<string, { document?: FigmaNode } | null> };
      parts.push(`File: ${j.name ?? p.fileKey}`);
      for (const [id, v] of Object.entries(j.nodes ?? {})) parts.push(v?.document ? outlineFigma(v.document).join('\n') : `- ${id}: not found`);
    } else {
      const j = await get(`files/${p.fileKey}?depth=2`) as { name?: string; lastModified?: string; document?: FigmaNode };
      parts.push(`File: ${j.name ?? p.fileKey} (last modified ${j.lastModified ?? '?'})`);
      if (j.document) parts.push(outlineFigma(j.document, 0, 2).join('\n'));
      parts.push('Pass node_ids (or a URL with ?node-id=) to inspect frames in detail and export images.');
    }
    if (exportImages && ids.length) {
      const j = await get(`images/${p.fileKey}?ids=${encodeURIComponent(ids.join(','))}&format=png&scale=2`) as { images?: Record<string, string | null> };
      parts.push(`Image exports (PNG @2x, URLs expire after ~30 days):\n${Object.entries(j.images ?? {}).map(([id, url]) => `- ${id}: ${url ?? 'render failed'}`).join('\n')}`);
    }
    return wrapUntrusted(`figma:${p.fileKey}`, parts.join('\n\n').slice(0, 20_000), 'figma_content');
  } catch (e) {
    return `figma_read failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ---------- generic media provider ----------
export type MediaKind = 'image' | 'video' | 'audio';
export const mediaNotConnected = (kind: MediaKind) => `${kind === 'image' ? 'image_gen' : `${kind}_tools`} is not connected: set MEDIA_PROVIDER=http `
  + 'plus MEDIA_PROVIDER_URL and MEDIA_PROVIDER_KEY (your media gateway) on the worker. Until then, deliver prompts/specs/briefs '
  + 'instead of rendered media and say so in your output.';

/** Generic HTTP media gateway: POST {MEDIA_PROVIDER_URL}/{kind} with {operation, input}; bearer MEDIA_PROVIDER_KEY. */
export async function mediaCall(kind: MediaKind, operation: string, input: Record<string, unknown>, env: Env, f: ApiFetch): Promise<string> {
  const provider = env.MEDIA_PROVIDER;
  if (!provider || !env.MEDIA_PROVIDER_KEY) return mediaNotConnected(kind);
  if (provider !== 'http') return `MEDIA_PROVIDER="${provider}" is not supported by this worker; only the generic "http" gateway is implemented.`;
  if (!env.MEDIA_PROVIDER_URL || !/^https:\/\//.test(env.MEDIA_PROVIDER_URL)) return 'MEDIA_PROVIDER_URL must be an https URL of your media gateway.';
  const res = await f(`${env.MEDIA_PROVIDER_URL.replace(/\/+$/, '')}/${kind}`, {
    method: 'POST', signal: AbortSignal.timeout(120_000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.MEDIA_PROVIDER_KEY}` },
    body: JSON.stringify({ operation, input }),
  });
  const text = (await res.text()).replaceAll(env.MEDIA_PROVIDER_KEY, '[REDACTED]');
  return `Media gateway ${kind}/${operation} → HTTP ${res.status}\n${text.slice(0, 8000)}`;
}

// ---------- Google Workspace (interface only) ----------
export interface GoogleWorkspacePort {
  gmailRead(query: string, max: number): Promise<string>;
  gmailDraft(to: string, subject: string, body: string): Promise<string>;
  calendarRead(fromIso: string, toIso: string): Promise<string>;
}

export const GOOGLE_NOT_CONFIGURED = 'Google OAuth is not configured on the worker (GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, '
  + 'GOOGLE_OAUTH_REFRESH_TOKEN). Gmail and Calendar tools are unavailable: ask the CEO for the information (ask_ceo) '
  + 'or continue without it and note what you could not check.';

export function googleWorkspace(env: Env): GoogleWorkspacePort {
  const configured = !!(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && env.GOOGLE_OAUTH_REFRESH_TOKEN);
  const msg = configured
    ? 'Google OAuth credentials are set, but the Gmail/Calendar connector is not built into this worker yet (interface only). Ask the CEO instead.'
    : GOOGLE_NOT_CONFIGURED;
  return { gmailRead: async () => msg, gmailDraft: async () => msg, calendarRead: async () => msg };
}
