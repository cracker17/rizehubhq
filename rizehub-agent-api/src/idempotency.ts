// Idempotency-Key handling for writes (docs/12 "Conventions"). HQ sends `${taskId}:${step}` on every write and
// `${taskId}:${step}:dry_run` on dry runs. Same key + same request → replay the first response (status + body);
// same key + different request → 409 idempotency_conflict. Keys are scoped per API key; keep them ≥ 24 h.
import { createHash } from 'node:crypto';

export interface StoredResponse { fingerprint: string; status: number; body: unknown; createdAt: number }
export interface IdempotencyStore {
  get(scope: string, key: string): Promise<StoredResponse | null>;
  /** Must be atomic (INSERT … ON CONFLICT DO NOTHING); returns false if another request stored first. */
  put(scope: string, key: string, value: StoredResponse): Promise<boolean>;
}

export function requestFingerprint(method: string, path: string, dryRun: boolean, body: unknown): string {
  return createHash('sha256').update(`${method.toUpperCase()} ${path} ${dryRun} ${canonicalJson(body ?? null)}`).digest('hex');
}

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export type IdempotencyDecision =
  | { action: 'run' }
  | { action: 'replay'; status: number; body: unknown }
  | { action: 'conflict'; status: 409; body: { error: { code: 'idempotency_conflict'; message: string; retryable: false } } };

export async function checkIdempotency(store: IdempotencyStore, scope: string, key: string, fingerprint: string): Promise<IdempotencyDecision> {
  const prev = await store.get(scope, key);
  if (!prev) return { action: 'run' };
  if (prev.fingerprint !== fingerprint) {
    return { action: 'conflict', status: 409, body: { error: { code: 'idempotency_conflict', message: 'This Idempotency-Key was used with a different request', retryable: false } } };
  }
  return { action: 'replay', status: prev.status, body: prev.body };
}

/** Store the first result (only 2xx and 4xx: a 5xx should be retryable with the same key). */
export async function rememberResponse(store: IdempotencyStore, scope: string, key: string, fingerprint: string, status: number, body: unknown, now = Date.now()): Promise<void> {
  if (status >= 500) return;
  await store.put(scope, key, { fingerprint, status, body, createdAt: now });
}

/** In-memory store for tests and single-instance setups. */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private m = new Map<string, StoredResponse>();
  async get(scope: string, key: string) { return this.m.get(`${scope}|${key}`) ?? null; }
  async put(scope: string, key: string, v: StoredResponse) {
    const k = `${scope}|${key}`;
    if (this.m.has(k)) return false;
    this.m.set(k, v);
    return true;
  }
}
