// One CDP connection per client browser profile (docs/17-OPERATOR.md "Workspace"). The browsers run headful in the
// workspace containers (Julev watches and can take over in the viewer); the operator only attaches over CDP and never
// launches or closes them. Every action on a profile runs through its lock, so the watcher and a send never type into
// the same browser at once.
//
// Chrome's DevTools HTTP endpoint refuses a Host header that is not an IP or localhost (DNS-rebinding protection), so a
// Docker service name like http://ws-lvlup:9223 is resolved to its IP before connecting.
import dns from 'node:dns/promises';
import net from 'node:net';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

export async function resolveCdpEndpoint(endpoint: string, lookup: (host: string) => Promise<string> = async (h) => (await dns.lookup(h)).address): Promise<string> {
  const u = new URL(endpoint);
  if (!/^https?:$|^wss?:$/.test(u.protocol)) throw new Error(`CDP endpoint must be http(s) or ws(s): ${endpoint}`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || net.isIP(host)) return u.toString().replace(/\/+$/, '');
  const ip = await lookup(host);
  u.hostname = net.isIPv6(ip) ? `[${ip}]` : ip;
  return u.toString().replace(/\/+$/, '');
}

class Lock {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

interface Conn { browser: Browser; endpoint: string }

export class BrowserPool {
  private conns = new Map<string, Conn>();
  private locks = new Map<string, Lock>();

  constructor(private endpointFor: (profile: string) => string | null, private log: (m: string) => void = console.log) {}

  /** Runs fn with the profile's default context, holding the profile lock. Reconnects when the browser went away. */
  with<T>(profile: string, fn: (ctx: BrowserContext) => Promise<T>): Promise<T> {
    let lock = this.locks.get(profile);
    if (!lock) { lock = new Lock(); this.locks.set(profile, lock); }
    return lock.run(async () => fn(await this.context(profile)));
  }

  private async context(profile: string): Promise<BrowserContext> {
    const endpoint = this.endpointFor(profile);
    if (!endpoint) throw new Error(`no CDP endpoint for profile "${profile}" (set OPERATOR_CDP_${profile.toUpperCase().replace(/[^A-Z0-9]+/g, '_')})`);
    let c = this.conns.get(profile);
    if (c && (!c.browser.isConnected() || c.endpoint !== endpoint)) {
      // Never browser.close(): the workspace owns the browser; dropping the reference is enough (the socket is gone or
      // the endpoint changed, and the old one is closed when the process exits).
      this.conns.delete(profile);
      c = undefined;
    }
    if (!c) {
      const browser = await chromium.connectOverCDP(await resolveCdpEndpoint(endpoint), { timeout: 20_000 });
      c = { browser, endpoint };
      this.conns.set(profile, c);
      this.log(`[operator] attached to the ${profile} browser`);
    }
    const ctx = c.browser.contexts()[0];
    if (!ctx) throw new Error(`the ${profile} browser has no default context (is it running with a persistent profile?)`);
    return ctx;
  }

  /** Forget every connection (shutdown). The browsers keep running in the workspace. */
  forgetAll(): void { this.conns.clear(); }
}

/** The operator's own tab for a chat URL: reused when open (Julev's other tabs are never touched), else opened. */
export async function chatPage(ctx: BrowserContext, url: string): Promise<{ page: Page; opened: boolean }> {
  // Full URL including the #fragment: mail.google.com/chat keeps the space id there.
  const base = url.replace(/\/+$/, '');
  const hit = ctx.pages().find((p) => !p.isClosed() && p.url().replace(/\/+$/, '').startsWith(base));
  if (hit) return { page: hit, opened: false };
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  return { page, opened: true };
}
