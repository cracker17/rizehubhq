import 'server-only';
import { brainEnv } from '@/lib/env';

/** GET/POST the brain service's internal API (x-brain-secret; docs/16-BRAIN.md). status 0 = not configured or unreachable. */
export async function callBrain<T>(path: string, init: { method?: 'GET' | 'POST'; timeoutMs?: number; body?: unknown } = {}): Promise<{ status: number; body: T & { error?: string } } | { status: 0; body: { error: string } }> {
  const brain = brainEnv();
  if (!brain) return { status: 0, body: { error: 'The brain is not configured (BRAIN_URL / BRAIN_INTERNAL_SECRET).' } };
  try {
    const res = await fetch(`${brain.url}${path}`, {
      method: init.method ?? 'GET', cache: 'no-store', signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
      headers: { 'x-brain-secret': brain.secret, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    return { status: res.status, body: (await res.json().catch(() => ({ error: `Brain answered ${res.status}` }))) as T & { error?: string } };
  } catch {
    return { status: 0, body: { error: 'Could not reach the brain service. Is it running?' } };
  }
}
