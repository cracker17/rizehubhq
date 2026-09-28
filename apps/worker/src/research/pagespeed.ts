// PageSpeed Insights API v5 (free; PAGESPEED_API_KEY optional but raises the quota) and an optional local
// Lighthouse CLI. Both produce the same compact LighthouseSummary.
import { execFile } from 'node:child_process';
import type { ApiFetch } from './search';

export type Strategy = 'mobile' | 'desktop';
export const CATEGORIES = ['performance', 'accessibility', 'seo', 'best-practices'] as const;

export interface Opportunity { id: string; title: string; savings_ms: number | null; savings_bytes: number | null }
export interface LighthouseSummary {
  strategy: Strategy;
  source: 'pagespeed' | 'lighthouse-cli';
  url: string;
  scores: Partial<Record<(typeof CATEGORIES)[number], number>>;
  metrics: { lcp_ms: number | null; cls: number | null; tbt_ms: number | null; inp_ms: number | null; fcp_ms: number | null; si_ms: number | null };
  field: { lcp_ms: number | null; cls: number | null; inp_ms: number | null; overall: string | null } | null;
  opportunities: Opportunity[];
}

type Audit = { title?: string; score?: number | null; numericValue?: number; details?: { type?: string; overallSavingsMs?: number; overallSavingsBytes?: number } };
interface Lhr {
  finalUrl?: string; finalDisplayedUrl?: string; requestedUrl?: string;
  categories?: Record<string, { score?: number | null }>;
  audits?: Record<string, Audit>;
}
type FieldMetric = { percentile?: number; category?: string };
interface PsiResponse {
  lighthouseResult?: Lhr;
  loadingExperience?: { overall_category?: string; metrics?: Record<string, FieldMetric> };
  error?: { message?: string };
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function summarizeLhr(lhr: Lhr, strategy: Strategy, source: LighthouseSummary['source'], field?: PsiResponse['loadingExperience']): LighthouseSummary {
  const a = lhr.audits ?? {};
  const scores: LighthouseSummary['scores'] = {};
  for (const c of CATEGORIES) {
    const s = lhr.categories?.[c]?.score;
    if (typeof s === 'number') scores[c] = Math.round(s * 100);
  }
  const opportunities = Object.entries(a)
    .filter(([, x]) => (x.details?.type === 'opportunity' || (x.details?.overallSavingsMs ?? 0) > 0) && (x.score ?? 1) < 0.9)
    .map(([id, x]) => ({ id, title: x.title ?? id, savings_ms: num(x.details?.overallSavingsMs), savings_bytes: num(x.details?.overallSavingsBytes) }))
    .sort((p, q) => (q.savings_ms ?? 0) - (p.savings_ms ?? 0) || (q.savings_bytes ?? 0) - (p.savings_bytes ?? 0))
    .slice(0, 6);
  const fm = field?.metrics ?? {};
  const fieldOut = field && Object.keys(fm).length ? {
    lcp_ms: num(fm.LARGEST_CONTENTFUL_PAINT_MS?.percentile),
    cls: fm.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile != null ? fm.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100 : null,
    inp_ms: num(fm.INTERACTION_TO_NEXT_PAINT?.percentile),
    overall: field.overall_category ?? null,
  } : null;
  return {
    strategy, source, url: lhr.finalDisplayedUrl ?? lhr.finalUrl ?? lhr.requestedUrl ?? '',
    scores,
    metrics: {
      lcp_ms: num(a['largest-contentful-paint']?.numericValue),
      cls: num(a['cumulative-layout-shift']?.numericValue),
      tbt_ms: num(a['total-blocking-time']?.numericValue),
      inp_ms: num(a['interaction-to-next-paint']?.numericValue) ?? fieldOut?.inp_ms ?? null,
      fcp_ms: num(a['first-contentful-paint']?.numericValue),
      si_ms: num(a['speed-index']?.numericValue),
    },
    field: fieldOut,
    opportunities,
  };
}

export async function runPageSpeed(url: string, strategy: Strategy, f: ApiFetch, key?: string, timeoutMs = 90_000): Promise<LighthouseSummary> {
  const u = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
  u.searchParams.set('url', url);
  u.searchParams.set('strategy', strategy);
  for (const c of CATEGORIES) u.searchParams.append('category', c);
  if (key) u.searchParams.set('key', key);
  const res = await f(u, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  const j = (await res.json().catch(() => ({}))) as PsiResponse;
  if (!res.ok || !j.lighthouseResult) {
    throw new Error(`PageSpeed Insights ${res.status}: ${(j.error?.message ?? 'no lighthouseResult').slice(0, 300)}`);
  }
  return summarizeLhr(j.lighthouseResult, strategy, 'pagespeed', j.loadingExperience);
}

const ms = (v: number | null) => (v == null ? 'n/a' : `${(v / 1000).toFixed(2)} s`);
export function formatSummary(s: LighthouseSummary): string {
  const sc = CATEGORIES.map((c) => `${c} ${s.scores[c] ?? 'n/a'}`).join(' · ');
  const m = s.metrics;
  const lines = [
    `${s.strategy.toUpperCase()} (${s.source}) ${s.url}`,
    `Scores: ${sc}`,
    `Lab: LCP ${ms(m.lcp_ms)} · CLS ${m.cls == null ? 'n/a' : m.cls.toFixed(3)} · TBT ${m.tbt_ms == null ? 'n/a' : `${Math.round(m.tbt_ms)} ms`} · FCP ${ms(m.fcp_ms)} · INP ${m.inp_ms == null ? 'n/a (needs field data)' : `${Math.round(m.inp_ms)} ms`}`,
  ];
  if (s.field) lines.push(`Field (CrUX p75): LCP ${ms(s.field.lcp_ms)} · CLS ${s.field.cls ?? 'n/a'} · INP ${s.field.inp_ms == null ? 'n/a' : `${s.field.inp_ms} ms`} · overall ${s.field.overall ?? 'n/a'}`);
  if (s.opportunities.length) {
    lines.push('Top opportunities:');
    for (const o of s.opportunities) lines.push(`- ${o.title}${o.savings_ms ? ` (~${Math.round(o.savings_ms)} ms)` : ''}${o.savings_bytes ? ` (~${Math.round(o.savings_bytes / 1024)} KiB)` : ''}`);
  }
  return lines.join('\n');
}

// ---------- optional local Lighthouse CLI ----------
export type ExecFn = (cmd: string, args: string[], opts: { timeout: number; env: NodeJS.ProcessEnv; maxBuffer: number }) => Promise<{ stdout: string; stderr: string }>;
export const execFileText: ExecFn = (cmd, args, opts) => new Promise((resolve, reject) => {
  execFile(cmd, args, opts, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr: String(stderr) })) : resolve({ stdout: String(stdout), stderr: String(stderr) })));
});

/** Runs `lighthouse` (LIGHTHOUSE_CLI, else `npx --no-install lighthouse`, which fails fast if not installed). */
export async function runLocalLighthouse(url: string, strategy: Strategy, exec: ExecFn, chromePath?: string): Promise<LighthouseSummary> {
  const cli = process.env.LIGHTHOUSE_CLI;
  const [cmd, pre] = cli ? [cli, [] as string[]] : ['npx', ['--no-install', 'lighthouse']];
  const args = [...pre, url, '--output=json', '--quiet', `--only-categories=${CATEGORIES.join(',')}`,
    '--chrome-flags=--headless=new --no-sandbox --disable-gpu', ...(strategy === 'desktop' ? ['--preset=desktop'] : [])];
  const { stdout: out } = await exec(cmd, args, {
    timeout: 150_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...(chromePath ? { CHROME_PATH: chromePath } : {}) },
  });
  const start = out.indexOf('{');
  if (start < 0) throw new Error('Lighthouse CLI printed no JSON');
  return summarizeLhr(JSON.parse(out.slice(start)) as Lhr, strategy, 'lighthouse-cli');
}
