// Tool-layer guardrails for the Client Vault: URL allowlists and secret redaction.

export interface AllowEntry { protocol: string; host: string; wildcard: boolean; port: string; path: string }

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

/** "https://shop.myshopify.com/admin/themes", "shop.myshopify.com/admin/*" (https assumed), "*.example.com". */
export function parseAllowEntry(raw: string): AllowEntry | null {
  let s = raw.trim();
  if (!s) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  let wildcard = false;
  const m = /^([a-z]+:\/\/)\*\.(.*)$/i.exec(s);
  if (m) { wildcard = true; s = `${m[1]}${m[2]}`; }
  let u: URL;
  try { u = new URL(s.replace(/\*+$/, '')); } catch { return null; }
  if (u.username || u.password) return null;
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL.has(u.hostname))) return null;
  return { protocol: u.protocol, host: u.hostname.toLowerCase(), wildcard, port: u.port, path: u.pathname || '/' };
}

/** Parses a URL the agent wants to use; only https (http for localhost), never embedded credentials. */
export function safeUrl(raw: string): URL | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.username || u.password) return null;
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL.has(u.hostname))) return null;
  return u;
}

function entryMatches(e: AllowEntry, u: URL): boolean {
  if (u.protocol !== e.protocol || u.port !== e.port) return false;
  const host = u.hostname.toLowerCase();
  if (e.wildcard ? !(host === e.host || host.endsWith(`.${e.host}`)) : host !== e.host) return false;
  if (e.path === '/' || e.path === '') return true;
  const prefix = e.path.endsWith('/') ? e.path : `${e.path}/`;
  return u.pathname === e.path || u.pathname.startsWith(prefix);
}

/** True when `url` falls under one of the allowlist entries (prefix match on whole path segments). */
export function urlAllowed(url: string | URL, allowlist: readonly string[]): boolean {
  const u = typeof url === 'string' ? safeUrl(url) : url;
  if (!u) return false;
  return allowlist.some((raw) => {
    const e = parseAllowEntry(raw);
    return e ? entryMatches(e, u) : false;
  });
}

/** Origin + path of a login URL, used as an implicit allowlist entry for vault_login. */
export function loginEntry(loginUrl: string | null | undefined): string[] {
  const u = loginUrl ? safeUrl(loginUrl) : null;
  return u ? [`${u.protocol}//${u.host}/`] : [];
}

export const REDACTED = '[REDACTED]';

/** Every form a secret could take in an echo: raw, URL-encoded, JSON-escaped, base64 (+ Basic auth pair). */
export function secretVariants(secret: string, username?: string | null): string[] {
  const out = new Set<string>();
  const add = (v: string) => { if (v && v.length >= 3) out.add(v); };
  add(secret);
  add(encodeURIComponent(secret));
  add(JSON.stringify(secret).slice(1, -1));
  add(Buffer.from(secret).toString('base64'));
  add(Buffer.from(secret).toString('base64url'));
  if (username) {
    add(Buffer.from(`${username}:${secret}`).toString('base64'));
    add(Buffer.from(`${username}:${secret}`).toString('base64url'));
  }
  // Longest first so a variant containing another is replaced whole.
  return [...out].sort((a, b) => b.length - a.length);
}

export function redact(text: string, variants: readonly string[]): string {
  let s = text;
  for (const v of variants) if (s.includes(v)) s = s.split(v).join(REDACTED);
  return s;
}

/** "jane.doe@client.com" → "j***@client.com", "admin" → "a***". */
export function maskUsername(u: string | null | undefined): string {
  if (!u) return '(no username)';
  const at = u.indexOf('@');
  if (at > 0) return `${u[0]}***${u.slice(at)}`;
  return `${u[0]}***`;
}

/** Header name from scope notes, e.g. "header: X-Shopify-Access-Token". */
export function authHeaderFromScope(scope: string | null | undefined): string | null {
  const m = /\bheader\s*[:=]\s*([A-Za-z0-9-]{1,64})/i.exec(scope ?? '');
  return m ? m[1]! : null;
}
