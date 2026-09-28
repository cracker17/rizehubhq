// shopify_theme, webflow_api, wp_rest and the HTTP layer with a fake fetch: main-theme write refusal,
// publish refusal, drafts only, domain allowlist, retries/backoff, redaction. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { httpRequest, Redactor } from './http';
import { checkKey, previewUrl } from './shopify';
import { devSetup, fakeEnv, fakeVault, json, run, type FetchCall } from './testkit';

const SHOP_TOKEN = 'shpat_DEMO_not_real_00112233445566';
const SHOP_ENV = { SHOPIFY_TOKEN_MADAM_MUSE: SHOP_TOKEN, SHOPIFY_STORE_MADAM_MUSE: 'madammuse.myshopify.com' };

/** Fake Shopify GraphQL: theme 1 = MAIN, theme 2 = UNPUBLISHED. */
function shopifyFake(roles: Record<string, string> = { 1: 'MAIN', 2: 'UNPUBLISHED' }) {
  const mutations: { query: string; variables: Record<string, unknown> }[] = [];
  const handler = (c: FetchCall) => {
    assert.equal(c.url, 'https://madammuse.myshopify.com/admin/api/2025-07/graphql.json');
    assert.equal(c.headers.get('x-shopify-access-token'), SHOP_TOKEN);
    const { query, variables } = JSON.parse(c.body) as { query: string; variables: Record<string, unknown> };
    if (query.startsWith('mutation')) mutations.push({ query, variables });
    if (query.includes('themes(first: 20, roles: [MAIN])')) return json({ data: { themes: { nodes: [{ id: 'gid://shopify/OnlineStoreTheme/1', name: 'Dawn', role: 'MAIN' }] } } });
    if (query.includes('themes(first: 50)')) return json({ data: { themes: { nodes: Object.entries(roles).map(([id, role]) => ({ id: `gid://shopify/OnlineStoreTheme/${id}`, name: `T${id}`, role })) } } });
    if (query.includes('theme(id: $id) { id name role')) {
      const id = String(variables.id).split('/').pop()!;
      return json({ data: { theme: roles[id] ? { id: variables.id, name: `T${id}`, role: roles[id] } : null } });
    }
    if (query.includes('themeDuplicate')) return json({ data: { themeDuplicate: { newTheme: { id: 'gid://shopify/OnlineStoreTheme/9', name: 'Dawn copy', role: 'UNPUBLISHED', processing: true }, userErrors: [] } } });
    if (query.includes('themeFilesUpsert')) {
      const files = variables.files as { filename: string }[];
      return json({ data: { themeFilesUpsert: { upsertedThemeFiles: files.map((f) => ({ filename: f.filename })), userErrors: [] } } });
    }
    if (query.includes('themeFilesDelete')) return json({ data: { themeFilesDelete: { deletedThemeFiles: [{ filename: 'x' }], userErrors: [] } } });
    if (query.includes('files(first:')) {
      return json({ data: { theme: { files: { nodes: [
        { filename: 'sections/hero.liquid', size: 20, body: { content: '<section>hero</section>' } },
        { filename: 'assets/logo.png', size: 3, body: { contentBase64: Buffer.from('PNG').toString('base64') } },
        { filename: '../evil.liquid', size: 1, body: { content: 'x' } },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } } });
    }
    return json({ errors: [{ message: `unexpected query ${SHOP_TOKEN}` }] });
  };
  return { mutations, handler };
}

function shop(roles?: Record<string, string>) {
  const fk = shopifyFake(roles);
  const f = fakeEnv({ env: SHOP_ENV, fetch: fk.handler });
  return { ...f, ...devSetup(f.env, 'web-dev'), mutations: fk.mutations };
}

test('shopify: writes to the MAIN (live) theme are refused before any mutation', async () => {
  const s = shop();
  for (const input of [
    { op: 'put_asset', theme_id: 1, key: 'sections/hero.liquid', value: 'x' },
    { op: 'delete_asset', theme_id: 1, key: 'sections/hero.liquid' },
    { op: 'push', theme_id: '1', dir: 'theme', files: ['sections/hero.liquid'] },
  ]) {
    fs.mkdirSync(path.join(s.jailDir, 'theme', 'sections'), { recursive: true });
    fs.writeFileSync(path.join(s.jailDir, 'theme', 'sections', 'hero.liquid'), 'x');
    const out = await run(s.tools, 'shopify_theme', input);
    assert.match(out, /^Refused: .*LIVE \(main\) theme/, JSON.stringify(input));
  }
  assert.equal(s.mutations.length, 0);
});

test('shopify: role is re-read before every write (theme published in between → refused)', async () => {
  const roles: Record<string, string> = { 2: 'UNPUBLISHED' };
  const s = shop(roles);
  assert.match(await run(s.tools, 'shopify_theme', { op: 'put_asset', theme_id: 2, key: 'sections/hero.liquid', value: '<div></div>' }), /Saved sections\/hero\.liquid to unpublished theme 2/);
  roles[2] = 'MAIN';
  assert.match(await run(s.tools, 'shopify_theme', { op: 'put_asset', theme_id: 2, key: 'sections/hero.liquid', value: '<div></div>' }), /^Refused/);
  assert.equal(s.mutations.length, 1);
  roles[2] = 'DEMO';
  assert.match(await run(s.tools, 'shopify_theme', { op: 'put_asset', theme_id: 2, key: 'sections/hero.liquid', value: 'x' }), /role DEMO/);
});

test('shopify: publish is never available (tool and CLI) → request_external_action', async () => {
  const s = shop();
  const out = await run(s.tools, 'shopify_theme', { op: 'publish', theme_id: 2 });
  assert.match(out, /request_external_action\(\{ type: "publish_theme", spec: "Publish theme 2 on madammuse\.myshopify\.com" \}\)/);
  assert.equal(s.mutations.length, 0);
  assert.match(await run(s.tools, 'bash_sandboxed', { command: 'shopify theme publish -t 2' }), /^Refused/);
  assert.equal(s.runCalls.length, 0);
});

test('shopify: duplicate_live makes an unpublished copy; list_themes marks writability; preview URLs', async () => {
  const s = shop();
  const d = JSON.parse(await run(s.tools, 'shopify_theme', { op: 'duplicate_live' }));
  assert.equal(d.theme_id, '9');
  assert.equal(d.role, 'UNPUBLISHED');
  assert.equal(d.source_theme_id, '1');
  assert.equal(s.mutations[0]!.variables.id, 'gid://shopify/OnlineStoreTheme/1');
  const l = JSON.parse(await run(s.tools, 'shopify_theme', { op: 'list_themes' }));
  assert.deepEqual(l.themes.map((t: { writable: boolean }) => t.writable), [false, true]);
  assert.deepEqual(previewUrl('madammuse.myshopify.com', '9'), {
    preview_url: 'https://madammuse.myshopify.com/?preview_theme_id=9',
    customizer_url: 'https://admin.shopify.com/store/madammuse/themes/9/editor',
  });
});

test('shopify: pull writes into the jail (skipping bad keys); push skips settings_data.json unless listed', async () => {
  const s = shop();
  const p = await run(s.tools, 'shopify_theme', { op: 'pull', theme_id: 1, dir: 'theme' });
  assert.match(p, /Pulled 2 file\(s\).*Skipped 1: \.\.\/evil\.liquid/);
  assert.equal(fs.readFileSync(path.join(s.jailDir, 'theme/sections/hero.liquid'), 'utf8'), '<section>hero</section>');
  assert.equal(fs.readFileSync(path.join(s.jailDir, 'theme/assets/logo.png'), 'utf8'), 'PNG');
  assert.ok(!fs.existsSync(path.join(s.jailDir, 'evil.liquid')));
  fs.mkdirSync(path.join(s.jailDir, 'theme/config'), { recursive: true });
  fs.writeFileSync(path.join(s.jailDir, 'theme/config/settings_data.json'), '{}');
  fs.writeFileSync(path.join(s.jailDir, 'theme/README.md'), 'not a theme file');
  const out = await run(s.tools, 'shopify_theme', { op: 'push', theme_id: 2, dir: 'theme' });
  assert.match(out, /Pushed 2\/2 file\(s\) to unpublished theme 2/);
  const files = (s.mutations.at(-1)!.variables.files as { filename: string; body: { type: string } }[]);
  assert.deepEqual(files.map((f) => f.filename).sort(), ['assets/logo.png', 'sections/hero.liquid']);
  assert.equal(files.find((f) => f.filename === 'assets/logo.png')!.body.type, 'BASE64');
});

test('shopify: theme keys validated; env token needs both token and store; foreign store refused', async () => {
  for (const k of ['../x.liquid', 'sections/../../x', 'secrets/x', 'sections/']) assert.throws(() => checkKey(k), k);
  assert.equal(checkKey('/sections/hero.liquid'), 'sections/hero.liquid');
  const s = shop();
  assert.match(await run(s.tools, 'shopify_theme', { op: 'list_themes', store: 'other.myshopify.com' }), /^Refused: this task's store is madammuse/);
  const f = fakeEnv({ env: { SHOPIFY_TOKEN_MADAM_MUSE: SHOP_TOKEN } });
  const s2 = devSetup(f.env);
  assert.match(await run(s2.tools, 'shopify_theme', { op: 'list_themes' }), /set SHOPIFY_TOKEN_MADAM_MUSE \+ SHOPIFY_STORE_MADAM_MUSE/);
});

test('shopify: token from a vault credential is never shown, even when the API echoes it', async () => {
  const v = fakeVault();
  const cred = v.add({ platform: 'shopify', secret: SHOP_TOKEN, urlAllowlist: ['https://madammuse.myshopify.com/admin/api'] });
  const f = fakeEnv({ vault: v.vault, fetch: () => json({ errors: [{ message: `Invalid token ${SHOP_TOKEN} (${Buffer.from(SHOP_TOKEN).toString('base64')})` }] }, 401) });
  const s = devSetup(f.env);
  const out = await run(s.tools, 'shopify_theme', { op: 'list_themes', credential_id: cred });
  assert.match(out, /HTTP 401/);
  assert.match(out, /vault_report_problem/);
  assert.doesNotMatch(out, /shpat_DEMO/);
  assert.doesNotMatch(out, new RegExp(Buffer.from(SHOP_TOKEN).toString('base64')));
  assert.ok(v.store.log.some((e) => e.credentialId === cred && e.action === 'api_call'));
});

// ---------------- webflow ----------------
const WF_TOKEN = 'wf_DEMO_token_not_real_abcdef0123';
const COLL = '64f0c0ffee0000000000abcd';

test('webflow: CMS items are created/updated as drafts; publish and delete are refused without calls', async () => {
  const f = fakeEnv({
    env: { WEBFLOW_TOKEN_MADAM_MUSE: WF_TOKEN },
    fetch: (c) => json({ id: '64f0c0ffee0000000000ffff', isDraft: JSON.parse(c.body || '{}').isDraft, fieldData: { name: 'A' } }, c.method === 'POST' ? 202 : 200),
  });
  const s = devSetup(f.env, 'web-dev');
  const out = await run(s.tools, 'webflow_api', { op: 'create_item', collection_id: COLL, field_data: { name: 'A', slug: 'a' } });
  assert.match(out, /"isDraft":true/);
  const post = f.fetchCalls[0]!;
  assert.equal(post.url, `https://api.webflow.com/v2/collections/${COLL}/items`);
  assert.deepEqual(JSON.parse(post.body), { isArchived: false, isDraft: true, fieldData: { name: 'A', slug: 'a' } });
  assert.equal(post.headers.get('authorization'), `Bearer ${WF_TOKEN}`);
  await run(s.tools, 'webflow_api', { op: 'update_item', collection_id: COLL, item_id: '64f0c0ffee0000000000ffff', field_data: { name: 'B' } });
  assert.equal(f.fetchCalls[1]!.method, 'PATCH');
  assert.equal(JSON.parse(f.fetchCalls[1]!.body).isDraft, true);
  const n = f.fetchCalls.length;
  assert.match(await run(s.tools, 'webflow_api', { op: 'publish', site_id: COLL }), /request_external_action\(\{ type: "publish_webflow"/);
  assert.match(await run(s.tools, 'webflow_api', { op: 'delete_item', collection_id: COLL, item_id: COLL }), /delete_webflow_item/);
  assert.equal(f.fetchCalls.length, n);
  assert.match(await run(s.tools, 'webflow_api', { op: 'list_items', collection_id: 'nope' }), /^Refused: collection_id must be/);
});

// ---------------- wordpress ----------------
const WP_PASS = 'abcd EFGH ijkl MNOP qrst UVWX';

function wpSetup(posts: Record<number, string> = { 5: 'draft', 6: 'publish' }) {
  const v = fakeVault();
  const cred = v.add({ platform: 'wordpress', secretType: 'app_password', username: 'rizehub-agent', secret: WP_PASS, urlAllowlist: ['https://staging.madammuse.co/wp-json'] });
  const f = fakeEnv({
    vault: v.vault,
    fetch: (c) => {
      const m = /\/wp-json\/wp\/v2\/(posts|pages|media)(?:\/(\d+))?/.exec(c.url)!;
      if (c.method === 'GET' && m[2]) return json({ id: Number(m[2]), status: posts[Number(m[2])], title: { raw: 't' }, content: { raw: 'c' } });
      if (c.method === 'POST' && m[1] === 'media') return json({ id: 77, source_url: 'https://staging.madammuse.co/wp-content/uploads/a.png', mime_type: 'image/png' }, 201);
      const b = JSON.parse(c.body || '{}');
      return json({ id: Number(m[2] ?? 9), status: b.status ?? posts[Number(m[2])] ?? 'draft', title: { raw: b.title }, echo: c.headers.get('authorization') }, 201);
    },
  });
  return { ...f, ...devSetup(f.env, 'web-dev'), cred, v };
}

test('wp: create only as draft/pending; status publish refused before any request; Basic auth with the app password', async () => {
  const s = wpSetup();
  for (const status of ['publish', 'future', 'private']) {
    assert.match(await run(s.tools, 'wp_rest', { op: 'create', credential_id: s.cred, type: 'pages', title: 'About', status }), /^Refused: status/);
  }
  assert.equal(s.fetchCalls.length, 0);
  const out = await run(s.tools, 'wp_rest', { op: 'create', credential_id: s.cred, type: 'pages', title: 'About', content: '<p>x</p>' });
  const post = s.fetchCalls[0]!;
  assert.equal(post.url, 'https://staging.madammuse.co/wp-json/wp/v2/pages');
  assert.equal(JSON.parse(post.body).status, 'draft');
  assert.equal(post.headers.get('authorization'), `Basic ${Buffer.from(`rizehub-agent:${WP_PASS}`).toString('base64')}`);
  assert.doesNotMatch(out, /Basic|abcd EFGH/);
  assert.match(out, /Saved as draft/);
});

test('wp: live content is never edited; publish/delete refused; other domains refused', async () => {
  const s = wpSetup();
  const live = await run(s.tools, 'wp_rest', { op: 'update', credential_id: s.cred, type: 'posts', id: 6, content: 'new' });
  assert.match(live, /request_external_action\(\{ type: "update_live_wordpress"/);
  assert.equal(s.fetchCalls.filter((c) => c.method === 'POST').length, 0);
  assert.match(await run(s.tools, 'wp_rest', { op: 'update', credential_id: s.cred, type: 'posts', id: 5, content: 'new' }), /Still not live/);
  assert.match(await run(s.tools, 'wp_rest', { op: 'update', credential_id: s.cred, type: 'posts', id: 5, status: 'publish' }), /^Refused: status "publish"/);
  assert.match(await run(s.tools, 'wp_rest', { op: 'publish', credential_id: s.cred, type: 'posts', id: 5 }), /publish_wordpress/);
  assert.match(await run(s.tools, 'wp_rest', { op: 'delete', credential_id: s.cred, type: 'posts', id: 5 }), /delete_wordpress/);
  const n = s.fetchCalls.length;
  assert.match(await run(s.tools, 'wp_rest', { op: 'list', credential_id: s.cred, type: 'posts', site: 'https://madammuse.co' }), /^Refused: https:\/\/madammuse\.co is not on this credential's allowed domains/);
  assert.equal(s.fetchCalls.length, n);
});

test('wp: media upload from the workspace only', async () => {
  const s = wpSetup();
  fs.mkdirSync(s.jailDir, { recursive: true });
  fs.writeFileSync(path.join(s.jailDir, 'hero.png'), 'PNGDATA');
  const out = await run(s.tools, 'wp_rest', { op: 'upload_media', credential_id: s.cred, file: 'hero.png', alt_text: 'Hero' });
  assert.match(out, /"id":77/);
  const up = s.fetchCalls[0]!;
  assert.equal(up.headers.get('content-type'), 'image/png');
  assert.match(up.headers.get('content-disposition')!, /filename="hero\.png"/);
  assert.match(await run(s.tools, 'wp_rest', { op: 'upload_media', credential_id: s.cred, file: '/etc/passwd' }), /^Refused/);
  assert.match(await run(s.tools, 'wp_rest', { op: 'upload_media', credential_id: s.cred, file: 'notes.txt' }), /^Refused|Error/);
});

// ---------------- http + redaction ----------------
test('http: retries 429 (Retry-After) and 5xx on GET; never re-sends a POST on 5xx', async () => {
  let n = 0;
  const sleeps: number[] = [];
  const env = {
    sleep: async (ms: number) => { sleeps.push(ms); },
    fetch: (async () => (++n < 3 ? new Response('busy', { status: n === 1 ? 429 : 503, headers: { 'retry-after': '2' } }) : json({ ok: true }))) as unknown as typeof fetch,
  };
  const r = await httpRequest(env, { url: 'https://api.webflow.com/v2/sites' });
  assert.equal(r.status, 200);
  assert.deepEqual(sleeps, [2000, 2000]);
  n = 0;
  let posts = 0;
  const env2 = { sleep: async () => undefined, fetch: (async () => { posts++; return new Response('err', { status: 500 }); }) as unknown as typeof fetch };
  assert.equal((await httpRequest(env2, { url: 'https://x.test', method: 'POST', body: '{}' })).status, 500);
  assert.equal(posts, 1);
  let tries = 0;
  const env3 = { sleep: async () => undefined, fetch: (async () => { tries++; return new Response('rate', { status: 429 }); }) as unknown as typeof fetch };
  assert.equal((await httpRequest(env3, { url: 'https://x.test', method: 'POST', retries: 2 })).status, 429);
  assert.equal(tries, 3);
});

test('redactor: raw, URL-encoded, JSON-escaped, base64 and Basic-pair forms; secret-looking worker env too', () => {
  const r = new Redactor({ SUPABASE_SERVICE_ROLE_KEY: 'eyJservice_role_demo_key_1234', LANG: 'en_US.UTF-8-long-value' });
  r.add('p@ss/wo"rd+demo', 'agent');
  const text = [
    'p@ss/wo"rd+demo', encodeURIComponent('p@ss/wo"rd+demo'), JSON.stringify('p@ss/wo"rd+demo'),
    Buffer.from('p@ss/wo"rd+demo').toString('base64'), Buffer.from('agent:p@ss/wo"rd+demo').toString('base64'), 'eyJservice_role_demo_key_1234',
  ].join(' | ');
  const out = r.apply(text);
  assert.doesNotMatch(out, /p@ss|p%40ss|eyJservice/);
  assert.doesNotMatch(out, new RegExp(Buffer.from('agent:p@ss/wo"rd+demo').toString('base64').replace(/[+/=]/g, '\\$&')));
  assert.equal(r.apply('en_US.UTF-8-long-value'), 'en_US.UTF-8-long-value');
});
