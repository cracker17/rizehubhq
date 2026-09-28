import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authHeaderFromScope, loginEntry, maskUsername, redact, REDACTED, secretVariants, urlAllowed } from './guards';

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
