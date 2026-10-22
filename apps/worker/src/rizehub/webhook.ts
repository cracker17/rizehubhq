// Webhook signatures (RizeHub → HQ). X-RizeHub-Signature = hex HMAC-SHA256(RIZEHUB_WEBHOOK_SECRET, rawBody)
// ("sha256=" prefix optional); X-RizeHub-Timestamp = unix seconds, rejected when more than 5 minutes off.
// The event body carries `id` (idempotency) and `created_at`, both covered by the signature.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-rizehub-signature';
export const TIMESTAMP_HEADER = 'x-rizehub-timestamp';
export const TOLERANCE_SEC = 300;

export function signRizehubBody(rawBody: string | Buffer, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export interface SignatureNames { signature: string; timestamp: string; secretName: string }
const RIZEHUB_NAMES: SignatureNames = { signature: SIGNATURE_HEADER, timestamp: TIMESTAMP_HEADER, secretName: 'RIZEHUB_WEBHOOK_SECRET' };

export function verifyRizehubSignature(
  rawBody: Buffer, headers: Record<string, string | string[] | undefined>, secret: string, nowMs = Date.now(),
): VerifyResult {
  return verifyHmacSignature(rawBody, headers, secret, nowMs, RIZEHUB_NAMES);
}

/** The same scheme under other header names (e.g. /hooks/notify: X-HQ-Signature + X-HQ-Timestamp, HQ_NOTIFY_SECRET). */
export function verifyHmacSignature(
  rawBody: Buffer, headers: Record<string, string | string[] | undefined>, secret: string, nowMs: number, names: SignatureNames,
): VerifyResult {
  if (!secret) return { ok: false, reason: `${names.secretName} is not configured` };
  const h = (n: string) => { const v = headers[n]; return (Array.isArray(v) ? v[0] : v)?.trim() ?? ''; };
  const sig = h(names.signature).replace(/^sha256=/i, '').toLowerCase();
  const ts = h(names.timestamp);
  if (!sig) return { ok: false, reason: 'missing signature' };
  if (!/^\d{9,11}$/.test(ts)) return { ok: false, reason: 'missing or invalid timestamp' };
  if (Math.abs(nowMs / 1000 - Number(ts)) > TOLERANCE_SEC) return { ok: false, reason: 'timestamp outside the 5 minute window' };
  if (!/^[0-9a-f]{64}$/.test(sig)) return { ok: false, reason: 'malformed signature' };
  const expected = Buffer.from(signRizehubBody(rawBody, secret), 'hex');
  const given = Buffer.from(sig, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'signature mismatch' };
  return { ok: true };
}

/** Headers RizeHub (or the mock server) sends with a webhook. */
export function webhookHeaders(rawBody: string, secret: string, nowMs = Date.now()): Record<string, string> {
  return {
    'content-type': 'application/json',
    [SIGNATURE_HEADER]: signRizehubBody(rawBody, secret),
    [TIMESTAMP_HEADER]: String(Math.floor(nowMs / 1000)),
  };
}
