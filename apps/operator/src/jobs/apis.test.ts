import { test } from 'node:test';
import assert from 'node:assert/strict';
import { airtableRead, envTokenName, executeApiAction, webflowRead, type ApiEnv } from './apis';

const TOKEN = 'wf-secret-token-1234567890';
const COL = 'a'.repeat(24); const ITEM = 'b'.repeat(24); const SITE = 'c'.repeat(24);
function env(responses: (req: { url: string; method: string; body: unknown }) => { status?: number; json?: unknown }, withToken = true) {
  const calls: { url: string; method: string; body: unknown; auth: string | null }[] = [];
  const a: ApiEnv = {
    env: {},
    tokens: async () => (withToken ? { token: TOKEN, source: 'vault', allowlist: [] } : null),
    http: {
      sleep: async () => undefined,
      fetch: (async (url: string, init: RequestInit) => {
        const body = init.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url, method: init.method ?? 'GET', body, auth: (init.headers as Record<string, string>).authorization ?? null });
        const r = responses({ url, method: init.method ?? 'GET', body });
        return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    },
  };
  return { a, calls };
}

test('reads go through; writes are refused with the request_action hint; no token → a clear refusal', async () => {
  const { a, calls } = env(() => ({ json: { sites: [{ id: SITE, displayName: 'LvlUp', shortName: 'lvlup', customDomains: [] }] } }));
  assert.match(await webflowRead(a, 'lvlup', { op: 'list_sites' }), /"name":"LvlUp"/);
  assert.equal(calls[0]!.auth, `Bearer ${TOKEN}`);
  assert.match(await webflowRead(a, 'lvlup', { op: 'publish', site_id: SITE }), /^Refused: .*request_action/);
  assert.match(await webflowRead(a, 'lvlup', { op: 'update_item' }), /webflow_cms/);
  assert.match(await airtableRead(a, 'lvlup', { op: 'create_records' }), /airtable_write/);
  const none = env(() => ({}), false);
  assert.match(await webflowRead(none.a, 'lvlup', { op: 'list_sites' }), /OPERATOR_WEBFLOW_TOKEN_LVLUP/);
  assert.equal(envTokenName('airtable', 'madam-muse'), 'OPERATOR_AIRTABLE_TOKEN_MADAM_MUSE');
});

test('a token echoed by the API never reaches the model', async () => {
  const { a } = env(() => ({ status: 401, json: { message: `bad token ${TOKEN}` } }));
  const out = await webflowRead(a, 'lvlup', { op: 'list_sites' });
  assert.equal(out.includes(TOKEN), false);
});

test('approved CMS ops run in order and stop at the first failure', async () => {
  let n = 0;
  const { a, calls } = env(() => (++n === 2 ? { status: 400, json: { message: 'slug taken' } } : { json: { id: ITEM } }));
  const r = await executeApiAction(a, { id: 'x', job_id: 'j', client_slug: 'lvlup', kind: 'webflow_cms', summary: 's',
    spec: { collection_id: COL, ops: [{ op: 'update', item_id: ITEM, field_data: { name: 'A' } }, { op: 'create', field_data: { name: 'B', slug: 'b' } }, { op: 'create', field_data: { name: 'C' } }] } });
  assert.equal(r.ok, false);
  assert.match(r.error!, /op 2 of 3/);
  assert.equal(calls.length, 2, 'never continues after a failed write');
  assert.equal(calls[0]!.method, 'PATCH');
  assert.deepEqual(calls[0]!.body, { isArchived: false, isDraft: false, fieldData: { name: 'A' } });
});

test('publish: site (webflow subdomain + custom domains) or items', async () => {
  const { a, calls } = env(() => ({ json: { queued: true } }));
  assert.equal((await executeApiAction(a, { id: 'x', job_id: 'j', client_slug: 'lvlup', kind: 'webflow_publish', summary: 's', spec: { site_id: SITE, custom_domain_ids: [ITEM] } })).ok, true);
  assert.match(calls[0]!.url, new RegExp(`/sites/${SITE}/publish$`));
  assert.deepEqual(calls[0]!.body, { publishToWebflowSubdomain: true, customDomains: [ITEM] });
  await executeApiAction(a, { id: 'y', job_id: 'j', client_slug: 'lvlup', kind: 'webflow_publish', summary: 's', spec: { collection_id: COL, item_ids: [ITEM] } });
  assert.match(calls[1]!.url, /\/items\/publish$/);
  const bad = await executeApiAction(a, { id: 'z', job_id: 'j', client_slug: 'lvlup', kind: 'webflow_publish', summary: 's', spec: { site_id: 'nope' } });
  assert.match(bad.error!, /24-character/);
});

test('Airtable writes batch by ten; deletes check ids; unknown kinds are left to Julev', async () => {
  const { a, calls } = env(({ body }) => ({ json: { records: ((body as { records?: unknown[] } | null)?.records ?? []).map((_, i) => ({ id: `rec${String(i).padStart(14, '0')}` })) } }));
  const records = Array.from({ length: 23 }, (_, i) => ({ fields: { Name: `n${i}` } }));
  const r = await executeApiAction(a, { id: 'x', job_id: 'j', client_slug: 'lvlup', kind: 'airtable_write', summary: 's', spec: { base_id: 'appABCDEFGHIJKLMN', table: 'Companies', op: 'create', records } });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 3);
  assert.equal((r.result.records as string[]).length, 23);
  const d = await executeApiAction(a, { id: 'y', job_id: 'j', client_slug: 'lvlup', kind: 'delete', summary: 's', spec: { platform: 'airtable', base_id: 'appABCDEFGHIJKLMN', table: 'Companies', record_ids: ['recABCDEFGHIJKLMN'] } });
  assert.equal(d.ok, true);
  assert.match(calls.at(-1)!.url, /records\[\]=recABCDEFGHIJKLMN/);
  assert.equal(calls.at(-1)!.method, 'DELETE');
  assert.match((await executeApiAction(a, { id: 'z', job_id: 'j', client_slug: 'lvlup', kind: 'other', summary: 's', spec: {} })).error!, /by hand/);
});
