// Tiny internal HTTP API for the dashboard: POST /chat, GET /health. Every request needs
// header x-hq-secret = HQ_INTERNAL_SECRET (checked in constant time). Not exposed publicly.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { errMsg } from './deps';

export const MAX_BODY_BYTES = 16 * 1024;

export interface HttpHandlers {
  chat(agentId: string, question: string): Promise<{ answer: string }>;
  health(): Record<string, unknown>;
}

export function secretMatches(given: string | undefined, expected: string): boolean {
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

export function createHttpServer(handlers: HttpHandlers, secret: string): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (!secret) return send(res, 503, { error: 'HQ_INTERNAL_SECRET is not configured' });
      const given = req.headers['x-hq-secret'];
      if (!secretMatches(Array.isArray(given) ? given[0] : given, secret)) return send(res, 401, { error: 'unauthorized' });

      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, ...handlers.health() });
      if (req.method === 'POST' && url.pathname === '/chat') {
        const body = (await readJson(req)) as { agentId?: unknown; question?: unknown };
        if (typeof body.agentId !== 'string' || !/^[a-z0-9-]{1,64}$/.test(body.agentId)) return send(res, 400, { error: 'agentId is required' });
        if (typeof body.question !== 'string' || !body.question.trim()) return send(res, 400, { error: 'question is required' });
        const { answer } = await handlers.chat(body.agentId, body.question);
        return send(res, 200, { answer });
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      const msg = errMsg(e);
      return send(res, /too large|invalid JSON/.test(msg) ? 400 : /Unknown agent/.test(msg) ? 404 : 500, { error: msg });
    }
  });
}
