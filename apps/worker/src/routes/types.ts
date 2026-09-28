import type http from 'node:http';

/**
 * Extra HTTP route for the worker's internal API.
 * auth 'secret' = requires x-hq-secret (dashboard → worker); 'self' = the route verifies its own signature (webhooks).
 */
export interface Route {
  method: 'GET' | 'POST';
  path: string;
  auth: 'secret' | 'self';
  /** rawBody is the exact bytes received (needed for HMAC checks). Return [status, json]. */
  handle(req: http.IncomingMessage, rawBody: Buffer): Promise<[number, unknown]>;
}
