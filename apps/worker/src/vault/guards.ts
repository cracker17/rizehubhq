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

// ---------- vault_api writes (docs/09: read-only unless the CEO allowed a specific write) ----------

export const WRITE_METHODS = ['POST', 'PUT', 'PATCH'] as const;
export type WriteMethod = (typeof WRITE_METHODS)[number];
/** Headers / query params that let a request pretend to be another method; never forwarded. */
export const METHOD_OVERRIDE_HEADERS = ['x-http-method-override', 'x-http-method', 'x-method-override'];
const WRITE_ENTRY = /^(POST|PUT|PATCH) ((?:\/|https:\/\/)\S*)$/;

export interface WriteEntry { method: WriteMethod; allow: AllowEntry | null; path: string }

/** "PUT /admin/api/2025-07/themes/123/assets.json" or "PATCH https://host/path" → entry; anything else → null. */
export function parseWriteEntry(raw: string): WriteEntry | null {
  const m = WRITE_ENTRY.exec(raw.trim());
  if (!m || m[2]!.length > 500) return null;
  const method = m[1] as WriteMethod;
  if (m[2]!.startsWith('/')) {
    let path: string;
    try { path = new URL(m[2]!, 'https://x.invalid').pathname; } catch { return null; }
    return { method, allow: null, path };
  }
  const allow = parseAllowEntry(m[2]!);
  return allow ? { method, allow, path: allow.path } : null;
}

function pathUnder(prefix: string, pathname: string): boolean {
  if (prefix === '/' || prefix === '') return true;
  const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return pathname === prefix || pathname.startsWith(p);
}

/** True when METHOD + URL matches an entry of the credential's write allowlist (whole path segments). */
export function writeAllowed(method: string, url: URL, writeAllowlist: readonly string[]): boolean {
  return writeAllowlist.some((raw) => {
    const e = parseWriteEntry(raw);
    if (!e || e.method !== method.toUpperCase()) return false;
    return e.allow ? entryMatches(e.allow, url) : pathUnder(e.path, url.pathname);
  });
}

function jsonValues(body: string | undefined): unknown {
  if (!body) return null;
  try { return JSON.parse(body); } catch { return null; }
}

/** Every value of `key` anywhere in a JSON document. */
function valuesOf(doc: unknown, key: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(doc)) for (const v of doc) valuesOf(v, key, out);
  else if (doc && typeof doc === 'object') {
    for (const [k, v] of Object.entries(doc)) {
      if (k.toLowerCase() === key) out.push(v);
      valuesOf(v, key, out);
    }
  }
  return out;
}

/**
 * Known "go live" endpoints are never called with a client's token, whatever the write allowlist says: they change
 * what the public sees and must go through request_external_action (the CEO approves, fixed worker code runs it).
 * Returns a short reason, or null.
 */
export function publishBlocked(method: string, url: URL, body: string | undefined): string | null {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD') return null;
  const path = url.pathname.toLowerCase();
  const text = body ?? '';
  const doc = jsonValues(body);
  const form = new URLSearchParams(doc ? '' : text);

  // Shopify: publishing a theme = setting role (main) on themes.json / themes/{id}.json; GraphQL themePublish.
  if (/\/admin(\/api\/[^/]+)?\/themes(\/\d+)?\.json$/.test(path)
      && (valuesOf(doc, 'role').length > 0 || /"role"\s*:/i.test(text) || form.has('theme[role]') || form.has('role'))) {
    return 'Shopify theme role change (publishing a theme)';
  }
  if (/\/admin\/api\/[^/]+\/graphql\.json$/.test(path) && /\b(themePublish|publishablePublish|publishablePublishToCurrentChannel)\b/.test(text)) {
    return 'Shopify publish mutation';
  }
  // Webflow: site publish, collection item publish / live endpoints.
  if (/\/sites\/[^/]+\/publish\/?$/.test(path) || /\/collections\/[^/]+\/items\/(publish|live)\/?$/.test(path)
      || /\/collections\/[^/]+\/items\/[^/]+\/live\/?$/.test(path)) {
    return 'Webflow publish';
  }
  // WordPress REST: anything that sets status publish/future (body, form or query string).
  if (/\/wp-json\//.test(path) || url.searchParams.has('rest_route')) {
    const statuses = [...valuesOf(doc, 'status'), form.get('status'), url.searchParams.get('status')]
      .filter((v): v is string => typeof v === 'string').map((v) => v.toLowerCase());
    if (statuses.some((s) => s === 'publish' || s === 'future') || /"status"\s*:\s*"(publish|future)"/i.test(text)) {
      return 'WordPress publish (status=publish)';
    }
  }
  return null;
}

/** A GET that asks the server to treat it as another method (`?_method=POST`, WordPress / Rails style). */
export function hasMethodOverride(url: URL): boolean {
  return [...url.searchParams.keys()].some((k) => k.toLowerCase() === '_method');
}
