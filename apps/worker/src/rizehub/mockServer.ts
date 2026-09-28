// Standalone mock RizeHub (`pnpm --filter worker mock:rizehub`): the Agent API contract on :8080 so the RizeHub team
// can see every endpoint, header, error and webhook working, and HQ can run end to end without the real app.
//   RIZEHUB_API_URL=http://localhost:8080/agent-api/v1  (worker env; keys printed on start)
//   HQ_WEBHOOK_URL=http://localhost:4000/hooks/rizehub + RIZEHUB_WEBHOOK_SECRET → signed webhooks are delivered
//   POST /_mock/events {"event":"client.signed_up","data":{...}} emits any webhook (demo); GET /_mock/audit shows the audit log.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { API_PREFIX, type KeyGroup, type WebhookEvent } from './contract';
import { MOCK_KEYS, MockRizehub } from './mock';
import { webhookHeaders } from './webhook';

export interface MockServerOptions {
  port?: number;
  host?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  jobDelayMs?: number;
  keys?: Partial<Record<KeyGroup, string>>;
  log?: (msg: string) => void;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
function page(title: string, body: string) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#0b0a1f;color:#f3f2ff}main{max-width:760px;margin:0 auto;padding:24px 16px}
h1{font-size:22px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #2c2863;padding:6px 4px;text-align:left}.m{color:#a09cc9}</style>
<main><p class="m">RizeHub (mock)</p>${body}</main>`;
}

export function startMockServer(o: MockServerOptions = {}): { server: http.Server; mock: MockRizehub; ready: Promise<number> } {
  const logf = o.log ?? ((m: string) => console.log(m));
  const deliver = async (e: WebhookEvent) => {
    if (!o.webhookUrl || !o.webhookSecret) return;
    const raw = JSON.stringify(e);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(o.webhookUrl, { method: 'POST', headers: webhookHeaders(raw, o.webhookSecret), body: raw, signal: AbortSignal.timeout(5_000) });
        logf(`[mock-rizehub] webhook ${e.event} → ${res.status}`);
        if (res.ok) return;
      } catch (err) { logf(`[mock-rizehub] webhook ${e.event} failed: ${err instanceof Error ? err.message : String(err)}`); }
      await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  };
  const mock = new MockRizehub({ keys: o.keys, jobDelayMs: o.jobDelayMs ?? 2_000, appUrl: `http://localhost:${o.port ?? 8080}`, onEvent: (e) => { void deliver(e); } });
  const tick = setInterval(() => mock.completeDueJobs(), 250);
  tick.unref();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
      res.end(JSON.stringify(body));
    };
    const html = (s: string, status = 200) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); res.end(s); };
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) { size += (c as Buffer).length; if (size > 1_000_000) return send(413, { error: { code: 'too_large', message: 'Body too large', retryable: false } }); chunks.push(c as Buffer); }
      const rawBody = Buffer.concat(chunks).toString('utf8');

      if (url.pathname.startsWith(API_PREFIX)) {
        let body: unknown = null;
        if (rawBody) { try { body = JSON.parse(rawBody); } catch { return send(400, { error: { code: 'invalid_json', message: 'Body is not JSON', retryable: false } }); } }
        const headers: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
        const r = await mock.handle({ method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, headers, body });
        logf(`[mock-rizehub] ${req.method} ${url.pathname}${url.search} ← ${headers['x-hq-agent-id'] ?? '-'} · ${r.status}`);
        return send(r.status, r.body, r.headers);
      }
      if (url.pathname === '/health') return send(200, { ok: true, mock: true });
      if (url.pathname === '/_mock/audit') return send(200, { audit: mock.audit.slice(-200) });
      if (url.pathname === '/_mock/events' && req.method === 'POST') {
        const remote = req.socket.remoteAddress ?? '';
        if (!/^(::1|127\.|::ffff:127\.)/.test(remote)) return send(403, { error: 'localhost only' });
        let b: { event?: string; data?: Record<string, unknown> };
        try { b = JSON.parse(rawBody || '{}'); } catch { return send(400, { error: 'invalid JSON' }); }
        if (!b.event) return send(400, { error: 'event is required' });
        return send(200, mock.simulate(b.event, b.data ?? {}));
      }
      let m = url.pathname.match(/^\/preview\/reports\/([A-Za-z0-9_-]+)$/);
      if (m) {
        const r = mock.reports.get(m[1]!);
        if (!r) return html(page('Not found', '<h1>Report not found</h1>'), 404);
        const rows = Object.entries(r.data.metrics).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td><td class="m">${esc((r.data.previous as unknown as Record<string, number>)[k])}</td></tr>`).join('');
        return html(page(`Report ${r.id}`, `<h1>${esc(r.type)} · ${esc(r.period.from)} → ${esc(r.period.to)}</h1><p class="m">Status: ${esc(r.status)}</p>
          ${r.notes ? `<h2>Summary</h2><p>${esc(r.notes.summary)}</p>` : ''}<table><tr><th>Metric</th><th>This period</th><th>Previous</th></tr>${rows}</table>`));
      }
      m = url.pathname.match(/^\/app\/lead-finder\/leads\/([A-Za-z0-9_-]+)$/);
      if (m) {
        const l = mock.leads.get(m[1]!);
        if (!l) return html(page('Not found', '<h1>Lead not found</h1>'), 404);
        return html(page(l.company, `<h1>${esc(l.company)}</h1><p><a style="color:#7c5cff" href="${esc(l.website)}">${esc(l.website)}</a> · ${esc(l.platform)} · ${esc(l.location.country)}</p>
          <p class="m">Stage: ${esc(l.stage)} · Lead Finder score ${esc(l.score)}${l.fit_score !== null ? ` · fit ${esc(l.fit_score)}` : ''}</p>
          <ul>${l.signals.map((s) => `<li>${esc(s.label)}${s.value ? `: ${esc(s.value)}` : ''}</li>`).join('')}</ul>`));
      }
      return send(404, { error: { code: 'not_found', message: `No route ${req.method} ${url.pathname}`, retryable: false } });
    } catch (e) {
      return send(500, { error: { code: 'internal', message: e instanceof Error ? e.message : String(e), retryable: true } });
    }
  });
  server.on('close', () => clearInterval(tick));
  const ready = new Promise<number>((resolve) => {
    server.listen(o.port ?? 8080, o.host ?? '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : o.port ?? 8080);
    });
  });
  return { server, mock, ready };
}

// ---------- CLI ----------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.MOCK_RIZEHUB_PORT ?? 8080);
  const secret = process.env.RIZEHUB_WEBHOOK_SECRET ?? '';
  const webhookUrl = process.env.HQ_WEBHOOK_URL ?? (secret ? 'http://localhost:4000/hooks/rizehub' : '');
  const keys: Partial<Record<KeyGroup, string>> = {};
  for (const g of ['LEADS', 'ONBOARDING', 'REPORTS', 'READONLY'] as KeyGroup[]) if (process.env[`RIZEHUB_KEY_${g}`]) keys[g] = process.env[`RIZEHUB_KEY_${g}`]!;
  const { ready } = startMockServer({ port, host: process.env.MOCK_RIZEHUB_HOST ?? '0.0.0.0', webhookUrl, webhookSecret: secret, keys });
  void ready.then((p) => {
    console.log(`[mock-rizehub] Agent API on http://localhost:${p}${API_PREFIX}`);
    console.log(`[mock-rizehub] keys: ${Object.entries(MOCK_KEYS).map(([g, k]) => `${g}=${keys[g as KeyGroup] ?? k}`).join('  ')}`);
    console.log(webhookUrl && secret ? `[mock-rizehub] webhooks → ${webhookUrl} (signed)` : '[mock-rizehub] webhooks off (set RIZEHUB_WEBHOOK_SECRET and HQ_WEBHOOK_URL)');
  });
}
