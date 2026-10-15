// Webflow Data API v2 and Airtable for jobs (docs/17-OPERATOR.md "Worker mode"). The agent may only READ through its
// tools; every write (CMS item create/update, publish, Airtable records, deletes) is proposed with request_action and
// run here by executeAction() after the CEO's ✅, from the spec the CEO saw.
//
// Tokens: the Client Vault credential linked to the operator for that client and platform (operator_set_credential,
// decrypted here with the vault key, every use logged), else OPERATOR_WEBFLOW_TOKEN_<CLIENT> / OPERATOR_AIRTABLE_TOKEN_<CLIENT>
// in .env.operator. The model never sees a token; every text handed back is redacted.
import { API as WEBFLOW_API, checkId, webflowOp } from 'worker/src/dev/webflow';
import { apiError, httpRequest, Redactor, truncate, type HttpEnv, type HttpRes } from 'worker/src/dev/http';
import type { DevEnv } from 'worker/src/dev/env';
import type { Token } from 'worker/src/dev/creds';
import { envSlug } from 'worker/src/dev/env';

export type Platform = 'webflow' | 'airtable';
export type TokenSource = (client: string, platform: Platform) => Promise<Token | null>;

export const WEBFLOW_READS = ['list_sites', 'list_collections', 'get_collection', 'list_items', 'get_item', 'list_pages', 'get_page', 'get_page_content'] as const;
export const AIRTABLE_READS = ['list_bases', 'list_tables', 'list_records', 'get_record'] as const;
const AIRTABLE = 'https://api.airtable.com/v0';

export class ApiRefusal extends Error {}
const refuse = (m: string): never => { throw new ApiRefusal(m); };

/** env fallback name for a client's token: OPERATOR_WEBFLOW_TOKEN_LVLUP. */
export const envTokenName = (platform: Platform, client: string) => `OPERATOR_${platform.toUpperCase()}_TOKEN_${envSlug(client)}`;

export interface ApiEnv { http: HttpEnv; tokens: TokenSource; env: Readonly<Record<string, string | undefined>> }

async function token(a: ApiEnv, client: string, platform: Platform, red: Redactor): Promise<Token> {
  const t = await a.tokens(client, platform);
  if (!t) refuse(`No ${platform} API token for ${client}: link one on /operator (Client Vault) or set ${envTokenName(platform, client)}. Use the browser instead, or say so in finish.`);
  red.add(t!.token);
  return t!;
}

// ---------- reads (agent tools) ----------

export async function webflowRead(a: ApiEnv, client: string, input: { op: string } & Record<string, unknown>): Promise<string> {
  const red = new Redactor(a.env);
  try {
    if (!(WEBFLOW_READS as readonly string[]).includes(input.op)) {
      refuse(`"${input.op}" is not a read. CMS writes, publishing and deletes are proposed with request_action (kind webflow_cms / webflow_publish / delete) and run after Julev approves.`);
    }
    const t = await token(a, client, 'webflow', red);
    return red.apply(await webflowOp({ env: a.http as unknown as DevEnv, token: t, red }, input as never));
  } catch (e) {
    return red.apply(e instanceof Error ? (e instanceof ApiRefusal || e.name === 'WebflowRefusal' ? `Refused: ${e.message}` : `Webflow error: ${e.message}`) : String(e));
  }
}

const BASE_RE = /^app[A-Za-z0-9]{14}$/;
const REC_RE = /^rec[A-Za-z0-9]{14}$/;
const checkBase = (b: unknown) => (typeof b === 'string' && BASE_RE.test(b.trim()) ? b.trim() : refuse(`base_id must look like app… (17 chars), got "${String(b ?? '')}"`));
const checkRec = (r: unknown) => (typeof r === 'string' && REC_RE.test(r.trim()) ? r.trim() : refuse(`record id must look like rec… (17 chars), got "${String(r ?? '')}"`));
const checkTable = (t: unknown) => (typeof t === 'string' && t.trim() && t.length <= 200 ? encodeURIComponent(t.trim()) : refuse('table (name or tbl… id) is required'));

