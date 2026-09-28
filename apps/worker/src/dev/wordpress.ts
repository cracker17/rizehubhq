// wp_rest: WordPress REST API with an Application Password from the Client Vault. Only on the credential's
// allowed domain(s); posts/pages are created/updated as draft or pending only; content that is already live
// (publish/future/private) is never edited; deletes and publishing go through request_external_action.
import fs from 'node:fs';
import path from 'node:path';
import { safeUrl, urlAllowed } from '../vault/guards';
import type { DevEnv } from './env';
import { apiError, httpRequest, truncate, type HttpRes, type Redactor } from './http';
import { resolveIn, type Jail } from './jail';
import { externalAction, type Token } from './creds';

export class WpRefusal extends Error {}
const refuse = (m: string): never => { throw new WpRefusal(m); };

const ALLOWED_STATUS = new Set(['draft', 'pending']);
const LIVE_STATUS = new Set(['publish', 'future', 'private']);
const MEDIA_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm',
};
const MAX_MEDIA = 20 * 1024 * 1024;

export interface WpCtx { env: DevEnv; token: Token; red: Redactor; base: string }
export interface WpInput {
  op: string; type?: 'posts' | 'pages'; id?: number; site?: string; search?: string; status?: string; page?: number;
  title?: string; content?: string; excerpt?: string; slug?: string; parent?: number; template?: string; meta?: Record<string, unknown>;
  file?: string; alt_text?: string; caption?: string;
}

