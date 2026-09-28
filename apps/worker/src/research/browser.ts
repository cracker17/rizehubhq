// Playwright QA browser (playwright-core + a local Chromium). Every request the page makes goes through
// the SSRF guard; non-GET requests (form posts, beacons) are blocked unless the caller allows them on a
// preview/staging host. A vault session for the run is reused so logged-in previews can be checked.
import fs from 'node:fs';
import path from 'node:path';
import { publicEnv } from '../config';
import { assertPublicUrl, bareHost, type NetEnv } from './net';

export interface RResponse { status(): number }
export interface RRequest { url(): string; method(): string; failure?(): { errorText: string } | null }
export interface RRoute { request(): RRequest; abort(code?: string): Promise<void>; continue(): Promise<void>; fallback?(): Promise<void> }
/** Subset of Playwright's WebSocketRoute (playwright-core ≥ 1.48). */
export interface RWebSocketRoute { url(): string; connectToServer(): unknown; close(o?: { code?: number; reason?: string }): Promise<void> }
export interface RLocator {
  first(): RLocator;
  click(o?: { timeout?: number }): Promise<void>;
  fill(v: string, o?: { timeout?: number }): Promise<void>;
  press(k: string, o?: { timeout?: number }): Promise<void>;
  selectOption(v: string, o?: { timeout?: number }): Promise<unknown>;
  check(o?: { timeout?: number }): Promise<void>;
  waitFor(o?: { state?: 'visible' | 'attached'; timeout?: number }): Promise<void>;
  innerText(o?: { timeout?: number }): Promise<string>;
}
export interface RPage {
  goto(url: string, o?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'; timeout?: number }): Promise<RResponse | null>;
  url(): string;
  title(): Promise<string>;
  setViewportSize(s: { width: number; height: number }): Promise<void>;
  screenshot(o?: { fullPage?: boolean; type?: 'png' | 'jpeg'; quality?: number }): Promise<Buffer>;
  evaluate<T = unknown>(expr: string): Promise<T>;
  locator(sel: string): RLocator;
  waitForLoadState(s?: 'load' | 'domcontentloaded' | 'networkidle', o?: { timeout?: number }): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  route(url: string, h: (r: RRoute) => unknown): Promise<void>;
  /** page.route() never sees WebSocket connections; they are guarded here. */
  routeWebSocket(url: string | RegExp, h: (ws: RWebSocketRoute) => unknown): Promise<void>;
  on(event: string, h: (arg: never) => void): unknown;
  close(): Promise<void>;
}
export interface RContext { newPage(): Promise<RPage>; close(): Promise<void> }
export interface RBrowser { newContext(o?: Record<string, unknown>): Promise<RContext>; close(): Promise<void> }
export type LaunchResearchBrowser = () => Promise<RBrowser>;

export class ResearchBrowserUnavailable extends Error {}

/** PLAYWRIGHT_CHROMIUM_PATH, else the newest Chromium in the Playwright docker image / sandbox browser dirs. */
export function resolveChromiumPath(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync,
  list: (d: string) => string[] = (d) => { try { return fs.readdirSync(d); } catch { return []; } }): string | undefined {
  if (env.PLAYWRIGHT_CHROMIUM_PATH) return env.PLAYWRIGHT_CHROMIUM_PATH;
  const roots = [env.PLAYWRIGHT_BROWSERS_PATH, '/ms-playwright', '/opt/pw-browsers'].filter((x): x is string => !!x);
  for (const root of roots) {
    const dirs = list(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const d of dirs) {
      for (const sub of ['chrome-linux/chrome', 'chrome-linux64/chrome']) {
        const p = path.join(root, d, sub);
        if (exists(p)) return p;
      }
    }
  }
  return undefined;
}

export const launchResearchChromium: LaunchResearchBrowser = async () => {
  type Pw = { chromium?: { launch(o: Record<string, unknown>): Promise<RBrowser> } };
  let mod: Pw | null = null;
  for (const name of ['playwright-core', 'playwright']) {
    try { mod = (await import(/* @vite-ignore */ name)) as Pw; break; } catch { /* try next */ }
  }
  if (!mod?.chromium) throw new ResearchBrowserUnavailable('playwright-core is not installed on the worker.');
  try {
    // env: no secrets for the browser process (Playwright defaults to the whole process.env).
    return await mod.chromium.launch({ headless: true, executablePath: resolveChromiumPath(), env: publicEnv() });
  } catch (e) {
    throw new ResearchBrowserUnavailable(`Chromium could not start (set PLAYWRIGHT_CHROMIUM_PATH): ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }
};

/** Hosts where QA may let forms submit (previews/staging), plus explicitly allowed private hosts. */
const PREVIEW_HOST = /(^|\.)(webflow\.io|vercel\.app|netlify\.app|pages\.dev|myshopify\.com|wpengine\.com|wpenginepowered\.com|onrender\.com|fly\.dev|herokuapp\.com)$|(^|[.-])(staging|preview|dev|test|stage)[.-]/i;
export function isPreviewHost(host: string, allowPrivate: readonly string[] = []): boolean {
  return PREVIEW_HOST.test(host) || allowPrivate.includes(host);
}

export interface PageSession {
  page: RPage;
  consoleErrors: string[];
  blocked: string[];
  failedResponses: string[];
  /** Closes the page (and the browser/context if this session opened them). */
  close(): Promise<void>;
  viaVault: boolean;
}

export interface VaultLikeSession { context: { newPage(): Promise<unknown> }; allow: string[]; closed: boolean }

export interface OpenPageOptions {
  net: NetEnv;
  launch: LaunchResearchBrowser;
  /** An existing logged-in vault session whose context should be reused for this URL. */
  vault?: VaultLikeSession | null;
  allowPost?: boolean;
}

const MAX_LOG = 60;
const push = (arr: string[], s: string) => { const v = s.slice(0, 400); if (arr.length < MAX_LOG && !arr.includes(v)) arr.push(v); };

/** Opens a guarded page (fresh isolated context, or a new page in the vault session's context). */
export async function openGuardedPage(o: OpenPageOptions): Promise<PageSession> {
  const blocked: string[] = [];
  const consoleErrors: string[] = [];
  const failedResponses: string[] = [];
  const hostOk = new Map<string, Promise<boolean>>();
  const allowed = (url: string) => {
    let host: string;
    try { host = bareHost(new URL(url)); } catch { return Promise.resolve(false); }
    let p = hostOk.get(host);
    if (!p) { p = assertPublicUrl(url, o.net).then(() => true, () => false); hostOk.set(host, p); }
    return p;
  };

  let browser: RBrowser | null = null;
  let context: RContext | null = null;
  let page: RPage;
  const viaVault = !!(o.vault && !o.vault.closed);
  if (viaVault) {
    page = (await o.vault!.context.newPage()) as RPage;
  } else {
    browser = await o.launch();
    try {
      context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
      page = await context.newPage();
    } catch (e) {
      await browser.close().catch(() => undefined);
      throw e;
    }
  }

  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    const pass = () => (route.fallback ? route.fallback() : route.continue());
    if (/^(data|blob|about):/i.test(url)) return pass();
    const method = req.method().toUpperCase();
    let host = '';
    try { host = bareHost(new URL(url)); } catch { /* invalid */ }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !(o.allowPost && isPreviewHost(host, o.net.allowPrivateHosts))) {
      push(blocked, `${method} ${url} (non-GET blocked)`);
      return route.abort('blockedbyclient');
    }
    if (!(await allowed(url))) {
      push(blocked, `${url} (private/blocked address)`);
      return route.abort('blockedbyclient');
    }
    return pass();
  });
  // WebSockets bypass page.route(): without this a page could open ws://10.0.0.5/ or wss://169.254.169.254/.
  // Every socket gets the same SSRF check (ws→http, wss→https) before it is connected to its server; blocked
  // ones are closed with 1008 (policy violation) and listed under `blocked`. Must be registered before goto().
  await page.routeWebSocket(/.*/, async (ws) => {
    const url = ws.url();
    let httpUrl = '';
    try { const u = new URL(url); u.protocol = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol; httpUrl = u.toString(); } catch { /* invalid */ }
    if (httpUrl && /^https?:/.test(httpUrl) && (await allowed(httpUrl))) { ws.connectToServer(); return; }
    push(blocked, `${url} (WebSocket to a private/blocked address)`);
    await ws.close({ code: 1008, reason: 'blocked by QA browser guard' }).catch(() => undefined);
  });
  page.on('console', ((m: { type(): string; text(): string }) => {
    // Chromium logs our own guard aborts as "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT"; those are listed under blocked.
    if (m.type() === 'error' && !/ERR_BLOCKED_BY_CLIENT/.test(m.text())) push(consoleErrors, `console.error: ${m.text()}`);
  }) as (a: never) => void);
  page.on('pageerror', ((e: Error) => push(consoleErrors, `uncaught: ${e?.message ?? String(e)}`)) as (a: never) => void);
  page.on('requestfailed', ((r: RRequest) => {
    const why = r.failure?.()?.errorText ?? 'failed';
    if (!/blockedbyclient|ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/i.test(why)) push(consoleErrors, `request failed: ${r.url()} (${why})`);
  }) as (a: never) => void);
  page.on('response', ((r: RResponse & { url(): string }) => { if (r.status() >= 400) push(failedResponses, `HTTP ${r.status()} ${r.url()}`); }) as (a: never) => void);

  return {
    page, consoleErrors, blocked, failedResponses, viaVault,
    async close() {
      await page.close().catch(() => undefined);
      if (context) await context.close().catch(() => undefined);
      if (browser) await browser.close().catch(() => undefined);
    },
  };
}

export const VIEWPORT_HEIGHT: Record<number, number> = { 375: 812, 768: 1024, 1440: 900 };

/** Navigate and let the page settle (bounded). Returns the HTTP status (null if unknown). */
export async function navigate(page: RPage, url: string, timeoutMs = 30_000): Promise<number | null> {
  const res = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
  return res ? res.status() : null;
}

/** Scroll through the page once so lazy images load before a full-page screenshot. */
export async function warmLazyContent(page: RPage): Promise<void> {
  await page.evaluate(`(async () => { const h = document.documentElement.scrollHeight; for (let y = 0; y < Math.min(h, 20000); y += 700) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 60)); } window.scrollTo(0, 0); })()`).catch(() => undefined);
  await page.waitForTimeout(300).catch(() => undefined);
}

export interface OverflowReport { viewport: number; scrollWidth: number; overflowing: boolean; offenders: { el: string; right: number; width: number }[] }

export const OVERFLOW_SCRIPT = `(() => {
  const vw = document.documentElement.clientWidth;
  const sw = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0);
  const out = [];
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > vw + 1 || r.left < -1) {
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' && cs.visibility === 'hidden') continue;
      const id = el.id ? '#' + el.id : '';
      const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
      out.push({ el: el.tagName.toLowerCase() + id + cls, right: Math.round(r.right), width: Math.round(r.width) });
      if (out.length >= 12) break;
    }
  }
  return { viewport: vw, scrollWidth: sw, overflowing: sw > vw + 1, offenders: out };
})()`;
