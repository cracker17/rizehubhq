// Isolated browser sessions for vault_login (docs/09 "Using a credential"). Playwright is imported
// dynamically so the worker runs without it; tests inject a fake launcher (no real browser).
// One fresh context per login (no shared profile), navigation outside the credential's allowlist is
// blocked, password/OTP fields are blurred on every page, and sessions close (cookies cleared) when the
// task ends, goes idle, or gets too old.

import { publicEnv, workerEnv } from '../config';
export interface LocatorLike {
  first(): LocatorLike;
  count(): Promise<number>;
  isVisible(): Promise<boolean>;
  fill(value: string, opts?: { timeout?: number }): Promise<void>;
  press(key: string, opts?: { timeout?: number }): Promise<void>;
  click(opts?: { timeout?: number }): Promise<void>;
}
export interface PageLike {
  goto(url: string, opts?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'; timeout?: number }): Promise<unknown>;
  url(): string;
  locator(selector: string): LocatorLike;
  waitForLoadState(state?: 'load' | 'domcontentloaded' | 'networkidle', opts?: { timeout?: number }): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  addStyleTag(opts: { content: string }): Promise<unknown>;
  screenshot(opts?: { fullPage?: boolean; type?: 'png' | 'jpeg' }): Promise<Buffer>;
}
export interface RouteLike {
  request(): { url(): string; isNavigationRequest(): boolean };
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
}
export interface ContextLike {
  newPage(): Promise<PageLike>;
  addInitScript(script: { content: string }): Promise<void>;
  route(url: string, handler: (route: RouteLike) => unknown): Promise<void>;
  clearCookies(): Promise<void>;
  close(): Promise<void>;
}
export interface BrowserLike {
  newContext(opts?: Record<string, unknown>): Promise<ContextLike>;
  close(): Promise<void>;
}
export type LaunchBrowser = () => Promise<BrowserLike>;

export class BrowserUnavailable extends Error {}

/** Real launcher: `playwright` (or `playwright-core`) if installed on the worker, headless Chromium. */
export const launchPlaywright: LaunchBrowser = async () => {
  type Pw = { chromium?: { launch(o: Record<string, unknown>): Promise<BrowserLike> } };
  const load = async (name: string): Promise<Pw | null> => {
    try { return (await import(/* @vite-ignore */ name)) as Pw; } catch { return null; }
  };
  const mod = (await load('playwright')) ?? (await load('playwright-core'));
  if (!mod?.chromium) {
    throw new BrowserUnavailable('Playwright is not installed on the worker (pnpm --filter worker add playwright && npx playwright install chromium).');
  }
  try {
    // No secrets in the browser process environment (Playwright defaults to the whole process.env).
    return await mod.chromium.launch({ headless: true, executablePath: workerEnv().PLAYWRIGHT_CHROMIUM_PATH || undefined, env: publicEnv(workerEnv()) });
  } catch (e) {
    throw new BrowserUnavailable(`Chromium could not start: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }
};

// ---------- page helpers ----------
export const BLUR_CSS = 'input[type="password"],input[autocomplete="current-password"],input[autocomplete="new-password"],'
  + 'input[autocomplete="one-time-code"]{filter:blur(8px)!important;-webkit-text-security:disc!important;color:transparent!important;text-shadow:0 0 8px #000!important}';
export const BLUR_SCRIPT = `(() => { const add = () => { if (document.getElementById('__rzh_vault_blur')) return;
  const s = document.createElement('style'); s.id = '__rzh_vault_blur'; s.textContent = ${JSON.stringify(BLUR_CSS)};
  (document.head || document.documentElement).appendChild(s); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add(); })();`;

const USER_FIELDS = ['input[autocomplete="username"]', 'input[type="email"]', 'input[name="username" i]', 'input[name="email" i]',
  'input[name="login" i]', 'input[name="log"]', 'input[name="user" i]', 'input[id*="user" i]', 'input[id*="email" i]', 'input[type="text"]'];
const PASSWORD_FIELDS = ['input[type="password"]'];
const OTP_FIELDS = ['input[autocomplete="one-time-code"]', 'input[name*="otp" i]', 'input[id*="otp" i]', 'input[name*="code" i]',
  'input[id*="code" i]', 'input[inputmode="numeric"]'];
const SUBMIT = ['button[type="submit"]', 'input[type="submit"]', 'button[name="commit"]', 'button:has-text("Continue")',
  'button:has-text("Next")', 'button:has-text("Log in")', 'button:has-text("Sign in")'];

async function firstVisible(page: PageLike, selectors: string[]): Promise<LocatorLike | null> {
  for (const s of selectors) {
    const loc = page.locator(s).first();
    try { if ((await loc.count()) > 0 && (await loc.isVisible())) return loc; } catch { /* detached */ }
  }
  return null;
}

async function waitVisible(page: PageLike, selectors: string[], ms: number): Promise<LocatorLike | null> {
  for (let i = Math.ceil(ms / 400); ; i--) {
    const loc = await firstVisible(page, selectors);
    if (loc || i <= 0) return loc;
    await page.waitForTimeout(400);
  }
}

async function settle(page: PageLike) {
  try { await page.waitForLoadState('networkidle', { timeout: 15_000 }); } catch { /* long-polling pages never idle */ }
}

export type LoginOutcome = 'ok' | 'failed' | 'needs_2fa' | 'no_form';

/** Fills a common login form (single page or "email → Next → password"). The secret never leaves this function. */
export async function performLogin(page: PageLike, url: string, username: string | null, password: string): Promise<LoginOutcome> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  let pw = await waitVisible(page, PASSWORD_FIELDS, 3_000);
  const user = await firstVisible(page, USER_FIELDS);
  if (user && username) await user.fill(username, { timeout: 10_000 });
  if (!pw) {
    if (!user) return 'no_form';
    const next = await firstVisible(page, SUBMIT);
    if (next) await next.click({ timeout: 10_000 }); else await user.press('Enter');
    pw = await waitVisible(page, PASSWORD_FIELDS, 10_000);
    if (!pw) return (await firstVisible(page, OTP_FIELDS)) ? 'needs_2fa' : 'no_form';
  }
  await pw.fill(password, { timeout: 10_000 });
  await pw.press('Enter');
  await settle(page);
  return afterSubmit(page);
}

async function afterSubmit(page: PageLike): Promise<LoginOutcome> {
  if (await waitVisible(page, OTP_FIELDS.slice(0, 3), 1_500)) return 'needs_2fa';
  if (await firstVisible(page, PASSWORD_FIELDS)) return 'failed';
  if (await firstVisible(page, OTP_FIELDS)) return 'needs_2fa';
  return 'ok';
}

/** Types the one-time code into the 2FA field. */
export async function submitOtp(page: PageLike, code: string): Promise<LoginOutcome> {
  const f = await firstVisible(page, OTP_FIELDS);
  if (!f) return 'no_form';
  await f.fill(code, { timeout: 10_000 });
  await f.press('Enter');
  await settle(page);
  if (await firstVisible(page, OTP_FIELDS)) return 'failed';
  return (await firstVisible(page, PASSWORD_FIELDS)) ? 'failed' : 'ok';
}

// ---------- sessions ----------
export interface VaultBrowserSession {
  credentialId: string;
  label: string;
  host: string;
  browser: BrowserLike;
  context: ContextLike;
  page: PageLike;
  /** URL prefixes the page may navigate to. */
  allow: string[];
  state: 'logged_in' | 'needs_2fa';
  openedAt: number;
  lastUsedAt: number;
  /** Set while a tool is waiting (e.g. for the CEO's 2FA code) so the idle sweeper leaves it alone. */
  busy: boolean;
  blocked: string[];
  closed: boolean;
}

/** Opens a fresh isolated context with the allowlist guard and the password blur. */
export async function openSession(launch: LaunchBrowser, o: {
  credentialId: string; label: string; host: string; allow: string[]; isAllowed: (url: string) => boolean;
}): Promise<VaultBrowserSession> {
  const browser = await launch();
  try {
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
    const s: VaultBrowserSession = {
      credentialId: o.credentialId, label: o.label, host: o.host, browser, context, page: undefined as unknown as PageLike,
      allow: o.allow, state: 'logged_in', openedAt: Date.now(), lastUsedAt: Date.now(), busy: false, blocked: [], closed: false,
    };
    await context.addInitScript({ content: BLUR_SCRIPT });
    await context.route('**/*', (route) => {
      const req = route.request();
      if (req.isNavigationRequest() && !o.isAllowed(req.url())) {
        s.blocked.push(req.url().slice(0, 200));
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    s.page = await context.newPage();
    return s;
  } catch (e) {
    await browser.close().catch(() => undefined);
    throw e;
  }
}

/** Screenshot for POV/QA tools: password fields are blurred first. */
export async function vaultScreenshot(s: VaultBrowserSession): Promise<Buffer> {
  await s.page.addStyleTag({ content: BLUR_CSS }).catch(() => undefined);
  s.lastUsedAt = Date.now();
  return s.page.screenshot({ type: 'png' });
}

export async function closeSession(s: VaultBrowserSession): Promise<void> {
  if (s.closed) return;
  s.closed = true;
  await s.context.clearCookies().catch(() => undefined);
  await s.context.close().catch(() => undefined);
  await s.browser.close().catch(() => undefined);
}

// Registry: sessions belong to one task run (keyed by the runner's RunState object).
interface Entry { sessions: Map<string, VaultBrowserSession>; isOver: () => Promise<boolean> | boolean }
const runs = new Map<object, Entry>();
export const SESSION_IDLE_MS = 10 * 60_000;
export const SESSION_MAX_MS = 60 * 60_000;
let sweeper: NodeJS.Timeout | null = null;

export function registerSession(run: object, s: VaultBrowserSession, isOver: Entry['isOver']): void {
  let e = runs.get(run);
  if (!e) { e = { sessions: new Map(), isOver }; runs.set(run, e); }
  const prev = e.sessions.get(s.credentialId);
  if (prev && prev !== s) void closeSession(prev);
  e.sessions.set(s.credentialId, s);
  if (!sweeper) {
    sweeper = setInterval(() => { void sweepSessions(); }, 20_000);
    sweeper.unref?.();
  }
}

/** The logged-in session for later browser tools (same task run). */
export function getVaultBrowserSession(run: object, credentialId?: string): VaultBrowserSession | null {
  const e = runs.get(run);
  if (!e) return null;
  const list = [...e.sessions.values()].filter((s) => !s.closed);
  return (credentialId ? list.find((s) => s.credentialId === credentialId) : list.find((s) => s.state === 'logged_in')) ?? null;
}

export async function closeRunSessions(run: object): Promise<number> {
  const e = runs.get(run);
  if (!e) return 0;
  runs.delete(run);
  const list = [...e.sessions.values()];
  await Promise.all(list.map(closeSession));
  return list.length;
}

export async function closeCredentialSession(run: object, credentialId: string): Promise<void> {
  const s = runs.get(run)?.sessions.get(credentialId);
  if (s) { runs.get(run)!.sessions.delete(credentialId); await closeSession(s); }
}

/** Closes sessions whose task ended, that sat idle, or that are too old. Returns how many were closed. */
export async function sweepSessions(now = Date.now()): Promise<number> {
  let n = 0;
  for (const [run, e] of [...runs]) {
    let over = false;
    try { over = await e.isOver(); } catch { over = false; }
    for (const [id, s] of [...e.sessions]) {
      const stale = !s.busy && now - s.lastUsedAt > SESSION_IDLE_MS;
      if (over || stale || s.closed || now - s.openedAt > SESSION_MAX_MS) {
        e.sessions.delete(id);
        if (!s.closed) n++;
        await closeSession(s);
      }
    }
    if (e.sessions.size === 0) runs.delete(run);
  }
  if (runs.size === 0 && sweeper) { clearInterval(sweeper); sweeper = null; }
  return n;
}

export function openSessionCount(): number {
  let n = 0;
  for (const e of runs.values()) for (const s of e.sessions.values()) if (!s.closed) n++;
  return n;
}
