// Agent API auth middleware (framework-agnostic). Wire it in front of every /agent-api/v1 route:
//   const r = await authenticateAgentRequest({ method, path, headers }, deps);
//   if (!r.ok) return respond(r.status, { error: r.error }, r.headers);
//   ... handler runs with r.key (scopes, label) and r.hq (taskId, agentId) ...
// Rules (docs/12): hashed keys with scopes, revocable per key, last_used_at, X-HQ-Task-Id / X-HQ-Agent-Id required and
// written to the audit log, scope check per route, per-key rate limit with X-RateLimit-* headers, Idempotency-Key on writes.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hasScope, matchRoute, type RouteScope } from './scopes.ts';

export interface ApiKeyRecord {
  id: string;
  label: string;                  // "hq-leads" — shows up in the audit log
  keyHash: string;                // sha256 hex of the full key; the key itself is never stored
  scopes: string[];
  revokedAt: string | null;
  lastUsedAt: string | null;
}

/** Your storage (agent_api_keys table). */
export interface KeyStore {
  findByHash(keyHash: string): Promise<ApiKeyRecord | null>;
  touch(id: string, at: Date): Promise<void>;           // update last_used_at (fire-and-forget is fine)
}

export interface AuditEntry {
  at: string; keyId: string | null; keyLabel: string | null; method: string; path: string;
  hqTaskId: string | null; hqAgentId: string | null; dryRun: boolean; idempotencyKey: string | null;
  outcome: 'allowed' | 'unauthorized' | 'forbidden' | 'bad_request' | 'rate_limited' | 'not_found';
}
export interface AuditSink { record(e: AuditEntry): Promise<void> | void }

export interface RateLimiter { hit(keyId: string, now: number): { allowed: boolean; limit: number; remaining: number; resetSec: number } }

export interface ApiError { code: string; message: string; retryable: boolean }
export type AuthResult =
  | { ok: true; key: ApiKeyRecord; route: RouteScope; hq: { taskId: string; agentId: string }; dryRun: boolean; idempotencyKey: string | null; headers: Record<string, string> }
  | { ok: false; status: number; error: ApiError; headers: Record<string, string> };

export interface AgentRequest { method: string; path: string; query?: URLSearchParams; headers: Record<string, string | string[] | undefined> }

export interface AuthDeps { keys: KeyStore; audit: AuditSink; rateLimiter: RateLimiter; now?: () => Date }

// ---------- keys ----------
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}
/** New key for one agent group: show it once to the admin, store only the hash. */
export function generateApiKey(prefix = 'rzh_live'): { key: string; keyHash: string } {
  const key = `${prefix}_${randomBytes(24).toString('base64url')}`;
  return { key, keyHash: hashApiKey(key) };
}
export function hashesEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex'); const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

// ---------- rate limit ----------
/** Fixed window per key. Swap for Redis in production if you run several RizeHub instances. */
export class FixedWindowRateLimiter implements RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  constructor(limit = 120, windowMs = 60_000) { this.limit = limit; this.windowMs = windowMs; }
  hit(keyId: string, now: number) {
    let w = this.windows.get(keyId);
    if (!w || now - w.start >= this.windowMs) { w = { start: now, count: 0 }; this.windows.set(keyId, w); }
    w.count++;
    return { allowed: w.count <= this.limit, limit: this.limit, remaining: Math.max(0, this.limit - w.count), resetSec: Math.ceil((w.start + this.windowMs - now) / 1000) };
  }
}

// ---------- middleware ----------
const header = (h: AgentRequest['headers'], name: string): string | null => {
  const v = h[name] ?? h[name.toLowerCase()];
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() ? s.trim() : null;
};
const HQ_ID = /^[A-Za-z0-9_.:-]{1,100}$/;

export async function authenticateAgentRequest(req: AgentRequest, deps: AuthDeps): Promise<AuthResult> {
  const now = (deps.now ?? (() => new Date()))();
  const path = req.path.replace(/^\/agent-api\/v1/, '') || '/';
  const dryRun = req.query?.get('dry_run') === 'true';
  const idem = header(req.headers, 'idempotency-key');
  const taskId = header(req.headers, 'x-hq-task-id');
  const agentId = header(req.headers, 'x-hq-agent-id');
  const base = { at: now.toISOString(), method: req.method.toUpperCase(), path, hqTaskId: taskId, hqAgentId: agentId, dryRun, idempotencyKey: idem };
  const fail = async (status: number, code: string, message: string, outcome: AuditEntry['outcome'], key: ApiKeyRecord | null, headers: Record<string, string> = {}, retryable = false): Promise<AuthResult> => {
    await deps.audit.record({ ...base, keyId: key?.id ?? null, keyLabel: key?.label ?? null, outcome });
    return { ok: false, status, error: { code, message, retryable }, headers };
  };

  const auth = header(req.headers, 'authorization');
  const presented = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!presented) return fail(401, 'unauthorized', 'Missing API key (Authorization: Bearer <key>)', 'unauthorized', null);
  const key = await deps.keys.findByHash(hashApiKey(presented));
  if (!key || !hashesEqual(key.keyHash, hashApiKey(presented))) return fail(401, 'unauthorized', 'Unknown API key', 'unauthorized', null);
  if (key.revokedAt) return fail(401, 'unauthorized', 'This key was revoked', 'unauthorized', key);
  void Promise.resolve(deps.keys.touch(key.id, now)).catch(() => undefined);

  if (!taskId || !agentId || !HQ_ID.test(taskId) || !HQ_ID.test(agentId)) {
    return fail(400, 'missing_hq_headers', 'X-HQ-Task-Id and X-HQ-Agent-Id are required (letters, digits, _ . : -)', 'bad_request', key);
  }
  const rl = deps.rateLimiter.hit(key.id, now.getTime());
  const rlHeaders = { 'x-ratelimit-limit': String(rl.limit), 'x-ratelimit-remaining': String(rl.remaining), 'x-ratelimit-reset': String(rl.resetSec) };
  if (!rl.allowed) return fail(429, 'rate_limited', 'Too many requests for this key', 'rate_limited', key, { ...rlHeaders, 'retry-after': String(rl.resetSec) }, true);

  const route = matchRoute(req.method, path);
  if (!route) return fail(404, 'not_found', `No route ${req.method.toUpperCase()} ${path}`, 'not_found', key, rlHeaders);
  if (!hasScope(key.scopes, route.scope)) return fail(403, 'forbidden', `Key "${key.label}" lacks scope ${route.scope}`, 'forbidden', key, rlHeaders);
  if (route.write && !idem) return fail(400, 'missing_idempotency_key', 'Idempotency-Key header is required on writes', 'bad_request', key, rlHeaders);
  if (idem && idem.length > 255) return fail(400, 'bad_idempotency_key', 'Idempotency-Key is longer than 255 characters', 'bad_request', key, rlHeaders);

  await deps.audit.record({ ...base, keyId: key.id, keyLabel: key.label, outcome: 'allowed' });
  return { ok: true, key, route, hq: { taskId, agentId }, dryRun, idempotencyKey: idem, headers: rlHeaders };
}

/** Error body every endpoint uses. */
export function errorBody(code: string, message: string, retryable = false): { error: ApiError } {
  return { error: { code, message, retryable } };
}
