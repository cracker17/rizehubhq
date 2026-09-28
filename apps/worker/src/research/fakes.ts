// Test fakes for research tools: DNS, HTTP transport, browser, API fetch. No network, no real Chromium.
import type { LookupAddress, NetEnv, Transport } from './net';
import type { RBrowser, RContext, RLocator, RPage, RRequest, RRoute } from './browser';

export type FakeReply = { status?: number; headers?: Record<string, string>; body?: string | Buffer; delayMs?: number; chunks?: number };

/** DNS: host → addresses (default: 93.184.216.34 for any *.test/*.example host). */
export function fakeLookup(map: Record<string, string | string[]> = {}): NetEnv['lookup'] & { calls: string[] } {
  const calls: string[] = [];
  const fn = async (host: string): Promise<LookupAddress[]> => {
    calls.push(host);
    const v = map[host] ?? '93.184.216.34';
    return (Array.isArray(v) ? v : [v]).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  return Object.assign(fn, { calls });
}

/** HTTP: "METHOD url" or "url" → reply (or function). Unknown URLs → 404. Records every request. */
export function fakeTransport(routes: Record<string, FakeReply | ((method: string) => FakeReply)>): Transport & { requests: string[] } {
  const requests: string[] = [];
  const fn: Transport = async (url, init) => {
    requests.push(`${init.method} ${url}`);
    const r = routes[`${init.method} ${url}`] ?? routes[url];
    const reply = typeof r === 'function' ? r(init.method) : r ?? { status: 404, body: 'not found' };
    if (reply.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, reply.delayMs);
        init.signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
      });
    }
    const body = reply.body === undefined ? '' : reply.body;
    const buf = typeof body === 'string' ? Buffer.from(body) : body;
    const chunks = reply.chunks ?? 1;
    const size = Math.ceil(buf.length / chunks) || 1;
    const stream = new ReadableStream<Uint8Array>({
      start(c) { for (let i = 0; i < buf.length; i += size) c.enqueue(new Uint8Array(buf.subarray(i, i + size))); c.close(); },
    });
    const status = reply.status ?? 200;
    return new Response(init.method === 'HEAD' || status === 204 || status === 304 ? null : stream, { status, headers: reply.headers ?? { 'content-type': 'text/html' } });
  };
  return Object.assign(fn, { requests });
}

export function fakeNet(o: { dns?: Record<string, string | string[]>; routes?: Parameters<typeof fakeTransport>[0]; allowPrivateHosts?: string[] } = {}) {
  const lookup = fakeLookup(o.dns);
  const transport = fakeTransport(o.routes ?? {});
  return { lookup, transport, allowPrivateHosts: o.allowPrivateHosts ?? [] } satisfies NetEnv;
}

/** API fetch fake: matches by URL prefix, records calls. */
export function fakeApiFetch(handlers: { match: string | RegExp; reply: (url: string, init?: RequestInit) => Response | Promise<Response> }[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    const h = handlers.find((x) => (typeof x.match === 'string' ? url.startsWith(x.match) : x.match.test(url)));
    if (!h) throw new Error(`fetch failed: offline (${url})`);
    return h.reply(url, init);
  }) as typeof fetch;
  return Object.assign(f, { calls });
}
export const jsonRes = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

// ---------- browser ----------
export interface FakeSitePage {
  status?: number; title?: string;
  /** Sub-requests the page makes when loaded (url, method). */
  subrequests?: { url: string; method?: string }[];
  console?: string[];
  pageErrors?: string[];
  overflow?: { scrollWidth: number; offenders?: { el: string; right: number; width: number }[] };
  selectors?: string[];
  text?: string;
  /** Requests fired when a selector is clicked (e.g. a form POST). */
  onClick?: Record<string, { url: string; method?: string }[]>;
}

export class FakeResearchBrowser {
  launches = 0;
  closed = 0;
  pages: FakeResearchPage[] = [];
  constructor(public site: Record<string, FakeSitePage>) {}
  launch = async (): Promise<RBrowser> => {
    this.launches++;
    const self = this;
    const ctx: RContext = {
      async newPage() { const p = new FakeResearchPage(self.site); self.pages.push(p); return p; },
      async close() { /* no-op */ },
    };
    return { newContext: async () => ctx, close: async () => { self.closed++; } };
  };
}

