// Fake Playwright for tests: a tiny login site (email + password → optional OTP → home). No real browser.
import type { BrowserLike, ContextLike, LaunchBrowser, LocatorLike, PageLike, RouteLike } from './browser';

export interface FakeSite {
  password: string;
  otp?: string;
  /** Two-step form: email first, password after "Next". */
  twoStep?: boolean;
  /** No login form at all. */
  noForm?: boolean;
}

type Stage = 'email' | 'login' | 'otp' | 'home' | 'blank';

export class FakePage implements PageLike {
  stage: Stage = 'blank';
  filled: Record<string, string> = {};
  gotoUrls: string[] = [];
  styleTags = 0;
  private current = 'about:blank';
  constructor(private site: FakeSite, private ctx: FakeContext) {}

  visible(): string[] {
    switch (this.stage) {
      case 'email': return ['input[type="email"]', 'button[type="submit"]'];
      case 'login': return [...(this.site.twoStep ? [] : ['input[type="email"]']), 'input[type="password"]', 'button[type="submit"]'];
      case 'otp': return ['input[autocomplete="one-time-code"]', 'button[type="submit"]'];
      default: return [];
    }
  }
  async goto(url: string) {
    this.gotoUrls.push(url);
    if (!(await this.ctx.navigate(url))) throw new Error(`net::ERR_BLOCKED_BY_CLIENT at ${url}`);
    this.current = url;
    this.stage = this.site.noForm ? 'blank' : this.site.twoStep ? 'email' : 'login';
    return null;
  }
  url() { return this.current; }
  locator(selector: string): LocatorLike { return new FakeLocator(this, selector); }
  async waitForLoadState() {}
  async waitForTimeout() {}
  async addStyleTag() { this.styleTags++; return null; }
  async screenshot() { return Buffer.from('png'); }

  submit(selector: string) {
    if (this.stage === 'email' && selector.includes('email')) { this.stage = 'login'; return; }
    if (this.stage === 'email' && selector.includes('submit')) { this.stage = 'login'; return; }
    if (this.stage === 'login' && selector.includes('password')) {
      if (this.filled[selector] === this.site.password) this.stage = this.site.otp ? 'otp' : 'home';
      return;
    }
    if (this.stage === 'otp' && selector.includes('one-time-code')) {
      if (this.filled[selector] === this.site.otp) this.stage = 'home';
    }
  }
}

class FakeLocator implements LocatorLike {
  constructor(private page: FakePage, private selector: string) {}
  first() { return this; }
  async count() { return this.page.visible().includes(this.selector) ? 1 : 0; }
  async isVisible() { return this.page.visible().includes(this.selector); }
  async fill(v: string) { this.page.filled[this.selector] = v; }
  async press(key: string) { if (key === 'Enter') this.page.submit(this.selector); }
  async click() { this.page.submit(this.selector); }
}

export class FakeContext implements ContextLike {
  pages: FakePage[] = [];
  initScripts: string[] = [];
  handler: ((r: RouteLike) => unknown) | null = null;
  cookiesCleared = false;
  closed = false;
  options: Record<string, unknown> | undefined;
  constructor(private site: FakeSite) {}
  async newPage() { const p = new FakePage(this.site, this); this.pages.push(p); return p; }
  async addInitScript(s: { content: string }) { this.initScripts.push(s.content); }
  async route(_u: string, h: (r: RouteLike) => unknown) { this.handler = h; }
  async clearCookies() { this.cookiesCleared = true; }
  async close() { this.closed = true; }
  /** Simulates a navigation request through the route guard; false = aborted. */
  async navigate(url: string): Promise<boolean> {
    if (!this.handler) return true;
    let allowed = true;
    await this.handler({
      request: () => ({ url: () => url, isNavigationRequest: () => true }),
      abort: async () => { allowed = false; },
      continue: async () => { allowed = true; },
    });
    return allowed;
  }
}

export class FakeBrowser implements BrowserLike {
  contexts: FakeContext[] = [];
  closed = false;
  constructor(private site: FakeSite) {}
  async newContext(opts?: Record<string, unknown>) { const c = new FakeContext(this.site); c.options = opts; this.contexts.push(c); return c; }
  async close() { this.closed = true; }
}

export function fakeLauncher(site: FakeSite): LaunchBrowser & { browsers: FakeBrowser[] } {
  const browsers: FakeBrowser[] = [];
  const launch: LaunchBrowser = async () => { const b = new FakeBrowser(site); browsers.push(b); return b; };
  return Object.assign(launch, { browsers });
}
