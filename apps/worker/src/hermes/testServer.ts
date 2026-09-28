// Test helper: a local HTTP server standing in for a Hermes API server (no network beyond 127.0.0.1).
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SeenRequest { method: string; path: string; headers: http.IncomingHttpHeaders; body: unknown }
export type MockHandler = (req: SeenRequest) => Promise<[number, unknown] | 'hang'> | [number, unknown] | 'hang';

export async function startMockHermes(handler: MockHandler): Promise<{ url: string; seen: SeenRequest[]; close: () => Promise<void> }> {
  const seen: SeenRequest[] = [];
  const open = new Set<http.ServerResponse>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = raw;
      try { body = raw ? JSON.parse(raw) : null; } catch { /* keep raw */ }
      const s: SeenRequest = { method: req.method ?? 'GET', path: req.url ?? '/', headers: req.headers, body };
      seen.push(s);
      try {
        const r = await handler(s);
        if (r === 'hang') { open.add(res); return; }
        res.writeHead(r[0], { 'content-type': 'application/json' });
        res.end(typeof r[1] === 'string' ? r[1] : JSON.stringify(r[1]));
      } catch (e) {
        res.writeHead(500); res.end(String(e));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url, seen,
    close: () => new Promise<void>((r) => { for (const res of open) res.destroy(); server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

/** An OpenAI chat.completion body. */
export function completion(text: string, usage = { prompt_tokens: 1000, completion_tokens: 200 }, model = 'claude-sonnet-5') {
  return { id: 'chatcmpl-1', object: 'chat.completion', model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }], usage };
}

/** A port nothing listens on (bound then closed). */
export async function deadUrl(): Promise<string> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}`;
}
