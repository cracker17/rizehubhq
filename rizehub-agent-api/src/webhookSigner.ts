// Webhook signer (RizeHub → HQ, docs/12 "Webhooks"). HQ verifies:
//   X-RizeHub-Signature: hex HMAC-SHA256(RIZEHUB_WEBHOOK_SECRET, raw body)   ("sha256=" prefix optional)
//   X-RizeHub-Timestamp: unix seconds of this delivery attempt (HQ rejects > 5 minutes off)
// Body: { "id": "evt_…" (unique, reused on retries), "event": "job.completed", "created_at": ISO, "data": {…} }.
// HQ is idempotent by `id`, so retrying the same event is always safe.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface WebhookEvent { id: string; event: string; created_at: string; data: Record<string, unknown> }

export function newEvent(event: string, data: Record<string, unknown>, now = new Date()): WebhookEvent {
  return { id: `evt_${randomBytes(12).toString('hex')}`, event, created_at: now.toISOString(), data };
}

export function signBody(rawBody: string | Uint8Array, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/** Serialize once and sign exactly those bytes. */
export function signWebhook(e: WebhookEvent, secret: string, now = Date.now()): { body: string; headers: Record<string, string> } {
  if (!secret) throw new Error('webhook secret is required');
  const body = JSON.stringify(e);
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'x-rizehub-signature': signBody(body, secret),
      'x-rizehub-timestamp': String(Math.floor(now / 1000)),
      'x-rizehub-event': e.event,
    },
  };
}

/** Same check HQ runs (useful for your own tests). */
export function verifyWebhook(rawBody: string | Uint8Array, signature: string, timestamp: string, secret: string, now = Date.now(), toleranceSec = 300): boolean {
  const sig = signature.replace(/^sha256=/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sig) || !/^\d{9,11}$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > toleranceSec) return false;
  const a = Buffer.from(signBody(rawBody, secret), 'hex');
  const b = Buffer.from(sig, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface DeliveryResult { ok: boolean; attempts: number; status: number | null; error?: string }
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

/**
 * Deliver with retries: 2xx = done; 4xx (except 408/429) = stop (HQ rejected it: check the secret/clock); 5xx/network = retry
 * with backoff. Re-signs each attempt (fresh timestamp), same event id. Run it from your job queue, not in the request.
 */
export async function deliverWebhook(url: string, e: WebhookEvent, secret: string, o: {
  fetch?: FetchLike; maxAttempts?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number;
} = {}): Promise<DeliveryResult> {
  const f: FetchLike = o.fetch ?? ((u, init) => fetch(u, init));
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const max = o.maxAttempts ?? 6;
  let last: DeliveryResult = { ok: false, attempts: 0, status: null };
  for (let attempt = 1; attempt <= max; attempt++) {
    const { body, headers } = signWebhook(e, secret, (o.now ?? Date.now)());
    try {
      const res = await f(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
      last = { ok: res.ok, attempts: attempt, status: res.status };
      if (res.ok) return last;
      if (res.status < 500 && res.status !== 408 && res.status !== 429) return last;
    } catch (err) {
      last = { ok: false, attempts: attempt, status: null, error: err instanceof Error ? err.message : String(err) };
    }
    if (attempt < max) await sleep((o.baseDelayMs ?? 1_000) * 2 ** (attempt - 1));
  }
  return last;
}
