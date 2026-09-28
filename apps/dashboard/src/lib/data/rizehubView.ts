// View models for /leads and /jobs (docs/06 §7b, §7c). Pure: safe in server and client components.
// Leads come from rizehub_refs (kind 'lead', summary written by the worker's RizeHub tools); jobs from job_opportunities.

export const LEAD_STAGES = ['new', 'researched', 'drafted', 'contacted', 'replied', 'proposal', 'won', 'lost'] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

/** Board columns: Won and Lost share the last one. */
export const BOARD_COLUMNS: { id: string; label: string; stages: LeadStage[]; color: string }[] = [
  { id: 'new', label: 'New', stages: ['new'], color: 'var(--color-dim)' },
  { id: 'researched', label: 'Researched', stages: ['researched'], color: 'var(--color-info)' },
  { id: 'drafted', label: 'Drafted', stages: ['drafted'], color: 'var(--color-primary-hover)' },
  { id: 'contacted', label: 'Contacted', stages: ['contacted'], color: 'var(--color-warning)' },
  { id: 'replied', label: 'Replied', stages: ['replied'], color: 'var(--color-teal)' },
  { id: 'proposal', label: 'Proposal', stages: ['proposal'], color: '#c084fc' },
  { id: 'closed', label: 'Won / Lost', stages: ['won', 'lost'], color: 'var(--color-success)' },
];

export interface LeadCard {
  id: string;                 // RizeHub lead id
  company: string;
  website: string | null;
  platform: string | null;
  country: string | null;
  city: string | null;
  industry: string | null;
  signal: string | null;      // main signal, e.g. "LCP 6.2 s"
  signals: string[];
  score: number | null;       // Lead Finder score
  fitScore: number | null;    // agent fit score
  angle: string | null;
  stage: LeadStage;
  appUrl: string | null;      // open in RizeHub Lead Finder
  list: string | null;
  createdAt: string;
  updatedAt: string;
  contactedAt: string | null;
  repliedAt: string | null;
  proposalAt: string | null;
}

export interface LeadStats { foundThisWeek: number; reached: number; replied: number; replyRate: number | null; proposals: number; won: number }
export interface LeadsData { mode: 'demo' | 'live'; leads: LeadCard[]; error?: string }

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

export function leadFromRef(r: { rizehub_id: string; summary: Record<string, unknown> | null; created_at: string; updated_at?: string | null }): LeadCard {
  const s = r.summary ?? {};
  const stage = (LEAD_STAGES as readonly string[]).includes(String(s.stage)) ? (s.stage as LeadStage) : 'new';
  return {
    id: r.rizehub_id, company: str(s.company) ?? r.rizehub_id, website: str(s.website), platform: str(s.platform)?.toLowerCase() ?? null,
    country: str(s.country), city: str(s.city), industry: str(s.industry), signal: str(s.signal),
    signals: Array.isArray(s.signals) ? s.signals.map(String).slice(0, 4) : [], score: num(s.score), fitScore: num(s.fit_score),
    angle: str(s.angle), stage, appUrl: str(s.app_url), list: str(s.list), createdAt: r.created_at, updatedAt: r.updated_at ?? r.created_at,
    contactedAt: str(s.contacted_at), repliedAt: str(s.replied_at), proposalAt: str(s.proposal_at),
  };
}

const REACHED: LeadStage[] = ['contacted', 'replied', 'proposal', 'won'];
const REPLIED: LeadStage[] = ['replied', 'proposal', 'won'];
export function leadStats(leads: LeadCard[], now = new Date()): LeadStats {
  const weekAgo = now.getTime() - 7 * 86_400_000;
  const reached = leads.filter((l) => REACHED.includes(l.stage) || (l.stage === 'lost' && l.contactedAt)).length;
  const replied = leads.filter((l) => REPLIED.includes(l.stage) || (l.stage === 'lost' && l.repliedAt)).length;
  return {
    foundThisWeek: leads.filter((l) => Date.parse(l.createdAt) >= weekAgo).length,
    reached, replied, replyRate: reached ? Math.round((replied / reached) * 100) : null,
    proposals: leads.filter((l) => l.stage === 'proposal' || l.stage === 'won' || (l.stage === 'lost' && l.proposalAt)).length,
    won: leads.filter((l) => l.stage === 'won').length,
  };
}

export const PLATFORM_COLOR: Record<string, string> = { shopify: '#5FBF4A', webflow: '#4353FF', wordpress: '#3a9bd5', frontend: '#14B8A6', figma: '#A259FF', other: '#6E6A9E' };
export const PLATFORM_LABEL: Record<string, string> = { shopify: 'Shopify', webflow: 'Webflow', wordpress: 'WordPress', frontend: 'Front-end', figma: 'Figma', other: 'Other' };

export function domainOf(url: string | null): string | null {
  if (!url) return null;
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}
/** Only http(s) links are rendered as links (data comes from outside). */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try { const u = new URL(url); return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null; } catch { return null; }
}
export function fitTone(score: number | null): string {
  if (score === null) return 'var(--color-dim)';
  return score >= 75 ? 'var(--color-success)' : score >= 50 ? 'var(--color-warning)' : 'var(--color-danger)';
}

