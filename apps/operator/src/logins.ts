// "Still logged in?" (docs/17-OPERATOR.md "Logins"). Every OPERATOR_LOGIN_CHECK_MS (default 6 h) and once after the
// operator starts, each enabled operator_logins row is opened in its own tab of the client's workspace browser: a
// redirect to a sign-in page, a visible password field or a known logged-out page means signed out. A lost login is a
// Telegram notice (once, SQL: operator_login_checked); so is getting it back. The tab is closed again.
//
// CLI (restart test): docker compose exec operator ./node_modules/.bin/tsx src/logins.ts [client]
import type { BrowserContext } from 'playwright-core';

export interface LoginProbe { checkUrl: string; finalUrl: string; title: string; passwordField: boolean; status: number | null }

/** Signed-out pages per site (beyond the generic sign-in patterns). */
const SIGNED_OUT: Record<string, RegExp> = {
  google: /^https:\/\/(accounts\.google\.com|workspace\.google\.com\/(intl\/[^/]+\/)?products)/i,
  webflow: /^https:\/\/(www\.)?webflow\.com\/(login|signup|dashboard\/login)/i,
  airtable: /^https:\/\/(www\.)?airtable\.com\/(login|signup|sso)/i,
  slack: /^https:\/\/([a-z0-9-]+\.)?slack\.com\/(signin|sign_in|checkcookie|workspace-signin)/i,
  teams: /^https:\/\/(login\.microsoftonline\.com|login\.live\.com)\//i,
  shopify: /^https:\/\/(accounts\.shopify\.com|admin\.shopify\.com\/login)/i,
  github: /^https:\/\/github\.com\/(login|session|sessions\/two-factor)/i,
  vercel: /^https:\/\/vercel\.com\/(login|signup)/i,
};
const GENERIC = /\/(login|log-in|signin|sign-in|sign_in|signup|sso|auth\/|oauth|ServiceLogin)(\b|[/?#])/i;

/** Pure verdict (tested). */
export function loginVerdict(site: string, p: LoginProbe): { state: 'ok' | 'signed_out'; detail: string } {
  const specific = SIGNED_OUT[site];
  if (specific?.test(p.finalUrl)) return { state: 'signed_out', detail: `redirected to ${p.finalUrl.slice(0, 120)}` };
  let path = '';
  try { const u = new URL(p.finalUrl); path = u.pathname + u.search; } catch { /* keep empty */ }
  if (GENERIC.test(path) && !GENERIC.test(new URL(p.checkUrl).pathname)) return { state: 'signed_out', detail: `sign-in page ${p.finalUrl.slice(0, 120)}` };
  if (p.passwordField) return { state: 'signed_out', detail: `a password field is showing on ${p.finalUrl.slice(0, 120)}` };
  return { state: 'ok', detail: `${p.title.slice(0, 80) || p.finalUrl.slice(0, 80)}` };
}

export async function probeLogin(ctx: BrowserContext, checkUrl: string): Promise<LoginProbe> {
  const page = await ctx.newPage();
  try {
    const res = await page.goto(checkUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
    await page.waitForTimeout(1500);
    const passwordField = await page.locator('input[type="password"]:visible').count().then((n) => n > 0).catch(() => false);
    return { checkUrl, finalUrl: page.url(), title: await page.title().catch(() => ''), passwordField, status: res?.status() ?? null };
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** One pass over every enabled login. Returns how many were checked. */
export async function checkLogins(o: {
  logins: () => Promise<{ client_slug: string; site: string; check_url: string }[]>;
  profileOf: (client: string) => Promise<string | null>;
  withProfile: (profile: string) => <T>(fn: (ctx: BrowserContext) => Promise<T>) => Promise<T>;
  record: (client: string, site: string, state: 'ok' | 'signed_out' | 'error', detail: string | null) => Promise<unknown>;
  only?: string | null;
  log?: (m: string) => void;
}): Promise<number> {
  let n = 0;
  for (const l of await o.logins()) {
    if (o.only && l.client_slug !== o.only) continue;
    const profile = await o.profileOf(l.client_slug);
    if (!profile) continue;
    try {
      const p = await o.withProfile(profile)((ctx) => probeLogin(ctx, l.check_url));
      const v = loginVerdict(l.site, p);
      await o.record(l.client_slug, l.site, v.state, v.detail);
      o.log?.(`[operator] login ${l.client_slug}/${l.site}: ${v.state} (${v.detail})`);
    } catch (e) {
      await o.record(l.client_slug, l.site, 'error', (e instanceof Error ? e.message : String(e)).slice(0, 300)).catch(() => undefined);
      o.log?.(`[operator] login ${l.client_slug}/${l.site}: check failed: ${e instanceof Error ? e.message : e}`);
    }
    n++;
  }
  return n;
}

// ---------- CLI ----------
if (process.argv[1] && /logins\.ts$/.test(process.argv[1])) {
  (async () => {
    const { config, workerEnv } = await import('worker/src/config');
    const { createServiceClient } = await import('worker/src/db');
    const { BrowserPool } = await import('./browser/cdp');
    const { cdpEndpointFor } = await import('./config');
    const { createSupabaseJobDb } = await import('./jobs/db');
    if (!config.supabaseUrl || !config.supabaseServiceKey) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
    const sb = createServiceClient();
    const db = createSupabaseJobDb(sb);
    const pool = new BrowserPool((p) => cdpEndpointFor(p, workerEnv()));
    const only = process.argv[2]?.trim() || null;
    const n = await checkLogins({
      logins: () => db.logins(),
      profileOf: async (slug) => ((await sb.from('operator_clients').select('profile').eq('slug', slug).maybeSingle()).data as { profile?: string } | null)?.profile ?? null,
      withProfile: (profile) => (fn) => pool.with(profile, fn),
      record: (c, s, st, d) => db.loginChecked(c, s, st, d),
      only, log: console.log,
    });
    console.log(`${n} login(s) checked.`);
    process.exit(0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
