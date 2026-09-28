// webflow_api: Webflow Data API v2. Reads sites/collections/items/pages; CMS writes always as drafts
// (isDraft: true, staged endpoints only). Publishing (site publish, /items/publish, /items/live) and deletes
// are never called: they go through request_external_action.
import type { DevEnv } from './env';
import { apiError, httpRequest, truncate, type HttpRes, type Redactor } from './http';
import { externalAction, type Token } from './creds';

export const API = 'https://api.webflow.com/v2';
const ID_RE = /^[a-f0-9]{24}$/i;

export class WebflowRefusal extends Error {}
const refuse = (m: string): never => { throw new WebflowRefusal(m); };
export const checkId = (what: string, id?: string) => {
  if (!id || !ID_RE.test(id.trim())) refuse(`${what} must be a 24-character Webflow id (got "${id ?? ''}")`);
  return id!.trim();
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export interface WfCtx { env: DevEnv; token: Token; red: Redactor }

async function wf(c: WfCtx, method: string, p: string, body?: unknown): Promise<HttpRes> {
  if (/\/(publish|live)(\/|\?|$)/.test(p)) refuse('publish/live endpoints are never called by agents'); // belt and braces
  return httpRequest(c.env, {
    url: `${API}${p}`, method,
    headers: { authorization: `Bearer ${c.token.token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, retries: 3,
  });
}

const ok = (r: HttpRes, what: string, map: (j: Any) => unknown) => (r.ok ? truncate(JSON.stringify(map(r.json)), 12_000) : apiError(what, r));

export interface WfInput {
  op: string; site_id?: string; collection_id?: string; item_id?: string; page_id?: string;
  field_data?: Record<string, unknown>; offset?: number; limit?: number;
}

export async function webflowOp(c: WfCtx, i: WfInput): Promise<string> {
  switch (i.op) {
    case 'list_sites':
      return ok(await wf(c, 'GET', '/sites'), 'Listing sites', (j) => ({
        sites: (j?.sites ?? []).map((s: Any) => ({ id: s.id, name: s.displayName, short_name: s.shortName, last_published: s.lastPublished, custom_domains: (s.customDomains ?? []).map((d: Any) => d.url) })),
      }));
    case 'list_collections':
      return ok(await wf(c, 'GET', `/sites/${checkId('site_id', i.site_id)}/collections`), 'Listing collections', (j) => ({
        collections: (j?.collections ?? []).map((x: Any) => ({ id: x.id, name: x.displayName, slug: x.slug, singular: x.singularName })),
      }));
    case 'get_collection':
      return ok(await wf(c, 'GET', `/collections/${checkId('collection_id', i.collection_id)}`), 'Reading the collection', (j) => ({
        id: j.id, name: j.displayName, slug: j.slug,
        fields: (j.fields ?? []).map((f: Any) => ({ id: f.id, slug: f.slug, name: f.displayName, type: f.type, required: f.isRequired, validations: f.validations ?? undefined })),
      }));
    case 'list_items': {
      const limit = Math.min(Math.max(1, i.limit ?? 50), 100);
      const offset = Math.max(0, i.offset ?? 0);
      return ok(await wf(c, 'GET', `/collections/${checkId('collection_id', i.collection_id)}/items?limit=${limit}&offset=${offset}`), 'Listing items', (j) => ({
        pagination: j.pagination, items: (j.items ?? []).map((x: Any) => ({ id: x.id, isDraft: x.isDraft, isArchived: x.isArchived, lastPublished: x.lastPublished, fieldData: x.fieldData })),
      }));
    }
    case 'get_item':
      return ok(await wf(c, 'GET', `/collections/${checkId('collection_id', i.collection_id)}/items/${checkId('item_id', i.item_id)}`), 'Reading the item', (j) => j);
    case 'create_item': {
      if (!i.field_data || typeof i.field_data !== 'object') refuse('create_item needs field_data (at least name and slug)');
      const r = await wf(c, 'POST', `/collections/${checkId('collection_id', i.collection_id)}/items`, { isArchived: false, isDraft: true, fieldData: i.field_data });
      return ok(r, 'Creating the item', (j) => ({ ok: true, id: j.id, isDraft: j.isDraft, fieldData: j.fieldData, note: 'Created as a DRAFT (not live). Publishing is request_external_action.' }));
    }
    case 'update_item': {
      if (!i.field_data || typeof i.field_data !== 'object') refuse('update_item needs field_data');
      const r = await wf(c, 'PATCH', `/collections/${checkId('collection_id', i.collection_id)}/items/${checkId('item_id', i.item_id)}`, { isDraft: true, fieldData: i.field_data });
      return ok(r, 'Updating the item', (j) => ({ ok: true, id: j.id, isDraft: j.isDraft, fieldData: j.fieldData, note: 'Staged as a DRAFT; the live site is unchanged until the CEO approves a publish.' }));
    }
    case 'list_pages':
      return ok(await wf(c, 'GET', `/sites/${checkId('site_id', i.site_id)}/pages?limit=100`), 'Listing pages', (j) => ({
        pages: (j?.pages ?? []).map((p: Any) => ({ id: p.id, title: p.title, slug: p.slug, draft: p.draft, archived: p.archived, seo: p.seo, openGraph: p.openGraph, collectionId: p.collectionId ?? undefined })),
      }));
    case 'get_page':
      return ok(await wf(c, 'GET', `/pages/${checkId('page_id', i.page_id)}`), 'Reading the page', (j) => j);
    case 'get_page_content':
      return ok(await wf(c, 'GET', `/pages/${checkId('page_id', i.page_id)}/dom?limit=100`), 'Reading page content', (j) => j);
    case 'publish':
      return externalAction('publish_webflow', `Publish Webflow site ${i.site_id ?? '<site id>'}${i.collection_id ? ` (collection ${i.collection_id}${i.item_id ? `, item ${i.item_id}` : ''})` : ''} to its staging/custom domains`);
    case 'delete_item':
      return externalAction('delete_webflow_item', `Delete CMS item ${i.item_id ?? '<item id>'} from collection ${i.collection_id ?? '<collection id>'}`);
    default:
      return refuse(`unknown op "${i.op}"`);
  }
}
