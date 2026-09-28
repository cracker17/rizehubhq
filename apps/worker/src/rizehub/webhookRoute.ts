// POST /hooks/rizehub (auth 'self'): verify the HMAC signature + timestamp, store the event in webhook_events
// (idempotent by event id), then process it right away; the loop re-processes anything left unprocessed.
import type http from 'node:http';
import { errMsg } from '../deps';
import type { RizehubDb } from './store';
import { verifyRizehubSignature } from './webhook';

export interface WebhookEnv { db: Pick<RizehubDb, 'storeWebhookEvent' | 'processRizehubEvent'>; secret: string }

let bound: WebhookEnv | null = null;
/** Called by the worker loop on start (the route itself is registered statically in routes/index.ts). */
export function bindRizehubWebhook(db: WebhookEnv['db'], secret: string): void { bound = { db, secret }; }
export function unbindRizehubWebhook(): void { bound = null; }

export function createRizehubWebhookHandler(get: () => WebhookEnv | null = () => bound, now: () => number = Date.now) {
  return async (req: http.IncomingMessage, raw: Buffer): Promise<[number, unknown]> => {
    const env = get();
    if (!env) return [503, { error: 'worker is starting; retry' }];
    if (!env.secret) return [503, { error: 'RIZEHUB_WEBHOOK_SECRET is not configured' }];
    const v = verifyRizehubSignature(raw, req.headers, env.secret, now());
    if (!v.ok) {
      console.warn(`[rizehub] rejected webhook: ${v.reason}`);
      return [401, { error: 'invalid signature', reason: v.reason }];
    }
    let body: { id?: unknown; event?: unknown; data?: unknown };
    try { body = JSON.parse(raw.toString('utf8')) as typeof body; } catch { return [400, { error: 'invalid JSON' }]; }
    if (typeof body !== 'object' || body === null) return [400, { error: 'body must be an object' }];
    if (typeof body.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(body.id)) return [400, { error: 'id (event id) is required' }];
    if (typeof body.event !== 'string' || !/^[a-z_]+\.[a-z_]+$/.test(body.event)) return [400, { error: 'event is required' }];
    try {
      const stored = await env.db.storeWebhookEvent({ eventId: body.id, event: body.event, payload: body as Record<string, unknown>, signatureOk: true });
      if (!stored.duplicate) void env.db.processRizehubEvent(stored.id).catch((e) => console.warn(`[rizehub] processing ${body.event} failed: ${errMsg(e)}`));
      return [200, { ok: true, id: stored.id, duplicate: stored.duplicate }];
    } catch (e) {
      return [500, { error: `could not store event: ${errMsg(e)}` }];
    }
  };
}
