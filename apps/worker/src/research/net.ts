// SSRF-safe HTTP for research/QA tools (docs/09). Every hop is checked: http/https only, no embedded
// credentials, no private/loopback/link-local/metadata targets (checked on the literal host AND on every
// address DNS returns), ≤3 redirects, a timeout and a body size cap. Production transport pins the
// check at connect time (guardedLookup) so a DNS answer that flips to a private IP is refused too.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';

export interface LookupAddress { address: string; family: number }
export type Lookup = (hostname: string) => Promise<LookupAddress[]>;
export type Transport = (url: string, init: { method: string; headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

export interface NetEnv {
  lookup: Lookup;
  /** Raw transport (no redirect following). Production: pinnedFetch. Tests: a fake. */
  transport: Transport;
  /** Hosts explicitly allowed even though they resolve privately (ALLOW_PRIVATE_URLS; local dev previews). */
  allowPrivateHosts: string[];
}

export class BlockedUrlError extends Error {}

const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const V6_BLOCKED: [string, number][] = [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['2001:db8::', 32],
  ['100::', 64], ['2001::', 32], ['2002::', 16],
];
const blockList = new net.BlockList();
for (const [a, p] of V4_BLOCKED) blockList.addSubnet(a, p, 'ipv4');
for (const [a, p] of V6_BLOCKED) blockList.addSubnet(a, p, 'ipv6');

/** Embedded IPv4 in IPv4-mapped (::ffff:a.b.c.d / ::ffff:7f00:1), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::/96). */
function embeddedV4(ip: string): string | null {
  const lower = ip.toLowerCase();
  const dotted = lower.match(/^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1]!;
  const hex = lower.match(/^(?:::ffff:|64:ff9b::|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1]!, 16); const lo = parseInt(hex[2]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  // Expanded forms (0:0:0:0:0:ffff:7f00:1): normalise through the block list check below.
  return null;
}

/** True for any non-public address (RFC 1918, loopback, link-local incl. 169.254.169.254, CGNAT, ULA, multicast…). */
export function isPrivateIp(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return blockList.check(ip, 'ipv4');
  if (kind === 6) {
    const v4 = embeddedV4(ip);
    if (v4) return isPrivateIp(v4);
    if (/^0{0,4}(:0{0,4}){4}:ffff:/i.test(ip) || /^(0{1,4}:){5}ffff:/i.test(ip)) return true; // expanded mapped forms: refuse
    return blockList.check(ip, 'ipv6');
  }
  return true; // not an IP at all → treat as unsafe
}

const BLOCKED_HOSTS = new Set(['localhost', 'metadata', 'metadata.google.internal', 'metadata.goog', 'instance-data',
  'instance-data.ec2.internal', 'metadata.azure.com', 'kubernetes.default', 'kubernetes.default.svc']);
const BLOCKED_SUFFIXES = ['.localhost', '.internal', '.local', '.localdomain', '.home.arpa', '.svc.cluster.local', '.cluster.local'];

export function bareHost(u: URL): string {
  return u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

/** Parses and checks a URL without DNS (scheme, credentials, blocked names, literal IPs). */
export function checkUrlShape(raw: string, allowPrivateHosts: readonly string[] = []): URL {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new BlockedUrlError(`Not a valid URL: ${raw.slice(0, 200)}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BlockedUrlError(`Only http/https URLs are allowed (got ${u.protocol}).`);
  if (u.username || u.password) throw new BlockedUrlError('URLs with embedded credentials are not allowed.');
  const host = bareHost(u);
  if (allowPrivateHosts.includes(host)) return u;
  if (!host) throw new BlockedUrlError('URL has no host.');
  if (BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new BlockedUrlError(`Blocked host ${host}: internal/metadata hosts are not reachable from research tools.`);
  }
  if (net.isIP(host) && isPrivateIp(host)) throw new BlockedUrlError(`Blocked address ${host}: private, loopback, link-local and metadata IPs are not allowed.`);
  if (!net.isIP(host) && !host.includes('.')) throw new BlockedUrlError(`Blocked host ${host}: single-label hostnames are internal.`);
  return u;
}

/** Full check: shape + every DNS answer must be public. Returns the parsed URL. */
export async function assertPublicUrl(raw: string, env: Pick<NetEnv, 'lookup' | 'allowPrivateHosts'>): Promise<URL> {
  const u = checkUrlShape(raw, env.allowPrivateHosts);
  const host = bareHost(u);
  if (env.allowPrivateHosts.includes(host) || net.isIP(host)) return u;
  let addrs: LookupAddress[];
  try { addrs = await env.lookup(host); } catch (e) {
    throw new BlockedUrlError(`DNS lookup failed for ${host}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!addrs.length) throw new BlockedUrlError(`DNS returned no address for ${host}.`);
  const bad = addrs.find((a) => isPrivateIp(a.address));
  if (bad) throw new BlockedUrlError(`Blocked: ${host} resolves to a private address (${bad.address}).`);
  return u;
}

export interface SafeFetchOptions {
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}
export interface SafeFetchResult {
  url: string;
  status: number;
  statusText: string;
  headers: Headers;
  body: Buffer;
  truncated: boolean;
  redirects: string[];
}

export const DEFAULT_UA = 'Mozilla/5.0 (compatible; RizeHubHQ-QA/1.0; +https://rizehub.ph)';

/** GET/HEAD a public URL: SSRF-checked on every hop, ≤maxRedirects (3), timeout (10 s), body cap (2 MB). */
export async function safeFetch(raw: string, env: NetEnv, o: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const timeoutMs = o.timeoutMs ?? 10_000;
  const maxBytes = o.maxBytes ?? 2 * 1024 * 1024;
  const maxRedirects = o.maxRedirects ?? 3;
  const signal = AbortSignal.timeout(timeoutMs);
  const redirects: string[] = [];
  let current = raw;
  let method = o.method ?? 'GET';
  for (let hop = 0; ; hop++) {
    const u = await assertPublicUrl(current, env);
    let res: Response;
    try {
      res = await env.transport(u.toString(), {
        method, signal,
        headers: { 'user-agent': DEFAULT_UA, accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', ...o.headers },
      });
    } catch (e) {
      if (signal.aborted) throw new Error(`Timed out after ${timeoutMs} ms fetching ${u.origin}${u.pathname}`);
      throw e;
    }
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      await res.body?.cancel().catch(() => undefined);
      if (hop >= maxRedirects) throw new Error(`Too many redirects (>${maxRedirects}) starting at ${raw}`);
      current = new URL(loc, u).toString();
      redirects.push(current);
      if (res.status === 303) method = 'GET';
      continue;
    }
    const { body, truncated } = method === 'HEAD' ? { body: Buffer.alloc(0), truncated: false } : await readCapped(res, maxBytes, signal, timeoutMs);
    return { url: u.toString(), status: res.status, statusText: res.statusText, headers: res.headers, body, truncated, redirects };
  }
}

async function readCapped(res: Response, maxBytes: number, signal: AbortSignal, timeoutMs: number): Promise<{ body: Buffer; truncated: boolean }> {
  const len = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(len) && len > maxBytes * 4) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`Response too large (${len} bytes > ${maxBytes} byte cap).`);
  }
  if (!res.body) return { body: Buffer.alloc(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new Error(`Timed out after ${timeoutMs} ms reading the response`);
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      if (total + buf.length > maxBytes) {
        chunks.push(buf.subarray(0, maxBytes - total));
        total = maxBytes;
        await reader.cancel().catch(() => undefined);
        return { body: Buffer.concat(chunks), truncated: true };
      }
      chunks.push(buf);
      total += buf.length;
    }
  } catch (e) {
    await reader.cancel().catch(() => undefined);
    if (signal.aborted) throw new Error(`Timed out after ${timeoutMs} ms reading the response`);
    throw e;
  }
  return { body: Buffer.concat(chunks), truncated: false };
}

// ---------- production transport ----------
type DnsLookupAll = (host: string, opts: { all: true }, cb: (err: NodeJS.ErrnoException | null, addrs: LookupAddress[]) => void) => void;

/** net `lookup` hook that refuses private answers at connect time (defeats DNS rebinding between check and connect). */
export function guardedLookup(allowPrivateHosts: readonly string[] = [], resolve: DnsLookupAll = dns.lookup as unknown as DnsLookupAll) {
  return (hostname: string, options: { all?: boolean } | number | undefined, cb: (...a: unknown[]) => void) => {
    const all = typeof options === 'object' && options !== null && options.all === true;
    resolve(hostname, { all: true }, (err, addrs) => {
      if (err) return cb(err);
      const host = hostname.toLowerCase();
      if (!allowPrivateHosts.includes(host)) {
        const bad = addrs.find((a) => isPrivateIp(a.address));
        if (bad) return cb(Object.assign(new BlockedUrlError(`Blocked: ${hostname} resolved to private address ${bad.address} at connect time`), { code: 'EBLOCKED' }));
      }
      if (!addrs.length) return cb(Object.assign(new Error(`No address for ${hostname}`), { code: 'ENOTFOUND' }));
      if (all) return cb(null, addrs);
      return cb(null, addrs[0]!.address, addrs[0]!.family);
    });
  };
}

/** node:http(s) transport with the guarded lookup, no redirects, transparent gzip/br/deflate decoding. */
export function pinnedTransport(allowPrivateHosts: readonly string[] = []): Transport {
  const lookup = guardedLookup(allowPrivateHosts);
  return (url, init) => new Promise<Response>((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: init.method, headers: { 'accept-encoding': 'gzip, deflate, br', ...init.headers },
      lookup: lookup as unknown as net.LookupFunction, signal: init.signal, agent: false,
    }, (res) => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (v === undefined) continue;
        for (const x of Array.isArray(v) ? v : [v]) headers.append(k, x);
      }
      const status = res.statusCode ?? 502;
      const enc = (res.headers['content-encoding'] ?? '').toLowerCase();
      let stream: Readable = res;
      if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      if (stream !== res) { headers.delete('content-encoding'); headers.delete('content-length'); }
      const noBody = init.method === 'HEAD' || status === 204 || status === 304 || status < 200;
      if (noBody) res.resume();
      try {
        resolve(new Response(noBody ? null : (Readable.toWeb(stream) as ReadableStream), {
          status: status < 200 ? 502 : status, statusText: res.statusMessage ?? '', headers,
        }));
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
    req.end();
  });
}

export const systemLookup: Lookup = async (host) => {
  const r = await dns.promises.lookup(host, { all: true, verbatim: true });
  return r.map((a) => ({ address: a.address, family: a.family }));
};

export function allowPrivateFromEnv(): string[] {
  return (process.env.ALLOW_PRIVATE_URLS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function defaultNetEnv(): NetEnv {
  const allow = allowPrivateFromEnv();
  return { lookup: systemLookup, transport: pinnedTransport(allow), allowPrivateHosts: allow };
}
