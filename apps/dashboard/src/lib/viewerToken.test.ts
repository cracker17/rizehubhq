import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signViewerToken, verifyViewerToken, viewerHost, viewerLoginUrl, viewerSecret } from './viewerToken';

const SECRET = 'x'.repeat(48);
const NOW = Date.parse('2026-10-17T00:00:00Z');

test('viewer token: valid for its host until it expires; tampering, other hosts, other secrets fail', () => {
  const t = signViewerToken({ host: 'WS.rizehub.ph', client: 'lvlup' }, SECRET, NOW);
  assert.match(t, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(verifyViewerToken(t, 'ws.rizehub.ph', SECRET, NOW + 1000)?.client, 'lvlup');
  assert.equal(verifyViewerToken(t, 'ws-traction.rizehub.ph', SECRET, NOW), null, 'bound to one viewer host');
  assert.equal(verifyViewerToken(t, 'ws.rizehub.ph', SECRET, NOW + 12 * 3600_000), null, 'expired after 12 h');
  assert.equal(verifyViewerToken(t, 'ws.rizehub.ph', 'y'.repeat(48), NOW), null);
  const [p, s] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ host: 'ws.rizehub.ph', client: 'lvlup', iat: 0, exp: 9e9 })).toString('base64url');
  assert.equal(verifyViewerToken(`${forged}.${s}`, 'ws.rizehub.ph', SECRET, NOW), null, 'a changed payload fails');
  assert.equal(verifyViewerToken(`${p}.${s}.x`, 'ws.rizehub.ph', SECRET, NOW), null);
  assert.equal(verifyViewerToken(`${p}`, 'ws.rizehub.ph', SECRET, NOW), null);
  assert.equal(verifyViewerToken('', 'ws.rizehub.ph', SECRET, NOW), null);
  assert.equal(verifyViewerToken(t, null, SECRET, NOW), null);
  assert.equal(verifyViewerToken(signViewerToken({ host: 'ws.rizehub.ph', client: 'lvlup', ttlS: 60 }, SECRET, NOW), 'ws.rizehub.ph', SECRET, NOW + 61_000), null);
});

test('viewer helpers: secret length, host of the live-screen address, login hand-off URL', () => {
  assert.equal(viewerSecret({ OPERATOR_VIEWER_SECRET: 'short' }), null);
  assert.equal(viewerSecret({ OPERATOR_VIEWER_SECRET: ` ${SECRET} ` }), SECRET);
  assert.equal(viewerHost('https://ws.rizehub.ph/'), 'ws.rizehub.ph');
  assert.equal(viewerHost('https://localhost:3101'), 'localhost:3101');
  assert.equal(viewerHost('http://ws.rizehub.ph/'), null);
  assert.equal(viewerHost('nope'), null);
  assert.equal(viewerLoginUrl('https://ws.rizehub.ph/some/path', 'a.b'), 'https://ws.rizehub.ph/__hq/login?t=a.b');
});
