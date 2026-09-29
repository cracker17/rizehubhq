import 'server-only';
import { workerEnv } from '@/lib/env';

/** POST JSON to the worker's internal API (x-hq-secret). status 0 = not configured or unreachable. */
export async function callWorker<T>(path: string, body: unknown, timeoutMs = 30_000): Promise<{ status: number; body: T & { error?: string } } | { status: 0; body: { error: string } }> {
  const worker = workerEnv();
  if (!worker) return { status: 0, body: { error: 'The worker is not configured (HQ_WORKER_URL / HQ_INTERNAL_SECRET).' } };
  try {
    const res = await fetch(`${worker.url}${path}`, {
      method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', 'x-hq-secret': worker.secret },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => ({ error: `Worker answered ${res.status}` }))) as T & { error?: string } };
  } catch {
    return { status: 0, body: { error: 'Could not reach the worker. Is it running?' } };
  }
}
