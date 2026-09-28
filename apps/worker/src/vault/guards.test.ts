import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authHeaderFromScope, hasMethodOverride, loginEntry, maskUsername, parseWriteEntry, publishBlocked, redact, REDACTED, secretVariants, urlAllowed,
  writeAllowed,
} from './guards';

test('allowlist: host + path-segment prefix, https only, no credentials in URLs', () => {
  const allow = ['https://shop.myshopify.com/admin/themes', 'api.example.com/v2/', '*.cdn.example.net'];
  assert.ok(urlAllowed('https://shop.myshopify.com/admin/themes', allow));
  assert.ok(urlAllowed('https://shop.myshopify.com/admin/themes/123/assets?x=1', allow));
  assert.ok(urlAllowed('https://api.example.com/v2/items', allow));
  assert.ok(urlAllowed('https://img.cdn.example.net/a.png', allow));
  assert.ok(urlAllowed('https://cdn.example.net/a.png', allow));
  assert.ok(!urlAllowed('https://shop.myshopify.com/admin/themes.json', allow), 'not a whole segment');
  assert.ok(!urlAllowed('https://shop.myshopify.com/admin/orders', allow));
  assert.ok(!urlAllowed('https://shop.myshopify.com/admin/themes/../orders', allow), 'dot segments are normalised first');
  assert.ok(!urlAllowed('https://shop.myshopify.com/admin/themes/%2e%2e/orders', allow));
  assert.ok(!urlAllowed('http://shop.myshopify.com/admin/themes', allow), 'plain http');
  assert.ok(!urlAllowed('https://evil.com/admin/themes', allow));
  assert.ok(!urlAllowed('https://shop.myshopify.com.evil.com/admin/themes', allow));
  assert.ok(!urlAllowed('https://user:pw@shop.myshopify.com/admin/themes', allow));
  assert.ok(!urlAllowed('https://shop.myshopify.com:8443/admin/themes', allow), 'other port');
  assert.ok(!urlAllowed('javascript:alert(1)', allow));
  assert.ok(!urlAllowed('https://api.example.com/v2/items', []), 'empty allowlist allows nothing');
  assert.ok(urlAllowed('http://localhost:4010/x', ['http://localhost:4010/']), 'http only for localhost');
  assert.deepEqual(loginEntry('https://site.com/wp-login.php?x=1'), ['https://site.com/']);
  assert.deepEqual(loginEntry('ftp://x'), []);
});

test('redaction covers raw, URL-encoded, JSON-escaped, base64 and Basic-auth forms', () => {
  const secret = 'p@ss "w/rd"+1';
  const v = secretVariants(secret, 'agent');
  const echo = [
    `raw ${secret}`, `url ${encodeURIComponent(secret)}`, `json ${JSON.stringify({ s: secret })}`,
    `b64 ${Buffer.from(secret).toString('base64')}`, `basic ${Buffer.from(`agent:${secret}`).toString('base64')}`,
  ].join('\n');
  const out = redact(echo, v);
  assert.ok(!out.includes(secret));
  assert.ok(!out.includes(encodeURIComponent(secret)));
  assert.ok(!out.includes(Buffer.from(secret).toString('base64')));
  assert.ok(!out.includes(Buffer.from(`agent:${secret}`).toString('base64')));
  assert.equal(out.split(REDACTED).length - 1, 5);
});

test('username masking and scope header parsing', () => {
  assert.equal(maskUsername('jane.doe@client.com'), 'j***@client.com');
  assert.equal(maskUsername('admin'), 'a***');
  assert.equal(maskUsername(null), '(no username)');
  assert.equal(authHeaderFromScope('Read products only. header: X-Shopify-Access-Token'), 'X-Shopify-Access-Token');
  assert.equal(authHeaderFromScope('themes only'), null);
});