/** Picks the REST base (origin) from the credential allowlist; `site` must be one of them. */
export function wpBase(token: Token, site?: string): string {
  const allow = token.allowlist;
  if (!allow.length) refuse('This credential has no allowed domain (url_allowlist). Ask the CEO to set the staging URL on it.');
  const candidate = site?.trim() || allow[0]!.replace(/\*+$/, '');
  const u = safeUrl(/^https?:\/\//.test(candidate) ? candidate : `https://${candidate}`);
  if (!u) refuse(`site must be an https URL (got "${candidate}")`);
  const probe = new URL('/wp-json/wp/v2/', u!.origin);
  if (!urlAllowed(probe, allow)) refuse(`${u!.origin} is not on this credential's allowed domains (${allow.join(', ')}).`);
  return u!.origin;
}

async function wp(c: WpCtx, method: string, p: string, body?: unknown, extraHeaders: Record<string, string> = {}, raw?: Uint8Array): Promise<HttpRes> {
  const url = `${c.base}/wp-json/wp/v2${p}`;
  if (!urlAllowed(url, c.token.allowlist)) refuse(`${url} is not allowed by this credential`);
  const auth = Buffer.from(`${c.token.username ?? ''}:${c.token.token}`).toString('base64');
  return httpRequest(c.env, {
    url, method,
    headers: { authorization: `Basic ${auth}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...extraHeaders },
    body: raw ?? (body ? JSON.stringify(body) : undefined), retries: 3, timeoutMs: raw ? 120_000 : 30_000,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const view = (x: Any) => ({
  id: x.id, type: x.type, status: x.status, slug: x.slug, link: x.link, modified: x.modified,
  title: x.title?.raw ?? x.title?.rendered, excerpt: truncate(String(x.excerpt?.raw ?? x.excerpt?.rendered ?? ''), 500),
  parent: x.parent, template: x.template,
});

function typeOf(i: WpInput): 'posts' | 'pages' {
  if (i.type !== 'posts' && i.type !== 'pages') refuse('type must be "posts" or "pages"');
  return i.type!;
}
function statusOf(s: string | undefined, fallback?: string): string | undefined {
  const st = s?.trim().toLowerCase() || fallback;
  if (st && !ALLOWED_STATUS.has(st)) refuse(`status "${st}" is not allowed. Agents save as "draft" or "pending" only. Publishing is request_external_action({ type: "publish_wordpress", … }).`);
  return st;
}
function fields(i: WpInput) {
  const f: Record<string, unknown> = {};
  if (i.title !== undefined) f.title = i.title;
  if (i.content !== undefined) f.content = i.content;
  if (i.excerpt !== undefined) f.excerpt = i.excerpt;
  if (i.slug !== undefined) f.slug = i.slug;
  if (i.parent !== undefined) f.parent = i.parent;
  if (i.template !== undefined) f.template = i.template;
  if (i.meta !== undefined) f.meta = i.meta;
  return f;
}

export async function wpOp(c: WpCtx, jail: Jail, i: WpInput): Promise<string> {
  switch (i.op) {
    case 'list': {
      const t = typeOf(i);
      const q = new URLSearchParams({ context: 'edit', per_page: '20', page: String(Math.max(1, i.page ?? 1)), status: 'any' });
      if (i.search) q.set('search', i.search.slice(0, 100));
      if (i.status) q.set('status', i.status.replace(/[^a-z,]/g, ''));
      const r = await wp(c, 'GET', `/${t}?${q}`);
      return r.ok ? truncate(JSON.stringify({ site: c.base, total: r.headers.get('x-wp-total'), items: (r.json as Any[]).map(view) }), 12_000) : apiError(`Listing ${t}`, r);
    }
    case 'get': {
      const t = typeOf(i);
      if (!i.id) refuse('get needs id');
      const r = await wp(c, 'GET', `/${t}/${i.id}?context=edit`);
      if (!r.ok) return apiError('Reading', r);
      const x = r.json as Any;
      return truncate(JSON.stringify({ ...view(x), content: x.content?.raw ?? x.content?.rendered }), 60_000);
    }
    case 'create': {
      const t = typeOf(i);
      const status = statusOf(i.status, 'draft');
      if (!i.title && !i.content) refuse('create needs title and/or content');
      const r = await wp(c, 'POST', `/${t}`, { ...fields(i), status });
      if (!r.ok) return apiError(`Creating the ${t.slice(0, -1)}`, r);
      const x = r.json as Any;
      if (LIVE_STATUS.has(x.status)) return `Warning: WordPress reports status "${x.status}" for #${x.id}. Tell the CEO immediately via ask_ceo.`;
      return JSON.stringify({ ok: true, ...view(x), preview: `${c.base}/?${t === 'pages' ? 'page_id' : 'p'}=${x.id}&preview=true`, note: `Saved as ${x.status}. Publishing is request_external_action.` });
    }
    case 'update': {
      const t = typeOf(i);
      if (!i.id) refuse('update needs id');
      const status = statusOf(i.status);
      const cur = await wp(c, 'GET', `/${t}/${i.id}?context=edit`);
      if (!cur.ok) return apiError('Reading before update', cur);
      const was = (cur.json as Any).status as string;
      if (LIVE_STATUS.has(was)) {
        return externalAction('update_live_wordpress', `Update ${t.slice(0, -1)} #${i.id} on ${c.base} (currently ${was}): ${JSON.stringify(fields(i)).slice(0, 500)}`)
          + ' Tip: create a new draft with the changes (op "create") so the CEO can compare before approving.';
      }
      const body = { ...fields(i), ...(status ? { status } : {}) };
      if (!Object.keys(body).length) refuse('update needs at least one field');
      const r = await wp(c, 'POST', `/${t}/${i.id}`, body);
      if (!r.ok) return apiError('Updating', r);
      return JSON.stringify({ ok: true, ...view(r.json), note: 'Still not live.' });
    }
    case 'upload_media': {
      if (!i.file) refuse('upload_media needs `file` (a path in your workspace)');
      const abs = resolveIn(jail, i.file!);
      const ext = path.extname(abs).toLowerCase();
      const type = MEDIA_TYPES[ext];
      if (!type) refuse(`file type ${ext || '(none)'} is not allowed for uploads (${Object.keys(MEDIA_TYPES).join(' ')})`);
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > MAX_MEDIA) refuse(`file must exist and be ≤ ${MAX_MEDIA / 1024 / 1024} MB`);
      const name = path.basename(abs).replace(/[^A-Za-z0-9._-]/g, '-');
      const r = await wp(c, 'POST', '/media', undefined, { 'content-type': type!, 'content-disposition': `attachment; filename="${name}"` }, fs.readFileSync(abs));
      if (!r.ok) return apiError('Uploading media', r);
      const m = r.json as Any;
      if (i.alt_text || i.caption) {
        await wp(c, 'POST', `/media/${m.id}`, { ...(i.alt_text ? { alt_text: i.alt_text } : {}), ...(i.caption ? { caption: i.caption } : {}) });
      }
      return JSON.stringify({ ok: true, id: m.id, url: m.source_url, mime: m.mime_type, note: 'Uploaded to the media library (staging). Attach it to a draft by id/url.' });
    }
    case 'publish':
      return externalAction('publish_wordpress', `Publish ${i.type ?? 'post/page'} #${i.id ?? '<id>'} on ${c.base}`);
    case 'delete':
      return externalAction('delete_wordpress', `Delete ${i.type ?? 'post/page'} #${i.id ?? '<id>'} on ${c.base}`);
    default:
      return refuse(`unknown op "${i.op}"`);
  }
}
