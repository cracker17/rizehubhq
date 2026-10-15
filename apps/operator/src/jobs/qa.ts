// QA after a job (docs/17-OPERATOR.md "QA and debug loop"): every live / preview link the job reports is opened in the
// client's workspace browser (so password-protected staging and logged-in previews work) at 375 and 1366 px: HTTP
// status, console errors, page errors, failed requests, horizontal overflow at 375, a screenshot per width; then a
// link check of the page (worker research/linkcheck, SSRF-safe). qaVerdict() turns that into pass / fail with the
// findings the next run must fix (pure, tested).
import type { BrowserContext, Page } from 'playwright-core';
import { OVERFLOW_SCRIPT, type OverflowReport } from 'worker/src/research/browser';
import { checkLinks, type LinkReport } from 'worker/src/research/linkcheck';
import { assertPublicUrl, type NetEnv } from 'worker/src/research/net';
import type { WithContext } from './browser';

export const QA_WIDTHS = [375, 1366] as const;
const HEIGHT: Record<number, number> = { 375: 812, 1366: 800 };

export interface QaShot { width: number; jpeg: Buffer }
export interface QaPage {
  url: string; finalUrl: string; status: number | null; title: string;
  consoleErrors: string[]; failedRequests: string[]; overflow: OverflowReport | null; shots: QaShot[]; error: string | null;
}
export interface QaReport { pages: QaPage[]; links: (LinkReport | { page: string; error: string })[] }

/** Third-party noise that says nothing about the client's page (analytics, ads, chat widgets, browser extensions). */
const NOISE = /(google-analytics|googletagmanager|doubleclick|facebook\.net|hotjar|clarity\.ms|segment\.(io|com)|intercom|hubspot|chrome-extension:|favicon\.ico|ERR_BLOCKED_BY_CLIENT|net::ERR_ABORTED)/i;

/** The http(s) links a job reported, deduplicated, at most `max`. */
export function qaTargets(links: unknown, max = 3): string[] {
  const out: string[] = [];
  for (const l of Array.isArray(links) ? links : []) {
    if (typeof l !== 'string') continue;
    try {
      const u = new URL(l.trim());
      if ((u.protocol === 'https:' || u.protocol === 'http:') && !out.includes(u.toString())) out.push(u.toString());
    } catch { /* not a URL */ }
    if (out.length >= max) break;
  }
  return out;
}

async function checkWidth(page: Page, url: string, width: number): Promise<Omit<QaPage, 'shots' | 'url'> & { shot: Buffer | null }> {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' && consoleErrors.length < 30) consoleErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => { if (consoleErrors.length < 30) consoleErrors.push(`page error: ${e.message.slice(0, 300)}`); });
  page.on('requestfailed', (r) => { if (failedRequests.length < 30) failedRequests.push(`${r.url().slice(0, 200)} (${r.failure()?.errorText ?? 'failed'})`); });
  page.on('response', (r) => { if (r.status() >= 400 && failedRequests.length < 30) failedRequests.push(`${r.url().slice(0, 200)} → HTTP ${r.status()}`); });
  await page.setViewportSize({ width, height: HEIGHT[width] ?? 800 });
  let status: number | null = null;
  let error: string | null = null;
  try {
    const res = await page.goto(url, { waitUntil: 'load', timeout: 45_000 });
    status = res?.status() ?? null;
    await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => undefined);
    await page.waitForTimeout(800);
  } catch (e) { error = (e instanceof Error ? e.message : String(e)).slice(0, 300); }
  const overflow = width <= 480 && !error ? (await page.evaluate(OVERFLOW_SCRIPT).catch(() => null)) as OverflowReport | null : null;
  const shot = error ? null : await page.screenshot({ type: 'jpeg', quality: 55, timeout: 30_000 }).catch(() => null);
  return { finalUrl: page.url(), status, title: await page.title().catch(() => ''), consoleErrors, failedRequests, overflow, error, shot };
}

