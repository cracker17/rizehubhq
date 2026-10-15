// The operator's only HTTP listener (docs/17-OPERATOR.md "WhatsApp Business"): internal, no published port, reached
// by the dashboard on the Docker network (http://hq-operator:4200). Only WhatsApp's webhook for now:
//   GET  /hooks/whatsapp   Meta's verification handshake (hub.verify_token must equal OPERATOR_WHATSAPP_VERIFY_TOKEN)
//   POST /hooks/whatsapp   messages; X-Hub-Signature-256 checked with OPERATOR_WHATSAPP_APP_SECRET before anything else
// Started only when the app secret is set.
import http from 'node:http';
import { parseWebhook, verifyMetaSignature, type WaInbound } from './whatsapp';

export const HOOK_MAX_BYTES = 1_000_000;

export interface HookDeps {
  appSecret: string;
  verifyToken: string | null;
  ingest: (m: WaInbound) => Promise<string | null>;
  log?: (m: string) => void;
}

export interface HookReq { method: string; path: string; query: URLSearchParams; headers: Record<string, string | string[] | undefined>; body: Buffer }
export interface HookRes { status: number; body: string }

/** Pure-ish request handler (tested): decides the answer; ingest is the only side effect. */
export async function handleHook(d: HookDeps, r: HookReq): Promise<HookRes> {
  if (r.path !== '/hooks/whatsapp') return { status: 404, body: 'not found' };
  if (r.method === 'GET') {
    const ok = r.query.get('hub.mode') === 'subscribe' && !!d.verifyToken && r.query.get('hub.verify_token') === d.verifyToken;
    return ok ? { status: 200, body: r.query.get('hub.challenge') ?? '' } : { status: 403, body: 'forbidden' };
  }
  if (r.method !== 'POST') return { status: 405, body: 'method not allowed' };
  const sig = r.headers['x-hub-signature-256'];
  if (!verifyMetaSignature(r.body, Array.isArray(sig) ? sig[0] : sig, d.appSecret)) return { status: 401, body: 'bad signature' };
  let payload: unknown;
  try { payload = JSON.parse(r.body.toString('utf8')); } catch { return { status: 400, body: 'bad json' }; }
  let stored = 0;
  for (const m of parseWebhook(payload)) {
    try { if (await d.ingest(m)) stored++; }
    catch (e) { d.log?.(`[operator] whatsapp ingest failed: ${e instanceof Error ? e.message : e}`); return { status: 500, body: 'retry' }; } // Meta retries
  }
  if (stored) d.log?.(`[operator] whatsapp: ${stored} new message(s)`);
  return { status: 200, body: 'ok' };
}

export function startHookServer(d: HookDeps, port: number): http.Server {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []; let size = 0; let tooBig = false;
    req.on('data', (c: Buffer) => { size += c.length; if (size > HOOK_MAX_BYTES) { tooBig = true; req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (tooBig) return;
      const u = new URL(req.url ?? '/', 'http://hooks');
      handleHook(d, { method: req.method ?? 'GET', path: u.pathname, query: u.searchParams, headers: req.headers, body: Buffer.concat(chunks) })
        .then((r) => { res.writeHead(r.status, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); res.end(r.body); })
        .catch(() => { res.writeHead(500); res.end('error'); });
    });
  });
  server.listen(port, '0.0.0.0');
  return server;
}
