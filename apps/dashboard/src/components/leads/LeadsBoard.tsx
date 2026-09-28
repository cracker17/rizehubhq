'use client';
import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { Search, Target } from 'lucide-react';
import { BOARD_COLUMNS, leadStats, type LeadCard, type LeadsData } from '@/lib/data/rizehubView';
import { LeadCardView } from './LeadCard';
import { PrefillRequestDialog, type PrefillField } from './PrefillRequestDialog';

const PLATFORMS = [{ value: '', label: 'All platforms' }, { value: 'shopify', label: 'Shopify' }, { value: 'webflow', label: 'Webflow' }, { value: 'wordpress', label: 'WordPress' }];

const FIND_FIELDS: PrefillField[] = [
  { id: 'count', label: 'How many leads', kind: 'number', min: 5, max: 100, initial: '30' },
  { id: 'platform', label: 'Platform', kind: 'select', initial: 'Shopify', options: ['Shopify', 'Webflow', 'WordPress'].map((v) => ({ value: v, label: v })) },
  { id: 'country', label: 'Country', kind: 'select', initial: 'Australia', options: ['Australia', 'United States', 'United Kingdom', 'Canada', 'New Zealand'].map((v) => ({ value: v, label: v })) },
  {
    id: 'signal', label: 'Signal', kind: 'select', initial: 'slow sites', options: [
      { value: 'slow sites', label: 'Slow site (LCP)' }, { value: 'a developer job posted', label: 'Hiring a developer' },
      { value: 'no SSL on key pages', label: 'No SSL' }, { value: 'an outdated theme', label: 'Outdated theme' },
      { value: 'a low mobile PageSpeed score', label: 'Low mobile score' }, { value: 'broken links', label: 'Broken links' },
    ],
  },
  { id: 'industry', label: 'Niche (optional)', kind: 'text', placeholder: 'e.g. skincare DTC, coffee, law firms', initial: '' },
];
const noun = (p: string) => (p === 'Shopify' ? 'Shopify stores' : `${p} sites`);
const buildFind = (v: Record<string, string>) =>
  `Find ${Number(v.count) || 30} ${v.industry?.trim() ? `${v.industry.trim()} ` : ''}${noun(v.platform ?? 'Shopify')} in ${v.country} with ${v.signal} and draft outreach`;

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="card p-4 sm:p-5" title={hint}>
      <p className="text-sm text-[var(--color-muted)]">{label}</p>
      <p className="mt-1 text-3xl font-semibold tabular-nums sm:text-[34px] sm:leading-tight">{value}</p>
      <p className="mt-1 truncate text-xs text-[var(--color-dim)]">{hint}</p>
    </div>
  );
}