async function at(a: ApiEnv, t: Token, method: string, p: string, body?: unknown): Promise<HttpRes> {
  return httpRequest(a.http, {
    url: `${AIRTABLE}${p}`, method, retries: 3,
    headers: { authorization: `Bearer ${t.token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}
const ok = (r: HttpRes, what: string, map: (j: any) => unknown) => (r.ok ? truncate(JSON.stringify(map(r.json)), 12_000) : apiError(what, r)); // eslint-disable-line @typescript-eslint/no-explicit-any

export async function airtableRead(a: ApiEnv, client: string, i: { op: string; base_id?: string; table?: string; record_id?: string; view?: string; filter?: string; max_records?: number; offset?: string }): Promise<string> {
  const red = new Redactor(a.env);
  try {
    if (!(AIRTABLE_READS as readonly string[]).includes(i.op)) {
      refuse(`"${i.op}" is not a read. Creating, updating or deleting records is proposed with request_action (kind airtable_write / delete).`);
    }
    const t = await token(a, client, 'airtable', red);
    let out: string;
    switch (i.op) {
      case 'list_bases':
        out = ok(await at(a, t, 'GET', '/meta/bases'), 'Listing bases', (j) => ({ bases: (j?.bases ?? []).map((b: any) => ({ id: b.id, name: b.name, permission: b.permissionLevel })) })); // eslint-disable-line @typescript-eslint/no-explicit-any
        break;
      case 'list_tables':
        out = ok(await at(a, t, 'GET', `/meta/bases/${checkBase(i.base_id)}/tables`), 'Listing tables', (j) => ({
          tables: (j?.tables ?? []).map((x: any) => ({ id: x.id, name: x.name, primary: x.primaryFieldId, fields: (x.fields ?? []).map((f: any) => ({ id: f.id, name: f.name, type: f.type })) })), // eslint-disable-line @typescript-eslint/no-explicit-any
        }));
        break;
      case 'list_records': {
        const q = new URLSearchParams({ pageSize: String(Math.min(Math.max(1, i.max_records ?? 50), 100)) });
        if (i.view) q.set('view', i.view);
        if (i.filter) q.set('filterByFormula', i.filter.slice(0, 2000));
        if (i.offset) q.set('offset', i.offset);
        out = ok(await at(a, t, 'GET', `/${checkBase(i.base_id)}/${checkTable(i.table)}?${q}`), 'Listing records', (j) => ({ records: j?.records ?? [], offset: j?.offset ?? null }));
        break;
      }
      default:
        out = ok(await at(a, t, 'GET', `/${checkBase(i.base_id)}/${checkTable(i.table)}/${checkRec(i.record_id)}`), 'Reading the record', (j) => j);
    }
    return red.apply(out);
  } catch (e) {
    return red.apply(e instanceof ApiRefusal ? `Refused: ${e.message}` : `Airtable error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------- approved actions (executor) ----------

export interface ActionRow { id: string; job_id: string; client_slug: string; kind: string; summary: string; spec: Record<string, unknown> }
export interface ActionOutcome { ok: boolean; result: Record<string, unknown>; error: string | null }

const arr = <T = unknown>(v: unknown, what: string, max: number): T[] => {
  if (!Array.isArray(v) || !v.length) refuse(`${what} must be a non-empty list`);
  if ((v as unknown[]).length > max) refuse(`${what}: at most ${max} per action`);
  return v as T[];
};
const failText = (r: HttpRes, what: string) => apiError(what, r).slice(0, 600);

async function wf(a: ApiEnv, t: Token, method: string, p: string, body?: unknown): Promise<HttpRes> {
  return httpRequest(a.http, {
    url: `${WEBFLOW_API}${p}`, method, retries: method === 'GET' ? 3 : 1,
    headers: { authorization: `Bearer ${t.token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** webflow_cms spec: { collection_id, ops: [{ op: "create" | "update", item_id?, field_data, draft? }] } (≤ 100). */
async function webflowCms(a: ApiEnv, t: Token, s: Record<string, unknown>): Promise<ActionOutcome> {
  const col = checkId('collection_id', s.collection_id as string);
  const ops = arr<{ op?: string; item_id?: string; field_data?: Record<string, unknown>; draft?: boolean }>(s.ops, 'ops', 100);
  const done: { op: string; id: string | null }[] = [];
  for (const [n, o] of ops.entries()) {
    if (!o.field_data || typeof o.field_data !== 'object') refuse(`ops[${n}] needs field_data`);
    const body = { isArchived: false, isDraft: o.draft === true, fieldData: o.field_data };
    const r = o.op === 'update'
      ? await wf(a, t, 'PATCH', `/collections/${col}/items/${checkId('item_id', o.item_id)}`, body)
      : o.op === 'create' ? await wf(a, t, 'POST', `/collections/${col}/items`, body) : refuse(`ops[${n}].op must be create or update`);
    if (!r.ok) return { ok: false, result: { done }, error: `op ${n + 1} of ${ops.length}: ${failText(r, o.op === 'update' ? 'Updating the item' : 'Creating the item')}` };
    done.push({ op: o.op!, id: (r.json as { id?: string } | null)?.id ?? o.item_id ?? null });
  }
  return { ok: true, result: { done, note: 'Staged in the CMS; not live until published.' }, error: null };
}

/** webflow_publish spec: { site_id, custom_domain_ids?, webflow_subdomain? } or { collection_id, item_ids }. */
async function webflowPublish(a: ApiEnv, t: Token, s: Record<string, unknown>): Promise<ActionOutcome> {
  if (s.collection_id) {
    const ids = arr<string>(s.item_ids, 'item_ids', 100).map((i) => checkId('item_id', i));
    const r = await wf(a, t, 'POST', `/collections/${checkId('collection_id', s.collection_id as string)}/items/publish`, { itemIds: ids });
    return r.ok ? { ok: true, result: { published_items: ids.length, response: r.json }, error: null } : { ok: false, result: {}, error: failText(r, 'Publishing the items') };
  }
  const site = checkId('site_id', s.site_id as string);
  const domains = Array.isArray(s.custom_domain_ids) ? (s.custom_domain_ids as string[]).map((d) => checkId('custom_domain_id', d)) : [];
  const body = { publishToWebflowSubdomain: s.webflow_subdomain !== false, ...(domains.length ? { customDomains: domains } : {}) };
  const r = await wf(a, t, 'POST', `/sites/${site}/publish`, body);
  return r.ok ? { ok: true, result: { published: true, to: body, response: r.json }, error: null } : { ok: false, result: {}, error: failText(r, 'Publishing the site') };
}

/** airtable_write spec: { base_id, table, op: "create" | "update", records: [{ id?, fields }], typecast? } (≤ 100, sent in tens). */
async function airtableWrite(a: ApiEnv, t: Token, s: Record<string, unknown>): Promise<ActionOutcome> {
  const base = checkBase(s.base_id); const table = checkTable(s.table);
  const op = s.op === 'update' ? 'update' : s.op === 'create' ? 'create' : refuse('op must be create or update');
  const recs = arr<{ id?: string; fields?: Record<string, unknown> }>(s.records, 'records', 100).map((r, n) => {
    if (!r.fields || typeof r.fields !== 'object') refuse(`records[${n}] needs fields`);
    return op === 'update' ? { id: checkRec(r.id), fields: r.fields } : { fields: r.fields };
  });
  const ids: string[] = [];
  for (let i = 0; i < recs.length; i += 10) {
    const r = await at(a, t, op === 'update' ? 'PATCH' : 'POST', `/${base}/${table}`, { records: recs.slice(i, i + 10), typecast: s.typecast === true });
    if (!r.ok) return { ok: false, result: { done: ids }, error: `records ${i + 1}-${Math.min(i + 10, recs.length)}: ${failText(r, 'Writing records')}` };
    for (const x of ((r.json as { records?: { id: string }[] } | null)?.records ?? [])) ids.push(x.id);
  }
  return { ok: true, result: { op, records: ids }, error: null };
}

/** delete spec: { platform: "webflow", collection_id, item_ids } | { platform: "airtable", base_id, table, record_ids }. */
async function deleteThings(a: ApiEnv, client: string, s: Record<string, unknown>, red: Redactor): Promise<ActionOutcome> {
  if (s.platform === 'webflow') {
    const t = await token(a, client, 'webflow', red);
    const col = checkId('collection_id', s.collection_id as string);
    const ids = arr<string>(s.item_ids, 'item_ids', 50).map((i) => checkId('item_id', i));
    const gone: string[] = [];
    for (const id of ids) {
      const r = await wf(a, t, 'DELETE', `/collections/${col}/items/${id}`);
      if (!r.ok && r.status !== 404) return { ok: false, result: { deleted: gone }, error: failText(r, `Deleting ${id}`) };
      gone.push(id);
    }
    return { ok: true, result: { deleted: gone }, error: null };
  }
  if (s.platform === 'airtable') {
    const t = await token(a, client, 'airtable', red);
    const ids = arr<string>(s.record_ids, 'record_ids', 50).map(checkRec);
    const base = checkBase(s.base_id); const table = checkTable(s.table);
    const gone: string[] = [];
    for (let i = 0; i < ids.length; i += 10) {
      const q = ids.slice(i, i + 10).map((id) => `records[]=${id}`).join('&');
      const r = await at(a, t, 'DELETE', `/${base}/${table}?${q}`);
      if (!r.ok) return { ok: false, result: { deleted: gone }, error: failText(r, 'Deleting records') };
      gone.push(...ids.slice(i, i + 10));
    }
    return { ok: true, result: { deleted: gone }, error: null };
  }
  return refuse('delete needs platform "webflow" or "airtable" (other deletes: Julev does them by hand)');
}

/** Runs one approved API action. Browser clicks are executed by the job loop (they need the workspace browser). */
export async function executeApiAction(a: ApiEnv, x: ActionRow): Promise<ActionOutcome> {
  const red = new Redactor(a.env);
  const scrub = (o: ActionOutcome): ActionOutcome => ({ ok: o.ok, error: o.error ? red.apply(o.error) : null, result: JSON.parse(red.apply(JSON.stringify(o.result))) as Record<string, unknown> });
  try {
    switch (x.kind) {
      case 'webflow_cms': return scrub(await webflowCms(a, await token(a, x.client_slug, 'webflow', red), x.spec));
      case 'webflow_publish': return scrub(await webflowPublish(a, await token(a, x.client_slug, 'webflow', red), x.spec));
      case 'airtable_write': return scrub(await airtableWrite(a, await token(a, x.client_slug, 'airtable', red), x.spec));
      case 'delete': return scrub(await deleteThings(a, x.client_slug, x.spec, red));
      default: return { ok: false, result: {}, error: `no executor for "${x.kind}": Julev does it by hand` };
    }
  } catch (e) {
    return { ok: false, result: {}, error: red.apply(e instanceof Error ? e.message : String(e)).slice(0, 1000) };
  }
}