export class FakeResearchPage implements RPage {
  private currentUrl = 'about:blank';
  private width = 1440;
  private handlers: Record<string, ((a: never) => void)[]> = {};
  private router: ((r: RRoute) => unknown) | null = null;
  aborted: string[] = [];
  continued: string[] = [];
  actions: string[] = [];
  viewports: number[] = [];
  closedPage = false;
  constructor(private site: Record<string, FakeSitePage>) {}

  private emit(ev: string, arg: unknown) { for (const h of this.handlers[ev] ?? []) (h as (a: unknown) => void)(arg); }
  private async request(url: string, method = 'GET'): Promise<boolean> {
    const st: { result: boolean | null } = { result: null };
    const req: RRequest = { url: () => url, method: () => method, failure: () => ({ errorText: 'net::ERR_BLOCKED_BY_CLIENT' }) };
    const route: RRoute = {
      request: () => req,
      abort: async () => { st.result = false; this.aborted.push(`${method} ${url}`); },
      continue: async () => { st.result = true; this.continued.push(`${method} ${url}`); },
    };
    if (this.router) await this.router(route); else st.result = true;
    if (st.result === false) this.emit('requestfailed', req);
    return st.result === true;
  }

  async goto(url: string) {
    const ok = await this.request(url);
    if (!ok) throw new Error(`page.goto: net::ERR_BLOCKED_BY_CLIENT at ${url}`);
    const p = this.site[url];
    if (!p) throw new Error(`page.goto: net::ERR_NAME_NOT_RESOLVED at ${url}`);
    this.currentUrl = url;
    for (const s of p.subrequests ?? []) await this.request(s.url, s.method ?? 'GET');
    for (const c of p.console ?? []) this.emit('console', { type: () => 'error', text: () => c });
    for (const e of p.pageErrors ?? []) this.emit('pageerror', new Error(e));
    const status = p.status ?? 200;
    if (status >= 400) this.emit('response', { status: () => status, url: () => url });
    return { status: () => status };
  }
  url() { return this.currentUrl; }
  async title() { return this.site[this.currentUrl]?.title ?? ''; }
  async setViewportSize(s: { width: number }) { this.width = s.width; this.viewports.push(s.width); }
  async screenshot() { return Buffer.from(`shot:${this.currentUrl}:${this.width}`); }
  async evaluate<T>(expr: string): Promise<T> {
    const p = this.site[this.currentUrl];
    if (expr.includes('scrollWidth') && expr.includes('offenders')) {
      const sw = p?.overflow?.scrollWidth ?? this.width;
      return { viewport: this.width, scrollWidth: sw, overflowing: sw > this.width + 1, offenders: p?.overflow?.offenders ?? [] } as T;
    }
    if (expr.includes('innerText')) return (p?.text ?? '') as T;
    return undefined as T;
  }
  locator(sel: string): RLocator {
    const page = this;
    const exists = () => {
      if (!(page.site[page.currentUrl]?.selectors ?? []).includes(sel)) throw new Error(`locator ${sel}: timeout waiting for element`);
    };
    const loc: RLocator = {
      first: () => loc,
      click: async () => {
        exists(); page.actions.push(`click ${sel}`);
        for (const r of page.site[page.currentUrl]?.onClick?.[sel] ?? []) await page.request(r.url, r.method ?? 'GET');
      },
      fill: async (v) => { exists(); page.actions.push(`fill ${sel}=${v}`); },
      press: async (k) => { exists(); page.actions.push(`press ${sel} ${k}`); },
      selectOption: async (v) => { exists(); page.actions.push(`select ${sel}=${v}`); },
      check: async () => { exists(); page.actions.push(`check ${sel}`); },
      waitFor: async () => { exists(); },
      innerText: async () => { exists(); return page.site[page.currentUrl]?.text ?? ''; },
    };
    return loc;
  }
  async waitForLoadState() { /* settled */ }
  async waitForTimeout() { /* instant */ }
  async route(_url: string, h: (r: RRoute) => unknown) { this.router = h; }
  on(event: string, h: (a: never) => void) { (this.handlers[event] ??= []).push(h); return this; }
  async close() { this.closedPage = true; }
}
