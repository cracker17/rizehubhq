// Token, code and PKCE helpers for the Brain connector's OAuth server (docs/16-BRAIN.md "Connector").
// Every secret is 32 random bytes (base64url); only its sha256 hex ever reaches the database.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const ACCESS_TOKEN_TTL = 60 * 60;             // 1 hour
export const REFRESH_TOKEN_TTL = 60 * 24 * 60 * 60;  // 60 days, rotated on every use
export const CODE_TTL = 5 * 60;

export const SCOPES = ['brain:read', 'brain:write'] as const;
export type Scope = (typeof SCOPES)[number];

const b64url = (buf: Buffer) => buf.toString('base64url');
export const randomSecret = (prefix: string) => `${prefix}${b64url(randomBytes(32))}`;
export const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

export const newClientId = () => `hqbc_${b64url(randomBytes(18))}`;
export const newAccessToken = () => randomSecret('hqb_at_');
export const newRefreshToken = () => randomSecret('hqb_rt_');
export const newCode = () => randomSecret('hqb_ac_');

/** RFC 7636 S256: BASE64URL(SHA256(verifier)) == challenge. Verifier: 43–128 unreserved characters. */
export function pkceOk(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const a = Buffer.from(b64url(createHash('sha256').update(verifier).digest()));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Space-separated scope string → known scopes. Nothing asked = read + write (the consent page can narrow it). */
export function parseScopes(scope: unknown): Scope[] | null {
  if (scope === undefined || scope === null || scope === '') return [...SCOPES];
  if (typeof scope !== 'string') return null;
  const asked = [...new Set(scope.split(/\s+/).filter(Boolean))];
  if (!asked.length) return [...SCOPES];
  // Unknown scopes (e.g. "openid", "offline_access" some clients add) are ignored, not an error.
  const known = asked.filter((s): s is Scope => (SCOPES as readonly string[]).includes(s));
  return known.length ? known : [...SCOPES];
}

/**
 * Redirect URIs a client may register: Claude's own callbacks (claude.ai / claude.com) plus extra hosts from
 * BRAIN_OAUTH_REDIRECT_HOSTS (https only), and loopback http for Claude Code / desktop (RFC 8252 §7.3, any port).
 */
export function redirectUriAllowed(uri: unknown, extraHosts: readonly string[]): boolean {
  if (typeof uri !== 'string' || uri.length > 500) return false;
  let u: URL;
  try { u = new URL(uri); } catch { return false; }
  if (u.username || u.password || u.hash) return false;
  if (u.protocol === 'http:') return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:') return false;
  const hosts = ['claude.ai', 'claude.com', ...extraHosts];
  return hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
}

/** RFC 8252 §7.3: a loopback redirect matches whatever port the client opens at authorize time. */
export function redirectMatches(registered: readonly string[], given: string): boolean {
  if (registered.includes(given)) return true;
  let g: URL;
  try { g = new URL(given); } catch { return false; }
  if (g.protocol !== 'http:') return false;
  return registered.some((r) => {
    try {
      const u = new URL(r);
      return u.protocol === 'http:' && u.hostname === g.hostname && u.pathname === g.pathname && u.search === g.search;
    } catch { return false; }
  });
}
