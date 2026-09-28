// Automatic QA evidence (docs/05 [5]): before the QA Lead gives a verdict on output with a preview_url or
// http(s) links, capture screenshots at 375/768/1440, console errors, a 375px overflow check and PageSpeed
// (mobile) for the primary URL, and a reachability check for the other links. Every step is optional and
// time-boxed; offline or without a browser the summary just says what could not be collected.
import type { TaskOutput } from '../hqdb';
import type { ResearchEnv } from './env';
import { checkUrlShape, safeFetch } from './net';
import { captureScreenshots } from './pageChecks';
import { formatSummary, runPageSpeed } from './pagespeed';

export const QA_WIDTHS = [375, 768, 1440];

export interface QaEvidence {
  primaryUrl: string;
  /** Compact text for the QA prompt. */
  summary: string;
  /** Screenshot refs (signed URL / storage path / local path) to attach to verdict checks. */
  refs: string[];
}

/** preview_url first, then http(s) links; syntactically unsafe URLs (private IPs, internal hosts) are dropped. */
export function evidenceTargets(output: Partial<TaskOutput> | null | undefined, allowPrivateHosts: readonly string[] = [], max = 3): string[] {
  const cands = [output?.preview_url ?? '', ...(Array.isArray(output?.links) ? output!.links : [])]
    .filter((u): u is string => typeof u === 'string' && /^https?:\/\//i.test(u.trim()))
    .map((u) => u.trim());
  const out: string[] = [];
  for (const c of cands) {
    try { checkUrlShape(c, allowPrivateHosts); } catch { continue; }
    if (!out.includes(c)) out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message.split('\n')[0]! : String(e)).slice(0, 240);
const uniq = (a: string[]) => [...new Set(a)];

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export async function collectQaEvidence(taskId: string, output: Partial<TaskOutput> | null | undefined, env: ResearchEnv): Promise<QaEvidence | null> {
  const targets = evidenceTargets(output, env.net.allowPrivateHosts);
  if (!targets.length) return null;
  const [primary, ...others] = targets as [string, ...string[]];
  const budget = env.qaEvidenceTimeoutMs;
  const lines: string[] = [`Primary URL: ${primary}`];
  const refs: string[] = [];

  const shotsP = withTimeout(captureScreenshots(primary, QA_WIDTHS, true, {
    net: env.net, launch: env.launchBrowser, evidence: env.evidence, taskId,
  }), budget, 'Screenshots');
  const psiP = withTimeout(runPageSpeed(primary, 'mobile', env.apiFetch, env.env.PAGESPEED_API_KEY, Math.min(budget, 90_000)), budget, 'PageSpeed');
  const linksP = Promise.all(others.map(async (u) => {
    try {
      const r = await safeFetch(u, env.net, { method: 'GET', timeoutMs: 8_000, maxBytes: 16 * 1024 });
      return `- ${u} → HTTP ${r.status}${r.redirects.length ? ` (redirected to ${r.url})` : ''}`;
    } catch (e) { return `- ${u} → not reachable: ${errMsg(e)}`; }
  }));
  const [shots, psi, links] = await Promise.allSettled([shotsP, psiP, linksP]);

  if (shots.status === 'fulfilled') {
    const s = shots.value;
    lines.push(`Page: HTTP ${s.status ?? '?'} · title "${s.title.slice(0, 120)}"${s.finalUrl !== primary ? ` · final URL ${s.finalUrl}` : ''}`);
    lines.push(`Screenshots (full page): ${s.shots.map((x) => `${x.width}px ${x.ref}`).join(' · ')}`);
    refs.push(...s.shots.map((x) => x.ref));
    const errs = uniq(s.consoleErrors);
    lines.push(errs.length ? `Console/page errors (${errs.length}):\n${errs.slice(0, 12).map((e) => `  - ${e}`).join('\n')}` : 'Console errors: none');
    const bad = uniq(s.failedResponses);
    if (bad.length) lines.push(`Failed sub-requests (${bad.length}):\n${bad.slice(0, 8).map((e) => `  - ${e}`).join('\n')}`);
    if (s.overflow) {
      lines.push(s.overflow.overflowing
        ? `Mobile 375px: HORIZONTAL OVERFLOW (scrollWidth ${s.overflow.scrollWidth} > ${s.overflow.viewport}); offenders: ${s.overflow.offenders.slice(0, 5).map((o) => o.el).join(', ')}`
        : 'Mobile 375px: no horizontal overflow');
    }
    if (s.blocked.length) lines.push(`Blocked by the QA browser guard: ${s.blocked.slice(0, 5).join('; ')}`);
  } else {
    lines.push(`Screenshots/console: not collected (${errMsg(shots.reason)}). Treat visual/console checks as unverified.`);
  }
  if (psi.status === 'fulfilled') lines.push(`PageSpeed Insights:\n${formatSummary(psi.value)}`);
  else lines.push(`PageSpeed: not collected (${errMsg(psi.reason)}).`);
  if (links.status === 'fulfilled' && links.value.length) lines.push(`Other links:\n${links.value.join('\n')}`);

  return { primaryUrl: primary, summary: lines.join('\n'), refs };
}

/** Adds evidence refs to every check (keeps what QA wrote; capped so the verdict stays compact). */
export function attachEvidence<T extends { evidence?: string }>(checks: T[], refs: string[]): T[] {
  if (!refs.length) return checks;
  return checks.map((c) => {
    const have = c.evidence?.trim() ?? '';
    const add = refs.filter((r) => !have.includes(r));
    if (!add.length) return c;
    const joined = [have, ...add].filter(Boolean).join(' ');
    return { ...c, evidence: joined.length > 4000 ? `${joined.slice(0, 3997)}...` : joined };
  });
}