test('write allowlist: "METHOD /path-prefix" entries, method + whole-segment path must match', () => {
  assert.deepEqual(parseWriteEntry('PUT /admin/api/2025-07/themes/123/assets.json'), { method: 'PUT', allow: null, path: '/admin/api/2025-07/themes/123/assets.json' });
  assert.equal(parseWriteEntry('GET /x'), null);
  assert.equal(parseWriteEntry('DELETE /x'), null);
  assert.equal(parseWriteEntry('put /x'), null);
  assert.equal(parseWriteEntry('PUT admin/x'), null);
  assert.equal(parseWriteEntry('PUT http://plain.example.com/x'), null);
  const u = (s: string) => new URL(s);
  const allow = ['PUT /admin/api/2025-07/themes/123/assets.json', 'PATCH https://api.webflow.com/v2/collections/c1/items'];
  assert.ok(writeAllowed('PUT', u('https://shop.myshopify.com/admin/api/2025-07/themes/123/assets.json?asset[key]=x'), allow));
  assert.ok(!writeAllowed('POST', u('https://shop.myshopify.com/admin/api/2025-07/themes/123/assets.json'), allow));
  assert.ok(!writeAllowed('PUT', u('https://shop.myshopify.com/admin/api/2025-07/themes/1234/assets.json'), allow));
  assert.ok(writeAllowed('PATCH', u('https://api.webflow.com/v2/collections/c1/items/i9'), allow));
  assert.ok(!writeAllowed('PATCH', u('https://evil.example.com/v2/collections/c1/items/i9'), allow), 'full-URL entries pin the host');
  assert.ok(!writeAllowed('PUT', u('https://x.com/anything'), []));
});

test('publish endpoints are recognised (Shopify theme role / themePublish, Webflow publish/live, WordPress status=publish)', () => {
  const u = (s: string) => new URL(s);
  assert.match(publishBlocked('PUT', u('https://s.myshopify.com/admin/api/2025-07/themes/9.json'), '{"theme":{"role":"main"}}')!, /Shopify/);
  assert.match(publishBlocked('PUT', u('https://s.myshopify.com/admin/themes/9.json'), 'theme[role]=main')!, /Shopify/);
  assert.equal(publishBlocked('PUT', u('https://s.myshopify.com/admin/api/2025-07/themes/9.json'), '{"theme":{"name":"Draft"}}'), null);
  assert.match(publishBlocked('POST', u('https://s.myshopify.com/admin/api/2025-07/graphql.json'), '{"query":"mutation{themePublish(id:1){theme{id}}}"}')!, /Shopify/);
  assert.match(publishBlocked('POST', u('https://api.webflow.com/v2/sites/s1/publish'), '{}')!, /Webflow/);
  assert.match(publishBlocked('POST', u('https://api.webflow.com/v2/collections/c/items/live'), '{}')!, /Webflow/);
  assert.equal(publishBlocked('POST', u('https://api.webflow.com/v2/collections/c/items'), '{"isDraft":true}'), null);
  assert.match(publishBlocked('POST', u('https://b.com/wp-json/wp/v2/pages/2'), '{"status":"publish"}')!, /WordPress/);
  assert.match(publishBlocked('POST', u('https://b.com/wp-json/wp/v2/pages/2'), 'status=future')!, /WordPress/);
  assert.match(publishBlocked('POST', u('https://b.com/?rest_route=/wp/v2/posts&status=publish'), '')!, /WordPress/);
  assert.equal(publishBlocked('POST', u('https://b.com/wp-json/wp/v2/pages/2'), '{"status":"draft"}'), null);
  assert.equal(publishBlocked('GET', u('https://api.webflow.com/v2/sites/s1/publish'), undefined), null, 'reads are never blocked');
  assert.ok(hasMethodOverride(u('https://b.com/wp-json/wp/v2/posts/1?_method=DELETE')));
  assert.ok(!hasMethodOverride(u('https://b.com/wp-json/wp/v2/posts/1?method=x')));
});
