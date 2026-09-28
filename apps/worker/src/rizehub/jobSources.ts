// Job sources for the Sales Agent's job-search work (docs/13 §2): public RSS/JSON feeds of remote job boards + links the CEO pastes. No logins,
// no scraping behind auth, no applying. Every source is fetched with a timeout; a source that fails (offline,
// blocked, changed format) is reported and skipped, never fatal. Items are deduped by canonical URL.
// Extra RSS/Atom feeds: JOB_FEEDS="https://a.example/jobs.rss,https://b.example/feed" (worker env).

export interface JobItem {
  url: string;
  title: string;
  company: string | null;
  source: string;                 // source id, e.g. "weworkremotely"
  platform_tags: string[];
  rate: string | null;
  posted_at: string | null;       // ISO
  summary: string;                // plain text, ≤ 400 chars
  location: string | null;
}

export interface JobSource {
  id: string;
  name: string;
  kind: 'rss' | 'json';
  url: string;
  /** Terms of use worth knowing (attribution, request limits). */
  note?: string;
  /** WWR-style titles "Company: Role". */
  splitCompanyFromTitle?: boolean;
  /** JSON sources: map the parsed body to items (source is filled in by the caller). */
  mapJson?: (body: unknown) => Omit<JobItem, 'source' | 'platform_tags'>[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function money(min: unknown, max: unknown, cur: unknown = 'USD', per = 'year'): string | null {
  const a = Number(min); const b = Number(max);
  if (!(a > 0) && !(b > 0)) return null;
  const f = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const c = s(cur) ?? 'USD';
  return a > 0 && b > 0 ? `${c} ${f(a)}–${f(b)}/${per}` : `${c} ${f(a > 0 ? a : b)}/${per}`;
}
function isoDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(String(v));
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
}

export const DEFAULT_JOB_SOURCES: JobSource[] = [
  { id: 'weworkremotely', name: 'We Work Remotely · Full-Stack', kind: 'rss', url: 'https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss', splitCompanyFromTitle: true },
  { id: 'weworkremotely', name: 'We Work Remotely · Front-End', kind: 'rss', url: 'https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss', splitCompanyFromTitle: true },
  {
    id: 'remotive', name: 'Remotive · Software Dev', kind: 'json', url: 'https://remotive.com/api/remote-jobs?category=software-dev&limit=100',
    note: 'Public API: link back to Remotive, keep to a few requests per day.',
    mapJson: (b) => arr(isObj(b) ? b.jobs : null).filter(isObj).map((j) => ({
      url: s(j.url) ?? '', title: s(j.title) ?? '', company: s(j.company_name), rate: s(j.salary), posted_at: isoDate(j.publication_date),
      summary: [arr(j.tags).join(' '), s(j.description) ?? ''].join(' '), location: s(j.candidate_required_location),
    })),
  },
  {
    id: 'remoteok', name: 'Remote OK', kind: 'json', url: 'https://remoteok.com/api',
    note: 'Public API: attribution link to Remote OK required; first array element is a legal notice.',
    mapJson: (b) => arr(b).filter((j): j is Obj => isObj(j) && Boolean(j.position)).map((j) => ({
      url: s(j.url) ?? '', title: s(j.position) ?? '', company: s(j.company), rate: money(j.salary_min, j.salary_max),
      posted_at: isoDate(j.date ?? j.epoch), summary: [arr(j.tags).join(' '), s(j.description) ?? ''].join(' '), location: s(j.location),
    })),
  },
  {
    id: 'jobicy', name: 'Jobicy · Dev', kind: 'json', url: 'https://jobicy.com/api/v2/remote-jobs?count=50&industry=dev',
    note: 'Public API: attribution to Jobicy; hourly polling at most.',
    mapJson: (b) => arr(isObj(b) ? b.jobs : null).filter(isObj).map((j) => ({
      url: s(j.url) ?? '', title: s(j.jobTitle) ?? '', company: s(j.companyName), rate: money(j.annualSalaryMin, j.annualSalaryMax, j.salaryCurrency),
      posted_at: isoDate(j.pubDate), summary: [arr(j.jobIndustry).join(' '), s(j.jobExcerpt) ?? ''].join(' '), location: s(j.jobGeo),
    })),
  },
  {
    id: 'himalayas', name: 'Himalayas', kind: 'json', url: 'https://himalayas.app/jobs/api?limit=50',
    note: 'Public API: link back to Himalayas.',
    mapJson: (b) => arr(isObj(b) ? b.jobs : null).filter(isObj).map((j) => ({
      url: s(j.applicationLink) ?? s(j.guid) ?? '', title: s(j.title) ?? '', company: s(j.companyName),
      rate: money(j.minSalary, j.maxSalary, j.currency), posted_at: isoDate(j.pubDate),
      summary: [arr(j.categories).join(' '), s(j.excerpt) ?? ''].join(' '), location: arr(j.locationRestrictions).map(String).join(', ') || null,
    })),
  },
];

export function sourcesFromEnv(env: NodeJS.ProcessEnv = process.env): JobSource[] {
  const extra = (env.JOB_FEEDS ?? '').split(',').map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u));
  return [...DEFAULT_JOB_SOURCES, ...extra.map((url, i) => ({ id: `feed-${new URL(url).hostname.replace(/^www\./, '')}`, name: `Custom feed ${i + 1}`, kind: 'rss' as const, url }))];
}

