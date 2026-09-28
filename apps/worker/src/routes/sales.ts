import type { Route } from './types';
import { getSales } from '../sales/runtime';
import { unsubscribeRoutes } from '../sales/unsubscribe';

/**
 * One-click unsubscribe for outreach emails (GET/POST /hooks/unsubscribe, HMAC token; sales/unsubscribe.ts). Opt-outs are
 * honoured whether or not OUTREACH_ENABLED is on; without OUTREACH_UNSUBSCRIBE_SECRET the route answers 503.
 */
export const salesRoutes: Route[] = unsubscribeRoutes(() => {
  const rt = getSales();
  return { db: rt.db, secret: rt.cfg.unsubscribeSecret };
});
