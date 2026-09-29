import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicOrigin, publicUrl } from './publicUrl';

const req = (url: string, headers: Record<string, string> = {}) => ({ url, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null } });

test('publicOrigin: DASHBOARD_URL first, then the forwarded host, never the container address', () => {
  // What production saw on 2026-09-29: the route handler's request.url was https://0.0.0.0:3000/…
  assert.equal(publicOrigin(req('https://0.0.0.0:3000/api/connectors/callback'), { DASHBOARD_URL: 'https://hq.rizehub.ph/' }), 'https://hq.rizehub.ph');
  assert.equal(publicOrigin(req('https://0.0.0.0:3000/x', { 'x-forwarded-host': 'hq.rizehub.ph', 'x-forwarded-proto': 'https' }), {}), 'https://hq.rizehub.ph');
  assert.equal(publicOrigin(req('http://localhost:3107/x'), {}), 'http://localhost:3107');
});

test('publicUrl: only same-site paths', () => {
  const r = req('https://0.0.0.0:3000/x');
  const env = { DASHBOARD_URL: 'https://hq.rizehub.ph' };
  assert.equal(publicUrl(r, '/admin/connectors?connected=1', env).toString(), 'https://hq.rizehub.ph/admin/connectors?connected=1');
  assert.equal(publicUrl(r, '//evil.example/x', env).toString(), 'https://hq.rizehub.ph/');
  assert.equal(publicUrl(r, 'https://evil.example', env).toString(), 'https://hq.rizehub.ph/');
});