// ---------- URL canonicalisation (dedupe key) ----------
const TRACKING = /^(utm_[a-z]+|ref|ref_src|source|src|fbclid|gclid|mc_[a-z]+|trk|trackingid|refid)$/i;
export function canonicalJobUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  u.protocol = 'https:';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.searchParams.sort();
  const path = u.pathname.replace(/\/+$/, '') || '/';
  return `${u.protocol}//${u.host}${path === '/' ? '' : path}${u.searchParams.toString() ? `?${u.searchParams}` : ''}`;
}

// ---------- RSS / Atom ----------
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', hellip: '…' };
export function decodeXml(v: string): string {
  return v.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m);
}
export function stripHtml(v: string): string {
  return v.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name.replace(':', '\\:')}\\b[^>]*>([\\s\\S]*?)</${name.replace(':', '\\:')}>`, 'i'));
  return m ? decodeXml(m[1]!).trim() || null : null;
}
function tags(block: string, name: string): string[] {
  const out: string[] = [];
  for (const m of block.matchAll(new RegExp(`<${name}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${name}>)`, 'gi'))) {
    const term = m[1]?.match(/term="([^"]+)"/)?.[1];
    const v = decodeXml(term ?? m[2] ?? '').trim();
    if (v) out.push(v);
  }
  return out;
}

export function parseFeed(xml: string, src: Pick<JobSource, 'splitCompanyFromTitle'> = {}): Omit<JobItem, 'source' | 'platform_tags'>[] {
  const blocks = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi), ...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((m) => m[0]);
  return blocks.map((b) => {
    let title = decodeXml(stripHtml(tag(b, 'title') ?? ''));
    let link = tag(b, 'link');
    if (!link || !/^https?:/i.test(link)) {
      const alt = b.match(/<link\b[^>]*rel="alternate"[^>]*href="([^"]+)"/i) ?? b.match(/<link\b[^>]*href="([^"]+)"/i);
      link = alt ? decodeXml(alt[1]!) : tag(b, 'guid');
    }
    let company = tag(b, 'company') ?? tag(b, 'job_listing:company') ?? null;
    if (!company && src.splitCompanyFromTitle) {
      const i = title.indexOf(': ');
      if (i > 0 && i < 80) { company = title.slice(0, i).trim(); title = title.slice(i + 2).trim(); }
    }
    const desc = decodeXml(stripHtml(tag(b, 'description') ?? tag(b, 'summary') ?? tag(b, 'content') ?? tag(b, 'content:encoded') ?? ''));
    return {
      url: link ?? '', title, company: company ? stripHtml(company) : null,
      rate: tag(b, 'salary') ?? null,
      posted_at: isoDate(tag(b, 'pubDate') ?? tag(b, 'published') ?? tag(b, 'updated') ?? tag(b, 'dc:date')),
      summary: [tags(b, 'category').join(' '), desc].join(' ').trim(),
      location: tag(b, 'region') ?? tag(b, 'location'),
    };
  });
}

// ---------- screening helpers ----------
export const DEFAULT_TERMS = ['shopify', 'liquid', 'webflow', 'wordpress', 'woocommerce', 'elementor', 'front-end', 'frontend', 'front end', 'web developer', 'figma'];
const PLATFORM_RULES: [string, RegExp][] = [
  ['shopify', /\bshopify\b|\bliquid\b/i], ['webflow', /\bwebflow\b/i], ['wordpress', /\bwordpress\b|\bwoocommerce\b|\belementor\b/i],
  ['frontend', /\bfront[- ]?end\b|\breact\b|\bnext\.?js\b|\bvue\b/i], ['figma', /\bfigma\b/i],
];
export function platformTags(text: string): string[] {
  return PLATFORM_RULES.filter(([, re]) => re.test(text)).map(([t]) => t);
}

// ---------- fetching ----------
export interface FetchFeedsOptions {
  sources?: JobSource[];
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  maxBytes?: number;
  terms?: string[];                 // keep items mentioning any term (title/summary); [] keeps everything
  sinceDays?: number;               // drop items older than this (items without a date are kept)
  now?: Date;
  limit?: number;
}
export interface SourceReport { id: string; name: string; ok: boolean; items: number; kept: number; error?: string }

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > maxBytes) throw new Error(`feed too large (${len} bytes)`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`feed too large (${buf.length} bytes)`);
  return buf.toString('utf8');
}

export async function fetchSource(src: JobSource, o: FetchFeedsOptions = {}): Promise<JobItem[]> {
  const f = o.fetch ?? ((url, init) => fetch(url, init));
  const res = await f(src.url, {
    headers: { 'user-agent': 'RizeHubHQ-JobFeeds/1.0 (+https://rizehub.ph)', accept: src.kind === 'rss' ? 'application/rss+xml, application/atom+xml, text/xml' : 'application/json' },
    signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await readCapped(res, o.maxBytes ?? 3_000_000);
  let raw: Omit<JobItem, 'source' | 'platform_tags'>[];
  if (src.kind === 'rss') raw = parseFeed(text, src);
  else {
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new Error('response is not JSON'); }
    raw = (src.mapJson ?? (() => []))(body);
  }
  return raw.flatMap((r) => {
    const url = canonicalJobUrl(r.url);
    if (!url || !r.title) return [];
    const summary = decodeXml(stripHtml(r.summary)).replace(/\s+/g, ' ').trim().slice(0, 400);
    return [{ ...r, url, title: decodeXml(stripHtml(r.title)).slice(0, 300), company: r.company ? decodeXml(stripHtml(r.company)) : null, summary, source: src.id, platform_tags: platformTags(`${r.title} ${r.summary}`) }];
  });
}

/** Fetch every source (in parallel), filter by terms + age, dedupe by canonical URL. Never throws. */
export async function fetchJobFeeds(o: FetchFeedsOptions = {}): Promise<{ items: JobItem[]; sources: SourceReport[] }> {
  const sources = o.sources ?? sourcesFromEnv();
  const terms = (o.terms ?? DEFAULT_TERMS).map((t) => t.toLowerCase());
  const cutoff = (o.now ?? new Date()).getTime() - (o.sinceDays ?? 14) * 86_400_000;
  const seen = new Set<string>();
  const items: JobItem[] = [];
  const reports = await Promise.all(sources.map(async (src): Promise<[SourceReport, JobItem[]]> => {
    try {
      const got = await fetchSource(src, o);
      const kept = got.filter((it) => {
        if (it.posted_at && Date.parse(it.posted_at) < cutoff) return false;
        if (!terms.length) return true;
        const hay = `${it.title} ${it.summary}`.toLowerCase();
        return terms.some((t) => hay.includes(t));
      });
      return [{ id: src.id, name: src.name, ok: true, items: got.length, kept: kept.length }, kept];
    } catch (e) {
      const msg = e instanceof Error ? (e.name === 'TimeoutError' ? 'timed out' : e.message) : String(e);
      return [{ id: src.id, name: src.name, ok: false, items: 0, kept: 0, error: msg.slice(0, 200) }, []];
    }
  }));
  for (const [, list] of reports) {
    for (const it of list) {
      if (seen.has(it.url)) continue;
      seen.add(it.url);
      items.push(it);
    }
  }
  items.sort((a, b) => (b.posted_at ?? '').localeCompare(a.posted_at ?? ''));
  return { items: items.slice(0, o.limit ?? 200), sources: reports.map(([r]) => r) };
}
