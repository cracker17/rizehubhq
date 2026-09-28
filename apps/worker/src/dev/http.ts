// HTTP for the dev tools: timeouts, retries with backoff on 429/5xx, capped bodies, and a Redactor that
// removes every known form of every token from anything handed back to the model.
import { redact, secretVariants } from '../vault/guards';
import { errMsg } from '../deps';

export const MAX_OUT = 8000;

/** Collects secret variants for one tool call; `apply` is run on every string returned to the model. */
export class Redactor {
  private variants: string[] = [];
  constructor(env: Record<string, string | undefined> = {}) {
    // Defense in depth: worker env values that look like secrets are redacted too (e.g. printed by a child).
    for (const [k, v] of Object.entries(env)) {
      if (v && v.length >= 12 && /(TOKEN|SECRET|KEY|PASSWORD|PASS|PAT|AUTH)/i.test(k)) this.add(v);
    }
  }
  add(secret: string | null | undefined, username?: string | null) {
    if (!secret) return;
    this.variants = [...new Set([...this.variants, ...secretVariants(secret, username)])].sort((a, b) => b.length - a.length);
  }
  apply(text: string): string { return redact(text, this.variants); }
}

export function truncate(text: string, max = MAX_OUT): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text;
}

export interface HttpReq {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs?: number;
  retries?: number;
}
export interface HttpRes { status: number; ok: boolean; headers: Headers; text: string; json: unknown }

export class HttpError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) { super(message); }
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'OPTIONS']);
const MAX_BODY = 2 * 1024 * 1024;

export interface HttpEnv { fetch: typeof fetch; sleep: (ms: number) => Promise<void> }

function backoffMs(attempt: number, retryAfter: string | null): number {
  const ra = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(ra) && ra >= 0) return Math.min(ra * 1000, 30_000);
  return Math.min(500 * 2 ** attempt + Math.floor(Math.random() * 250), 15_000);
}

/**
 * fetch with timeout + retries. 429 is always retried (the server did not act); 5xx and network errors only
 * for idempotent methods, so a POST is never sent twice. Redirects are not followed.
 */
export async function httpRequest(env: HttpEnv, req: HttpReq): Promise<HttpRes> {
  const method = (req.method ?? 'GET').toUpperCase();
  const retries = req.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await env.fetch(req.url, {
        method, headers: req.headers, body: req.body as BodyInit | undefined, redirect: 'manual',
        signal: AbortSignal.timeout(req.timeoutMs ?? 30_000),
      });
    } catch (e) {
      if (attempt < retries && IDEMPOTENT.has(method)) { await env.sleep(backoffMs(attempt, null)); continue; }
      throw new Error(`request failed: ${errMsg(e)}`);
    }
    if (RETRY_STATUS.has(res.status) && attempt < retries && (res.status === 429 || IDEMPOTENT.has(method))) {
      await res.body?.cancel().catch(() => undefined);
      await env.sleep(backoffMs(attempt, res.headers.get('retry-after')));
      continue;
    }
    let text = method === 'HEAD' ? '' : await res.text();
    if (text.length > MAX_BODY) text = text.slice(0, MAX_BODY);
    let json: unknown = null;
    if (text && /json/i.test(res.headers.get('content-type') ?? '')) { try { json = JSON.parse(text); } catch { json = null; } }
    return { status: res.status, ok: res.status >= 200 && res.status < 300, headers: res.headers, text, json };
  }
}

/** One short line describing an API failure for the model (body truncated; caller redacts). */
export function apiError(what: string, r: HttpRes): string {
  const hint = r.status === 401 || r.status === 403
    ? ' Auth/permission was refused: if the token is wrong or lacks a scope, call vault_report_problem (vault credential) or ask_ceo; do not keep retrying.'
    : r.status === 404 ? ' Not found (check the id, or the token cannot see it).' : r.status === 429 ? ' Rate limited even after retries; wait and try later.' : '';
  return `${what} failed: HTTP ${r.status}. ${truncate(r.text, 1500)}${hint}`;
}
