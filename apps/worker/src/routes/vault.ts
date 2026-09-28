// Client Vault routes (M9a). Called only by the dashboard SERVER (private network), never by browsers.
//   auth 'secret'  POST /vault/store   {clientId, platform, label, loginUrl, username, secretType, secret, twofaMethod,
//                                       scopeNotes, urlAllowlist, grants[], expiresAt?}      → {id}
//                  POST /vault/rotate  {id, secret}                                          → {ok}
//                  POST /vault/reveal  {id}  (CEO re-authenticated by the dashboard; logged)  → {label, secret}
//   auth 'self'    POST /vault/access        {token, platform, label?, loginUrl, username, secretType, secret, twofaMethod, notes}
//                  POST /vault/access/state  {token}  → {state, client_name, platforms, expires_at}
//     The client's one-time link: the route verifies the token itself (hash, unused, unexpired) and is rate-limited.
//     It ALSO requires x-hq-secret, because only the dashboard server forwards the public form.
//     (The token travels in the body, not the path, so it never shows up in URL/access logs.)
// Never logs request bodies; errors never echo input values.
import { timingSafeEqual } from 'node:crypto';
import type http from 'node:http';
import type { Route } from './types';
import { createServiceClient } from '../db';
import { loadKeyring, VaultConfigError } from '../vault/crypto';
import { createSupabaseVaultStore } from '../vault/store';
import {
  AccessInput, AccessStateInput, createVaultService, issuesText, RevealInput, RotateInput, StoreInput, VaultUnavailable,
  type VaultService,
} from '../vault/service';
import { errMsg } from '../deps';

export const VAULT_MAX_BODY = 16 * 1024;

/** Fixed-window in-memory limiter (per worker process). */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(private limit: number, private windowMs: number, private now: () => number = Date.now) {}
  /** true = allowed */
  hit(key: string): boolean {
    const t = this.now();
    const h = this.hits.get(key);
    if (!h || h.reset <= t) {
      if (this.hits.size > 5000) for (const [k, v] of this.hits) if (v.reset <= t) this.hits.delete(k);
      this.hits.set(key, { n: 1, reset: t + this.windowMs });
      return true;
    }
    h.n++;
    return h.n <= this.limit;
  }
}

function same(a: string | undefined, b: string): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function parse(raw: Buffer): unknown {
  if (raw.length > VAULT_MAX_BODY) throw new Error('body too large');
  try { return raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { throw new Error('invalid JSON'); }
}

export interface VaultRouteOptions {
  service: () => VaultService;
  /** HQ_INTERNAL_SECRET (checked again by the self routes). */
  secret: () => string;
  logError?: (msg: string) => void;
  accessPerIp?: RateLimiter;
  accessGlobal?: RateLimiter;
}

export function createVaultRoutes(o: VaultRouteOptions): Route[] {
  const perIp = o.accessPerIp ?? new RateLimiter(10, 10 * 60_000);
  const global = o.accessGlobal ?? new RateLimiter(120, 10 * 60_000);
  const logError = o.logError ?? ((m: string) => console.error(m));

  const fail = (where: string, e: unknown): [number, unknown] => {
    if (e instanceof VaultUnavailable || e instanceof VaultConfigError) return [503, { error: e.message }];
    const msg = errMsg(e);
    if (/body too large|invalid JSON/.test(msg)) return [400, { error: msg }];
    if (/not found/.test(msg)) return [404, { error: /client/.test(msg) ? 'client not found' : 'credential not found' }];
    if (/revoked|archived|platform not requested|bad platform|label is required/.test(msg)) return [409, { error: msg.replace(/^\w+: /, '') }];
    logError(`[vault] ${where} failed: ${msg.slice(0, 300)}`);
    return [500, { error: `vault ${where} failed` }];
  };

  const secretRoute = (path: string, handle: (body: unknown) => Promise<[number, unknown]>): Route => ({
    method: 'POST', path, auth: 'secret',
    handle: async (_req, raw) => {
      try { return await handle(parse(raw)); } catch (e) { return fail(path.slice(7), e); }
    },
  });

  /** Self routes: shared secret + limiter; the token itself is checked by the database. */
  const selfRoute = (path: string, handle: (body: unknown) => Promise<[number, unknown]>, limited: boolean): Route => ({
    method: 'POST', path, auth: 'self',
    handle: async (req: http.IncomingMessage, raw) => {
      const secret = o.secret();
      if (!secret) return [503, { error: 'HQ_INTERNAL_SECRET is not configured' }];
      const given = req.headers['x-hq-secret'];
      if (!same(Array.isArray(given) ? given[0] : given, secret)) return [401, { error: 'unauthorized' }];
      // Trusted (secret matched): the dashboard passes the visitor's IP.
      const ipHeader = req.headers['x-client-ip'];
      const ip = (Array.isArray(ipHeader) ? ipHeader[0] : ipHeader)?.slice(0, 64) || req.socket.remoteAddress || 'unknown';
      if (limited && (!perIp.hit(ip) || !global.hit('*'))) return [429, { error: 'Too many attempts. Try again in a few minutes.' }];
      try { return await handle(parse(raw)); } catch (e) { return fail(path.slice(7), e); }
    },
  });

  return [
    secretRoute('/vault/store', async (body) => {
      const p = StoreInput.safeParse(body);
      if (!p.success) return [400, { error: issuesText(p.error) }];
      return [200, await o.service().store(p.data)];
    }),
    secretRoute('/vault/rotate', async (body) => {
      const p = RotateInput.safeParse(body);
      if (!p.success) return [400, { error: issuesText(p.error) }];
      await o.service().rotate(p.data.id, p.data.secret);
      return [200, { ok: true }];
    }),
    secretRoute('/vault/reveal', async (body) => {
      const p = RevealInput.safeParse(body);
      if (!p.success) return [400, { error: issuesText(p.error) }];
      return [200, await o.service().reveal(p.data.id)];
    }),
    selfRoute('/vault/access', async (body) => {
      const p = AccessInput.safeParse(body);
      if (!p.success) return [400, { error: issuesText(p.error) }];
      const r = await o.service().redeem(p.data);
      return r.ok ? [200, { ok: true }] : [410, { error: 'This link has expired or was already used.' }];
    }, true),
    selfRoute('/vault/access/state', async (body) => {
      const p = AccessStateInput.safeParse(body);
      if (!p.success) return [200, { state: 'invalid' }];
      return [200, await o.service().accessState(p.data.token)];
    }, false),
  ];
}

let service: VaultService | null = null;
export const vaultRoutes: Route[] = createVaultRoutes({
  service: () => (service ??= createVaultService(createSupabaseVaultStore(createServiceClient()), loadKeyring())),
  secret: () => process.env.HQ_INTERNAL_SECRET ?? '',
});