/** Runs the checks. Each URL / width is time-boxed; a failure is a finding, never a crash. */
export async function runQa(urls: string[], o: { withCtx: WithContext; net: NetEnv; widths?: readonly number[]; linkCheck?: boolean }): Promise<QaReport> {
  const report: QaReport = { pages: [], links: [] };
  for (const url of urls) {
    const page: QaPage = { url, finalUrl: url, status: null, title: '', consoleErrors: [], failedRequests: [], overflow: null, shots: [], error: null };
    try {
      await assertPublicUrl(url, o.net);
      for (const w of o.widths ?? QA_WIDTHS) {
        const r = await o.withCtx(async (ctx: BrowserContext) => {
          const p = await ctx.newPage();
          try { return await checkWidth(p, url, w); } finally { await p.close().catch(() => undefined); }
        });
        page.finalUrl = r.finalUrl; page.title = r.title || page.title;
        page.status = page.status ?? r.status;
        if (r.status !== null && r.status >= 400) page.status = r.status;
        page.error = page.error ?? r.error;
        for (const c of r.consoleErrors) if (!page.consoleErrors.includes(c)) page.consoleErrors.push(c);
        for (const f of r.failedRequests) if (!page.failedRequests.includes(f)) page.failedRequests.push(f);
        page.overflow = page.overflow ?? r.overflow;
        if (r.shot) page.shots.push({ width: w, jpeg: r.shot });
      }
    } catch (e) {
      page.error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    }
    report.pages.push(page);
    if (o.linkCheck !== false && !page.error) {
      try { report.links.push(await checkLinks(url, o.net, { maxLinks: 40, includeExternal: true, timeoutMs: 8_000 })); }
      catch (e) { report.links.push({ page: url, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) }); }
    }
  }
  return report;
}

export interface QaVerdict { pass: boolean; errors: string[]; warnings: string[] }

/** Pass = every page loads (< 400), no first-party console / page errors, no failed first-party requests, no broken links, no 375 px overflow. */
export function qaVerdict(r: QaReport): QaVerdict {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const p of r.pages) {
    let host = '';
    try { host = new URL(p.finalUrl || p.url).hostname; } catch { /* keep empty */ }
    const firstParty = (s: string) => { try { return new URL(s.split(/\s/)[0]!).hostname === host; } catch { return false; } };
    if (p.error) { errors.push(`${p.url}: did not load (${p.error})`); continue; }
    if (p.status !== null && p.status >= 400) errors.push(`${p.url}: HTTP ${p.status}`);
    for (const c of p.consoleErrors) (NOISE.test(c) ? warnings : errors).push(`${p.url}: ${c.startsWith('page error') ? c : `console error: ${c}`}`);
    for (const f of p.failedRequests) (!NOISE.test(f) && firstParty(f) ? errors : warnings).push(`${p.url}: request ${f}`);
    if (p.overflow?.overflowing) {
      errors.push(`${p.url}: horizontal scroll at 375 px (page ${p.overflow.scrollWidth}px wide; ${p.overflow.offenders.slice(0, 3).map((x) => x.el).join(', ') || 'unknown element'})`);
    }
  }
  for (const l of r.links) {
    if ('error' in l) { warnings.push(`link check of ${l.page} failed: ${l.error}`); continue; }
    for (const b of l.broken.slice(0, 15)) errors.push(`${l.page}: broken link ${b.url} → ${b.status ?? b.error ?? 'error'} ("${b.anchors[0] ?? ''}")`);
  }
  return { pass: errors.length === 0, errors: errors.slice(0, 40), warnings: warnings.slice(0, 40) };
}

/** What the next run gets when QA failed. */
export function qaFeedback(v: QaVerdict): string {
  return [`QA found ${v.errors.length} problem(s) on the pages you reported. Fix them (or explain in finish why they are not yours to fix), then check again:`,
    ...v.errors.map((e) => `- ${e}`)].join('\n').slice(0, 4000);
}

/** Compact JSON stored on the job (no image bytes). */
export function qaSummary(r: QaReport, v: QaVerdict, evidence: number[]): Record<string, unknown> {
  return {
    pass: v.pass, errors: v.errors, warnings: v.warnings.slice(0, 15), evidence,
    pages: r.pages.map((p) => ({ url: p.url, final_url: p.finalUrl, status: p.status, title: p.title.slice(0, 120),
      console_errors: p.consoleErrors.length, failed_requests: p.failedRequests.length, overflow: p.overflow?.overflowing ?? null, error: p.error })),
    links: r.links.map((l) => ('error' in l ? { page: l.page, error: l.error } : { page: l.page, checked: l.checked, broken: l.broken.length })),
  };
}
