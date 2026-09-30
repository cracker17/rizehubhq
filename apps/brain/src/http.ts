// Brain API (internal; docs/16-BRAIN.md). Every route needs header x-brain-secret = BRAIN_INTERNAL_SECRET (constant-time
// compare) except POST /hooks/github, which checks GitHub's HMAC itself, and GET /livez (liveness, no data). Never published: the dashboard proxies
// the webhook (apps/dashboard/src/app/api/brain/github) and calls the rest server-side (lib/brainCall.ts).
import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Store } from './store/types';
import type { Embedder } from './index/embed';
import type { BrainService } from './service';
import { search } from './queries';
import { clientCheck, issueCode, register, revoke, token, type OAuthDeps } from './oauth/server';
import { handleMcpPost, MCP_MAX_BODY } from './mcp/server';
import { createProjectOp, updateMemoryOp, WriteError, type NewProject } from './write/vault';

export const MAX_BODY_BYTES = 1024 * 1024;
export { DEFAULT_SEARCH_KINDS } from './queries';

export function secretMatches(given: string | undefined, expected: string): boolean {
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** GitHub: X-Hub-Signature-256 = "sha256=" + hex HMAC-SHA256(secret, raw body). */
export function githubSignatureOk(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!secret || !header?.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return secretMatches(header, expected);
}

export interface ApiDeps {
  store: Store;
  embedder: Embedder | null;
  service: BrainService;
  internalSecret: string;
  webhookSecret: string;
  branch: string;
  log: (msg: string) => void;
  /** the vault clone (setup kit files) */
  vaultDir: string;
  /** extra https redirect hosts for OAuth clients (BRAIN_OAUTH_REDIRECT_HOSTS) */
  redirectHosts: readonly string[];
}

type Result = [number, unknown];
const header = (req: http.IncomingMessage, name: string) => { const v = req.headers[name]; return Array.isArray(v) ? v[0] : v; };
const clampInt = (v: string | null, def: number, min: number, max: number) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

function readRaw(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function githubHook(d: ApiDeps, req: http.IncomingMessage, raw: Buffer): Promise<Result> {
  if (!d.webhookSecret) return [503, { error: 'BRAIN_WEBHOOK_SECRET is not configured' }];
  if (!githubSignatureOk(raw, header(req, 'x-hub-signature-256'), d.webhookSecret)) return [401, { error: 'bad signature' }];
  const event = header(req, 'x-github-event');
  if (event === 'ping') return [200, { ok: true, pong: true }];
  if (event !== 'push') return [202, { ok: true, ignored: event ?? 'unknown event' }];
  let payload: { ref?: string; pusher?: { name?: string }; head_commit?: { id?: string } };
  try { payload = JSON.parse(raw.toString('utf8')); } catch { return [400, { error: 'invalid JSON' }]; }
  if (payload.ref !== `refs/heads/${d.branch}`) return [202, { ok: true, ignored: payload.ref ?? 'no ref' }];
  const pusher = (payload.pusher?.name ?? '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40);
  await d.store.rpc('brain_set_sync_state', { p: { last_webhook_at: new Date().toISOString() } });
  d.service.trigger({ reason: `webhook ${payload.head_commit?.id?.slice(0, 7) ?? ''}`.trim(), actor: pusher ? `github:${pusher}` : 'github' });
  return [202, { ok: true, queued: true }];
}

/** Form (application/x-www-form-urlencoded, the OAuth default) or JSON body → flat fields. */
export function parseFields(req: http.IncomingMessage, raw: Buffer): Record<string, unknown> {
  const type = (header(req, 'content-type') ?? '').toLowerCase();
  const text = raw.toString('utf8');
  if (type.includes('application/json')) {
    const v = JSON.parse(text || '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  }
  return Object.fromEntries(new URLSearchParams(text));
}

async function route(d: ApiDeps, req: http.IncomingMessage, url: URL, res: http.ServerResponse): Promise<Result | null> {
  const q = url.searchParams;
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const oauth: OAuthDeps = { store: d.store, redirectHosts: d.redirectHosts, log: d.log };
  if (req.method === 'POST' && p.startsWith('/oauth/')) {
    let fields: Record<string, unknown>;
    try { fields = parseFields(req, await readRaw(req, 64 * 1024)); } catch (e) {
      if (/too large/.test((e as Error).message)) throw e;
      return [400, { error: 'invalid_request', error_description: 'body is not valid JSON or form data' }];
    }
    if (p === '/oauth/register') return register(oauth, fields);
    if (p === '/oauth/code') return issueCode(oauth, fields);
    if (p === '/oauth/token') return token(oauth, fields);
    if (p === '/oauth/revoke') return revoke(oauth, fields);
  }
  if (req.method === 'GET' && p === '/oauth/client') return clientCheck(oauth, q.get('client_id'), q.get('redirect_uri'));
  if (p === '/mcp') {
    if (req.method !== 'POST') return [405, { error: 'no server-initiated stream; POST JSON-RPC to /mcp' }];
    const r = await handleMcpPost({ store: d.store, embedder: d.embedder, service: d.service, vaultDir: d.vaultDir, log: d.log },
      header(req, 'authorization'), await readRaw(req, MCP_MAX_BODY + 1));
    if (r.status === 202) { res.writeHead(202, { 'cache-control': 'no-store' }); res.end(); return null; }
    return [r.status, r.body];
  }
  if (req.method === 'GET' && p === '/health') {
    const db = await d.store.rpc<Record<string, unknown>>('brain_health');
    const s = d.service.status();
    return [200, {
      ok: !s.lastError, ...db, embeddings: d.embedder ? d.embedder.model : null,
      degraded: { keyword_only: !d.embedder }, running: s.running, last_run_at: s.lastRunAt, last_error: s.lastError,
      last_report: s.lastReport && { ...s.lastReport, added: s.lastReport.added.length, changed: s.lastReport.changed.length, removed: s.lastReport.removed.length },
    }];
  }
  if (req.method === 'GET' && p === '/projects') return [200, { projects: await d.store.rpc('brain_list_projects') }];
  const pm = /^\/projects\/([a-z0-9][a-z0-9-]{0,63})$/.exec(p);
  if (req.method === 'GET' && pm) {
    const bundle = await d.store.rpc('brain_project_bundle', { p_slug: pm[1], p_sessions: clampInt(q.get('sessions'), 2, 0, 20) });
    return bundle ? [200, bundle] : [404, { error: `unknown project ${pm[1]}` }];
  }
  if (req.method === 'GET' && p === '/documents') {
    const docPath = q.get('path') ?? '';
    if (!docPath || docPath.length > 400) return [400, { error: 'path is required' }];
    const doc = await d.store.rpc('brain_get_document', { p_path: docPath });
    return doc ? [200, doc] : [404, { error: 'not found' }];
  }
  if (req.method === 'GET' && p === '/search') {
    const text = (q.get('q') ?? '').trim().slice(0, 500);
    if (!text) return [400, { error: 'q is required' }];
    const kinds = (q.get('kind') ?? '').split(',').map((k) => k.trim()).filter(Boolean);
    return [200, await search(d, { q: text, project: q.get('project'), kinds, k: clampInt(q.get('k'), 10, 1, 50) })];
  }
  if (req.method === 'GET' && p === '/activity') return [200, { events: await d.store.rpc('brain_recent_events', { p_limit: clampInt(q.get('n'), 50, 1, 500) }) }];
  // Dashboard writes (M14.3 /brain UI): the CEO's own edits, attributed to "julev". Same write path as the connector.
  if (req.method === 'POST' && (p === '/write/project' || p === '/write/memory')) {
    let b: Record<string, unknown>;
    try { b = JSON.parse((await readRaw(req, 64 * 1024)).toString('utf8') || '{}'); } catch { return [400, { error: 'invalid JSON' }]; }
    try {
      const op = p === '/write/project' ? createProjectOp(b as unknown as NewProject) : updateMemoryOp(String(b.project ?? ''), b);
      const r = await d.service.write(op, 'julev');
      return [200, { ok: true, project: r.project, paths: r.paths, summary: r.summary, sha: r.sha }];
    } catch (e) {
      if (e instanceof WriteError) return [400, { error: e.message }];
      throw e;
    }
  }
  if (req.method === 'POST' && p === '/reindex') {
    const report = await d.service.sync({ reason: 'reindex', actor: 'brain-service', full: q.get('full') === '1' });
    return [200, { ok: true, report }];
  }
  return [404, { error: 'not found' }];
}

export function createHttpServer(d: ApiDeps): http.Server {
  return http.createServer(async (req, res) => {
    const send = ([status, body]: Result) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'POST' && url.pathname === '/hooks/github') return send(await githubHook(d, req, await readRaw(req, MAX_BODY_BYTES)));
      // Container liveness only (Docker HEALTHCHECK): the process serves HTTP. Says nothing else, needs no secret.
      // A failing sync (no deploy key yet, DB down) must not mark the container unhealthy: update.sh would roll back the stack.
      if (req.method === 'GET' && url.pathname === '/livez') return send([200, { ok: true }]);
      if (!d.internalSecret) return send([503, { error: 'BRAIN_INTERNAL_SECRET is not configured' }]);
      if (!secretMatches(header(req, 'x-brain-secret'), d.internalSecret)) return send([401, { error: 'unauthorized' }]);
      const r = await route(d, req, url, res);
      if (r) send(r);
      return;
    } catch (e) {
      const msg = (e as Error).message;
      if (!/too large/.test(msg)) d.log(`http ${req.method} ${req.url}: ${msg}`);
      return send([/too large/.test(msg) ? 413 : 500, { error: msg }]);
    }
  });
}
