// Brain API (internal; docs/16-BRAIN.md). Every route needs header x-brain-secret = BRAIN_INTERNAL_SECRET (constant-time
// compare) except POST /hooks/github, which checks GitHub's HMAC itself, and GET /livez (liveness, no data). Never published: the dashboard proxies
// the webhook (apps/dashboard/src/app/api/brain/github) and calls the rest server-side (lib/brainCall.ts).
import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Store } from './store/types';
import type { Embedder } from './index/embed';
import { toPgVector } from './index/embed';
import type { BrainService } from './service';

export const MAX_BODY_BYTES = 1024 * 1024;
export const DEFAULT_SEARCH_KINDS = ['memory', 'session', 'session_log', 'project_doc', 'profile', 'scheduled_task', 'prompt', 'command', 'readme', 'other'];

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

async function route(d: ApiDeps, req: http.IncomingMessage, url: URL): Promise<Result> {
  const q = url.searchParams;
  const p = url.pathname.replace(/\/+$/, '') || '/';
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
    let embedding: string | null = null;
    let semantic: string = d.embedder ? 'on' : 'off: no embeddings key';
    if (d.embedder) {
      try { embedding = toPgVector((await d.embedder.embed([text]))[0]); } catch (e) { semantic = `off: ${(e as Error).message.slice(0, 120)}`; }
    }
    // Raw Claude Code transcripts are indexed but left out unless asked for (?kind=transcript or ?kind=all): they are
    // long and noisy next to the curated memory, sessions and docs.
    const asked = (q.get('kind') ?? '').split(',').map((k) => k.trim()).filter((k) => /^[a-z_]{1,20}$/.test(k));
    const kinds = asked.includes('all') ? [] : asked.length ? asked : DEFAULT_SEARCH_KINDS;
    const results = await d.store.rpc('brain_search', {
      p_query: text, p_embedding: embedding, p_project: q.get('project') || null, p_kinds: kinds.length ? kinds : null,
      p_limit: clampInt(q.get('k'), 10, 1, 50),
    });
    return [200, { query: text, semantic, results }];
  }
  if (req.method === 'GET' && p === '/activity') return [200, { events: await d.store.rpc('brain_recent_events', { p_limit: clampInt(q.get('n'), 50, 1, 500) }) }];
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
      return send(await route(d, req, url));
    } catch (e) {
      const msg = (e as Error).message;
      if (!/too large/.test(msg)) d.log(`http ${req.method} ${req.url}: ${msg}`);
      return send([/too large/.test(msg) ? 413 : 500, { error: msg }]);
    }
  });
}