// ---------- jobs ----------
export const JOB_STATUSES = ['found', 'shortlisted', 'drafted', 'approved', 'applied', 'replied', 'interview', 'offer', 'rejected', 'skipped'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  found: 'Found', shortlisted: 'Shortlisted', drafted: 'Draft ready', approved: 'Approved', applied: 'Applied', replied: 'Replied',
  interview: 'Interview', offer: 'Offer', rejected: 'Rejected', skipped: 'Skipped',
};
export const JOB_STATUS_COLOR: Record<JobStatus, string> = {
  found: 'var(--color-dim)', shortlisted: 'var(--color-info)', drafted: 'var(--color-primary-hover)', approved: 'var(--color-primary-hover)',
  applied: 'var(--color-warning)', replied: 'var(--color-teal)', interview: 'var(--color-teal)', offer: 'var(--color-success)',
  rejected: 'var(--color-danger)', skipped: 'var(--color-dim)',
};
export const SOURCE_LABEL: Record<string, string> = {
  onlinejobs: 'OnlineJobs.ph', indeed: 'Indeed', linkedin: 'LinkedIn', upwork: 'Upwork', seek: 'Seek', pasted: 'Pasted link',
  weworkremotely: 'We Work Remotely', remotive: 'Remotive', remoteok: 'Remote OK', jobicy: 'Jobicy', himalayas: 'Himalayas', 'remote-board': 'Remote board',
};
export const sourceLabel = (s: string) => SOURCE_LABEL[s] ?? s.replace(/^feed-/, '');

export interface JobRow {
  id: string;
  source: string;
  url: string;
  title: string;
  company: string | null;
  platform_tags: string[];
  rate: string | null;
  posted_at: string | null;
  fit_score: number | null;
  fit_reasons: string[];
  red_flags: string[];
  draft: string | null;
  status: JobStatus;
  applied_at: string | null;
  follow_up_at: string | null;
  notes: string | null;
  created_at: string;
}
export interface JobsData { mode: 'demo' | 'live'; jobs: JobRow[]; error?: string }

export function normalizeJob(r: Record<string, unknown>): JobRow {
  const arr = (v: unknown) => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : []);
  return {
    id: String(r.id), source: String(r.source ?? 'pasted'), url: String(r.url ?? ''), title: String(r.title ?? 'Untitled job'),
    company: str(r.company), platform_tags: arr(r.platform_tags).map((t) => t.toLowerCase()), rate: str(r.rate), posted_at: str(r.posted_at),
    fit_score: num(r.fit_score), fit_reasons: arr(r.fit_reasons), red_flags: arr(r.red_flags), draft: str(r.draft),
    status: (JOB_STATUSES as readonly string[]).includes(String(r.status)) ? (r.status as JobStatus) : 'found',
    applied_at: str(r.applied_at), follow_up_at: str(r.follow_up_at), notes: str(r.notes), created_at: String(r.created_at ?? new Date(0).toISOString()),
  };
}

export interface JobFilters { platform: string; source: string; status: string; minScore: number }
export function filterJobs(jobs: JobRow[], f: JobFilters): JobRow[] {
  return jobs
    .filter((j) => (!f.platform || j.platform_tags.includes(f.platform))
      && (!f.source || j.source === f.source)
      && (!f.status ? j.status !== 'skipped' : f.status === 'open' ? !['applied', 'rejected', 'skipped'].includes(j.status) : j.status === f.status)
      && (!f.minScore || (j.fit_score ?? -1) >= f.minScore))
    .sort((a, b) => (b.fit_score ?? -1) - (a.fit_score ?? -1) || b.created_at.localeCompare(a.created_at));
}

export function jobStats(jobs: JobRow[], now = new Date()) {
  const weekAgo = now.getTime() - 7 * 86_400_000;
  return {
    shortlisted: jobs.filter((j) => j.status === 'shortlisted').length,
    drafts: jobs.filter((j) => j.status === 'drafted' || j.status === 'approved').length,
    appliedWeek: jobs.filter((j) => j.applied_at && Date.parse(j.applied_at) >= weekAgo).length,
    followUpsDue: jobs.filter((j) => j.status === 'applied' && j.follow_up_at && Date.parse(j.follow_up_at) <= now.getTime() + 86_400_000).length,
  };
}

/** Relative "3d ago" / "in 2d" without locale surprises (server and client render the same text). */
export function relTime(iso: string | null, now = new Date()): string {
  if (!iso) return '';
  const d = Date.parse(iso);
  if (Number.isNaN(d)) return '';
  const diff = d - now.getTime();
  const abs = Math.abs(diff);
  const unit = abs < 3_600_000 ? [Math.max(1, Math.round(abs / 60_000)), 'm'] : abs < 86_400_000 ? [Math.round(abs / 3_600_000), 'h'] : [Math.round(abs / 86_400_000), 'd'];
  return diff < 0 ? `${unit[0]}${unit[1]} ago` : `in ${unit[0]}${unit[1]}`;
}
