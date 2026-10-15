// Operator viewer tokens (docs/17-OPERATOR.md "Viewer login"): the workspace viewer (ws.rizehub.ph) is reachable only
// with a short-lived token the dashboard signs for a signed-in CEO (HQ login + 2FA). nginx on the viewer host stores it
// as an HttpOnly cookie and asks /api/operator/viewer-check before every request (auth_request). HMAC-SHA256 over the
// payload with OPERATOR_VIEWER_SECRET (dashboard only). Pure and tested; no I/O here.
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface ViewerClaims { host: string; client: string; exp: number; iat: number }

export const VIEWER_TTL_S = 12 * 3600;
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const HOST = /^[a-z0-9.-]{1,253}(:\d{1,5})?$/;

export function viewerSecret(env: Readonly<Record<string, string | undefined>>): string | null {
  const s = env.OPERATOR_VIEWER_SECRET?.trim();
  return s && s.length >= 32 ? s : null;
}

/** `<payload>.<sig>`, both base64url: safe in a cookie and a query string. */
export function signViewerToken(c: Omit<ViewerClaims, 'iat' | 'exp'> & { ttlS?: number }, secret: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const payload = b64(JSON.stringify({ host: c.host.toLowerCase(), client: c.client, iat, exp: iat + (c.ttlS ?? VIEWER_TTL_S) }));
  return `${payload}.${b64(createHmac('sha256', secret).update(payload).digest())}`;
}

/** The claims when the token is genuine, unexpired and for this host; null otherwise (never throws). */
export function verifyViewerToken(token: string | null | undefined, host: string | null | undefined, secret: string, now = Date.now()): ViewerClaims | null {
  if (!token || !host || token.length > 1200) return null;
  const [payload, sig, extra] = token.split('.');
  if (!payload || !sig || extra !== undefined) return null;
  const want = createHmac('sha256', secret).update(payload).digest();
  let got: Buffer;
  try { got = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let c: ViewerClaims;
  try { c = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ViewerClaims; } catch { return null; }
  if (typeof c?.host !== 'string' || typeof c.exp !== 'number' || typeof c.client !== 'string') return null;
  if (c.exp * 1000 <= now) return null;
  if (c.host !== host.trim().toLowerCase()) return null;
  return c;
}

/** The viewer host of a live-screen address ("https://ws.rizehub.ph/" → "ws.rizehub.ph"); null if it is not https. */
export function viewerHost(url: string | null | undefined): string | null {
  try {
    const u = new URL(String(url ?? ''));
    const h = u.host.toLowerCase();
    return u.protocol === 'https:' && HOST.test(h) ? h : null;
  } catch { return null; }
}

/** Where the dashboard sends the CEO: the viewer's login hand-off, which stores the token and opens the desktop. */
export function viewerLoginUrl(viewerUrl: string, token: string): string {
  const u = new URL(viewerUrl);
  return `${u.protocol}//${u.host}/__hq/login?t=${encodeURIComponent(token)}`;
}
