import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicUrl, BlockedUrlError, checkUrlShape, guardedLookup, isPrivateIp, safeFetch } from './net';
import { fakeNet } from './fakes';

test('isPrivateIp: private, loopback, link-local, metadata, mapped and ULA addresses are blocked', () => {
  for (const ip of ['127.0.0.1', '127.8.8.8', '10.0.0.5', '172.16.3.4', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fd00::1', 'fc12::5', '::ffff:127.0.0.1', '::ffff:7f00:1',
    '::ffff:a9fe:a9fe', '64:ff9b::a00:1', '0:0:0:0:0:ffff:7f00:1', 'ff02::1']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ['93.184.216.34', '8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e']) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
  assert.equal(isPrivateIp('not-an-ip'), true);
});

test('checkUrlShape: scheme, credentials, internal names and literal private IPs are refused before DNS', () => {
  const bad = ['ftp://example.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'http://user:pw@example.com/',
    'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.1/', 'http://10.1.2.3:8080/', 'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://localhost:3000/', 'http://app.localhost/', 'http://metadata.google.internal/',
    'http://foo.internal/', 'http://intranet/', 'not a url'];
  for (const u of bad) assert.throws(() => checkUrlShape(u), BlockedUrlError, u);
  assert.equal(checkUrlShape('https://example.com/a?b=1').hostname, 'example.com');
  assert.equal(checkUrlShape('http://localhost:8080/', ['localhost']).port, '8080'); // explicit dev opt-in
});

test('assertPublicUrl: DNS answers pointing at private space (DNS rebinding) are refused', async () => {
  const net = fakeNet({ dns: { 'evil.example': '127.0.0.1', 'meta.example': '169.254.169.254', 'mixed.example': ['93.184.216.34', '10.0.0.8'], 'v6.example': '::1' } });
  for (const h of ['evil.example', 'meta.example', 'mixed.example', 'v6.example']) {
    await assert.rejects(assertPublicUrl(`https://${h}/`, net), /private address/, h);
  }
  await assertPublicUrl('https://good.example/', net);
});

test('safeFetch: follows ≤3 redirects and re-checks every hop (redirect to metadata IP blocked)', async () => {
  const net = fakeNet({
    routes: {
      'https://a.example/': { status: 301, headers: { location: 'https://b.example/' } },
      'https://b.example/': { status: 302, headers: { location: '/c' } },
      'https://b.example/c': { status: 200, body: 'hello' },
      'https://r.example/': { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } },
      'https://dns.example/': { status: 302, headers: { location: 'https://rebind.example/' } },
    },
    dns: { 'rebind.example': '10.0.0.1' },
  });
  const r = await safeFetch('https://a.example/', net);
  assert.equal(r.status, 200);
  assert.equal(r.body.toString(), 'hello');
  assert.deepEqual(r.redirects, ['https://b.example/', 'https://b.example/c']);
  await assert.rejects(safeFetch('https://r.example/', net), BlockedUrlError);
  await assert.rejects(safeFetch('https://dns.example/', net), /private address/);
  assert.ok(!net.transport.requests.some((x) => x.includes('169.254') || x.includes('rebind')), 'never connected to the private target');

  const loop: Record<string, { status: number; headers: Record<string, string> }> = {};
  for (let i = 0; i < 6; i++) loop[`https://loop.example/${i}`] = { status: 302, headers: { location: `https://loop.example/${i + 1}` } };
  await assert.rejects(safeFetch('https://loop.example/0', fakeNet({ routes: loop })), /Too many redirects/);
});

test('safeFetch: size cap truncates the body; huge content-length refused; timeout enforced', async () => {
  const big = 'x'.repeat(5000);
  const net = fakeNet({
    routes: {
      'https://big.example/': { body: big, chunks: 10 },
      'https://huge.example/': { headers: { 'content-length': String(50 * 1024 * 1024) }, body: 'x' },
      'https://slow.example/': { delayMs: 5_000, body: 'late' },
    },
  });
  const r = await safeFetch('https://big.example/', net, { maxBytes: 1000 });
  assert.equal(r.body.length, 1000);
  assert.equal(r.truncated, true);
  await assert.rejects(safeFetch('https://huge.example/', net, { maxBytes: 1024 * 1024 }), /too large/);
  const t0 = Date.now();
  await assert.rejects(safeFetch('https://slow.example/', net, { timeoutMs: 50 }), /Timed out/);
  assert.ok(Date.now() - t0 < 2000);
});

test('guardedLookup: a DNS answer that flips to a private IP at connect time is refused', async () => {
  let n = 0;
  const flipping = (_h: string, _o: { all: true }, cb: (e: NodeJS.ErrnoException | null, a: { address: string; family: number }[]) => void) => {
    n++;
    cb(null, [{ address: n === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }]);
  };
  const lookup = guardedLookup([], flipping);
  const call = () => new Promise<unknown>((resolve, reject) => lookup('flip.example', { all: true }, (err: unknown, addrs: unknown) => (err ? reject(err) : resolve(addrs))));
  assert.deepEqual(await call(), [{ address: '93.184.216.34', family: 4 }]);
  await assert.rejects(call(), /private address 127\.0\.0\.1/);
  // single-address form used by net.connect without `all`
  const single = guardedLookup([], (_h, _o, cb) => cb(null, [{ address: '8.8.8.8', family: 4 }]));
  const got = await new Promise((resolve) => single('x.example', {}, (_e: unknown, addr: unknown, fam: unknown) => resolve([addr, fam])));
  assert.deepEqual(got, ['8.8.8.8', 4]);
});
