// link_checker: fetch a page, check up to N of its links (same-origin by default), HEAD then GET fallback.
import { extractLinks } from './html';
import { BlockedUrlError, safeFetch, type NetEnv } from './net';

export interface LinkIssue { url: string; status: number | null; error: string | null; anchors: string[] }
export interface LinkReport {
  page: string; found: number; checked: number; ok: number; skipped: number;
  broken: LinkIssue[]; blocked: string[]; redirected: number; truncated: boolean;
}

export interface LinkCheckOptions { maxLinks?: number; includeExternal?: boolean; concurrency?: number; timeoutMs?: number }

async function probe(url: string, net: NetEnv, timeoutMs: number): Promise<{ status: number | null; error: string | null; redirected: boolean; blocked: boolean }> {
  const tryOnce = async (method: 'HEAD' | 'GET') => safeFetch(url, net, { method, timeoutMs, maxBytes: 16 * 1024, maxRedirects: 5 });
  try {
    let r = await tryOnce('HEAD');
    if ([403, 405, 429, 501].includes(r.status) || r.status >= 500) r = await tryOnce('GET');
    return { status: r.status, error: null, redirected: r.redirects.length > 0, blocked: false };
  } catch (e) {
    if (e instanceof BlockedUrlError) return { status: null, error: e.message, redirected: false, blocked: true };
    // HEAD can hang or be refused on some servers: one GET retry before calling it broken.
    try {
      const r = await tryOnce('GET');
      return { status: r.status, error: null, redirected: r.redirects.length > 0, blocked: false };
    } catch (e2) {
      return { status: null, error: (e2 instanceof Error ? e2.message : String(e2)).slice(0, 200), redirected: false, blocked: e2 instanceof BlockedUrlError };
    }
  }
}

export async function checkLinks(pageUrl: string, net: NetEnv, o: LinkCheckOptions = {}): Promise<LinkReport> {
  const maxLinks = Math.min(o.maxLinks ?? 50, 200);
  const timeoutMs = o.timeoutMs ?? 8_000;
  const page = await safeFetch(pageUrl, net, { timeoutMs: 15_000 });
  if (page.status >= 400) throw new Error(`The page itself returned HTTP ${page.status}`);
  const html = page.body.toString('utf8');
  const origin = new URL(page.url).origin;
  const byUrl = new Map<string, string[]>();
  for (const l of extractLinks(html, page.url)) {
    if (!o.includeExternal && new URL(l.url).origin !== origin) continue;
    const a = byUrl.get(l.url) ?? [];
    if (l.text && !a.includes(l.text) && a.length < 3) a.push(l.text);
    byUrl.set(l.url, a);
  }
  const all = [...byUrl.entries()];
  const todo = all.slice(0, maxLinks);
  const report: LinkReport = { page: page.url, found: all.length, checked: 0, ok: 0, skipped: 0, broken: [], blocked: [], redirected: 0, truncated: all.length > maxLinks };
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const [url, anchors] = todo[next++]!;
      const r = await probe(url, net, timeoutMs);
      report.checked++;
      if (r.blocked) { report.skipped++; report.blocked.push(url); continue; }
      if (r.redirected) report.redirected++;
      if (r.error || (r.status !== null && r.status >= 400)) report.broken.push({ url, status: r.status, error: r.error, anchors: anchors.length ? anchors : ['(no anchor text)'] });
      else report.ok++;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency ?? 5, 10)) }, worker));
  report.broken.sort((a, b) => a.url.localeCompare(b.url));
  return report;
}

export function formatLinkReport(r: LinkReport): string {
  const lines = [`Link check of ${r.page}: ${r.found} unique link(s) found, ${r.checked} checked${r.truncated ? ' (limit reached)' : ''}; `
    + `${r.ok} ok, ${r.broken.length} broken, ${r.skipped} skipped (private/blocked), ${r.redirected} redirected.`];
  if (r.broken.length) {
    lines.push('Broken:');
    for (const b of r.broken) lines.push(`- ${b.url} → ${b.status ?? 'error'}${b.error ? ` (${b.error})` : ''} · anchor: ${b.anchors.map((a) => `"${a}"`).join(', ')}`);
  }
  if (r.blocked.length) lines.push(`Not checked (private/blocked addresses): ${r.blocked.slice(0, 10).join(', ')}`);
  return lines.join('\n');
}