export function LeadsBoard({ data }: { data: LeadsData }) {
  const [now] = useState(() => new Date());
  const [platform, setPlatform] = useState('');
  const [q, setQ] = useState('');
  const [mobileCol, setMobileCol] = useState('researched');
  const [finding, setFinding] = useState(false);

  const leads = useMemo(() => {
    const s = q.trim().toLowerCase();
    return data.leads.filter((l) => (!platform || l.platform === platform)
      && (!s || `${l.company} ${l.website ?? ''} ${l.industry ?? ''} ${l.country ?? ''}`.toLowerCase().includes(s)));
  }, [data.leads, platform, q]);
  const stats = useMemo(() => leadStats(data.leads, now), [data.leads, now]);
  const byCol = useMemo(() => {
    const out: Record<string, LeadCard[]> = {};
    for (const c of BOARD_COLUMNS) {
      out[c.id] = leads.filter((l) => c.stages.includes(l.stage))
        .sort((a, b) => (c.id === 'closed' ? b.updatedAt.localeCompare(a.updatedAt) : (b.fitScore ?? b.score ?? 0) - (a.fitScore ?? a.score ?? 0)));
    }
    return out;
  }, [leads]);

  const column = (c: (typeof BOARD_COLUMNS)[number], header = true) => (
    <section key={c.id} className={clsx('flex min-w-0 flex-col', header && 'min-h-0')} aria-labelledby={header ? `lc-${c.id}` : undefined} aria-label={header ? undefined : c.label}>
      {header && (
        <h2 id={`lc-${c.id}`} className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <span className="h-2 w-2 rounded-full" style={{ background: c.color }} aria-hidden />
          {c.label}
          <span className="rounded bg-[var(--color-panel-2)] px-1.5 text-xs text-[var(--color-muted)]">{byCol[c.id]!.length}</span>
        </h2>
      )}
      {byCol[c.id]!.length === 0
        ? <p className="rounded-[14px] border border-dashed border-[var(--color-line)] p-4 text-center text-[13px] text-[var(--color-dim)]">No leads</p>
        : <ul className={clsx('flex flex-col gap-2.5 sm:grid sm:grid-cols-2 sm:gap-3 xl:flex xl:flex-col xl:gap-2.5', header && 'min-h-0 flex-1 overflow-y-auto pr-1 scroll-thin')}>
            {byCol[c.id]!.map((l) => <li key={l.id}><LeadCardView lead={l} now={now} /></li>)}
          </ul>}
    </section>
  );

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">Leads</h1>
          <p className="text-[13px] text-[var(--color-muted)]">From RizeHub Lead Finder{data.mode === 'demo' ? ' · demo data' : ''}</p>
        </div>
        <button onClick={() => setFinding(true)}
          className="ml-auto flex h-10 items-center gap-2 rounded-xl bg-[var(--color-primary)] px-4 text-sm font-medium hover:bg-[var(--color-primary-hover)]">
          <Target size={16} aria-hidden /> Find leads
        </button>
      </div>
      {data.error && <p role="alert" className="item px-4 py-3 text-sm text-[#ff8a8d]">Couldn&apos;t load leads: {data.error}</p>}

      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4 xl:gap-4" aria-label="Pipeline numbers">
        <Stat label="Found this week" value={String(stats.foundThisWeek)} hint="Last 7 days, from Lead Finder" />
        <Stat label="Reply rate" value={stats.replyRate === null ? '—' : `${stats.replyRate}%`} hint={`${stats.replied} replied of ${stats.reached} contacted`} />
        <Stat label="Proposals sent" value={String(stats.proposals)} hint="Reached the proposal stage" />
        <Stat label="Won" value={String(stats.won)} hint="Became clients" />
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 overflow-x-auto rounded-xl bg-[var(--color-panel-2)] p-1 scroll-thin" role="group" aria-label="Filter by platform">
          {PLATFORMS.map((p) => (
            <button key={p.value} onClick={() => setPlatform(p.value)} aria-pressed={platform === p.value}
              className={clsx('shrink-0 rounded-lg px-3 py-1.5 text-[13px]', platform === p.value ? 'bg-[var(--color-primary)] text-white' : 'text-[var(--color-muted)] hover:text-white')}>
              {p.label}
            </button>
          ))}
        </div>
        <label className="relative w-full sm:ml-auto sm:w-64">
          <span className="sr-only">Search leads</span>
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-dim)]" aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search company, niche, country"
            className="h-9 w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-2)] pl-9 pr-3 text-sm outline-none placeholder:text-[var(--color-dim)] focus:border-[var(--color-line-active)]" />
        </label>
      </div>

      {data.leads.length === 0 ? (
        <div className="card flex flex-col items-center gap-3 p-10 text-center">
          <Target size={28} className="text-[var(--color-primary-hover)]" aria-hidden />
          <p className="text-[15px] font-medium">No leads yet</p>
          <p className="max-w-md text-[13px] text-[var(--color-muted)]">Ask the team to run a Lead Finder search. Leads appear here as the Sales Agent researches them.</p>
          <button onClick={() => setFinding(true)} className="h-10 rounded-xl bg-[var(--color-primary)] px-4 text-sm font-medium hover:bg-[var(--color-primary-hover)]">Find leads</button>
        </div>
      ) : (
        <>
          {/* Phones/tablets: one stage at a time */}
          <div className="card p-4 xl:hidden">
            <div className="-mx-1 mb-4 flex gap-1 overflow-x-auto px-1 pb-1 scroll-thin" role="tablist" aria-label="Pipeline stages">
              {BOARD_COLUMNS.map((c) => (
                <button key={c.id} role="tab" aria-selected={mobileCol === c.id} onClick={() => setMobileCol(c.id)}
                  className={clsx('flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-[13px]', mobileCol === c.id ? 'bg-[var(--color-primary)] text-white' : 'bg-[var(--color-panel-2)] text-[var(--color-muted)]')}>
                  {c.label}<span className="tabular-nums opacity-80">{byCol[c.id]!.length}</span>
                </button>
              ))}
            </div>
            {column(BOARD_COLUMNS.find((c) => c.id === mobileCol)!, false)}
          </div>
          {/* Desktop: the full board, scrolls sideways inside the card */}
          <div className="card relative hidden overflow-hidden xl:block">
            <div className="h-[calc(100dvh-330px)] min-h-[520px] overflow-x-auto p-5 pb-3 scroll-thin">
              <div className="grid h-full auto-cols-[minmax(232px,1fr)] grid-flow-col gap-4">
                {BOARD_COLUMNS.map((c) => column(c))}
              </div>
            </div>
            <div className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-[var(--color-panel)] to-transparent" aria-hidden />
          </div>
        </>
      )}

      <PrefillRequestDialog open={finding} onClose={() => setFinding(false)} title="Find leads"
        intro="The Sales Agent runs RizeHub Lead Finder, verifies each signal on the real site, scores fit and drafts outreach. You approve every message."
        fields={FIND_FIELDS} build={buildFind} />
    </>
  );
}
