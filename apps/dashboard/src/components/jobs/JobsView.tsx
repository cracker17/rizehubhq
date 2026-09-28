'use client';
import { useCallback, useMemo, useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, Briefcase, ChevronRight } from 'lucide-react';
import { useHq } from '@/lib/data/store';
import { markJobAppliedAction, setJobStatusAction } from '@/app/rizehub-actions';
import { JOB_STATUSES, JOB_STATUS_LABEL, filterJobs, jobStats, relTime, sourceLabel, type JobFilters, type JobRow, type JobsData } from '@/lib/data/rizehubView';
import { PrefillRequestDialog, type PrefillField } from '../leads/PrefillRequestDialog';
import { PlatformChip } from '../leads/LeadCard';
import { JobDrawer, ScoreBadge, StatusPill } from './JobDrawer';

const select = 'h-9 min-w-0 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-2)] px-3 text-sm outline-none focus:border-[var(--color-line-active)]';

const FIND_FIELDS: PrefillField[] = [
  { id: 'role', label: 'Role', kind: 'select', initial: 'Shopify developer', options: ['Shopify developer', 'Webflow developer', 'WordPress developer', 'front-end developer'].map((v) => ({ value: v, label: v[0]!.toUpperCase() + v.slice(1) })) },
  { id: 'window', label: 'Posted', kind: 'select', initial: 'this week', options: [{ value: 'in the last 3 days', label: 'Last 3 days' }, { value: 'this week', label: 'This week' }, { value: 'in the last 14 days', label: 'Last 14 days' }] },
  { id: 'drafts', label: 'Drafts for the top', kind: 'number', min: 1, max: 15, initial: '5' },
  { id: 'extra', label: 'Anything else (optional)', kind: 'text', placeholder: 'e.g. OnlineJobs.ph only, part-time, US hours', initial: '' },
];
const buildFind = (v: Record<string, string>) =>
  `Find remote ${v.role} jobs posted ${v.window} and draft applications for the top ${Number(v.drafts) || 5}${v.extra?.trim() ? ` (${v.extra.trim()})` : ''}`;

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="card p-4">
      <p className="text-[13px] text-[var(--color-muted)]">{label}</p>
      <p className="mt-0.5 text-2xl font-semibold tabular-nums sm:text-3xl" style={tone && value ? { color: tone } : undefined}>{value}</p>
    </div>
  );
}

export function JobsView({ data, initialJobId }: { data: JobsData; initialJobId?: string | null }) {
  const { toast } = useHq();
  const [now] = useState(() => new Date());
  const [jobs, setJobs] = useState<JobRow[]>(data.jobs);
  const [f, setF] = useState<JobFilters>({ platform: '', source: '', status: '', minScore: 0 });
  const [openId, setOpenId] = useState<string | null>(initialJobId && data.jobs.some((j) => j.id === initialJobId) ? initialJobId : null);
  const [busy, setBusy] = useState(false);
  const [finding, setFinding] = useState(false);

  const shown = useMemo(() => filterJobs(jobs, f), [jobs, f]);
  const stats = useMemo(() => jobStats(jobs, now), [jobs, now]);
  const sources = useMemo(() => [...new Set(jobs.map((j) => j.source))].sort(), [jobs]);
  const platforms = useMemo(() => [...new Set(jobs.flatMap((j) => j.platform_tags))].sort(), [jobs]);
  const open = openId ? jobs.find((j) => j.id === openId) ?? null : null;

  const select_ = useCallback((id: string | null) => {
    setOpenId(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('job', id); else url.searchParams.delete('job');
    window.history.replaceState(null, '', url.toString());
  }, []);
  const close = useCallback(() => select_(null), [select_]);
  const replace = (j: JobRow) => setJobs((list) => list.map((x) => (x.id === j.id ? j : x)));

  const copy = useCallback(async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast('Draft copied. Paste it into the application.', 'success'); }
    catch { toast('Could not copy: select the draft text and copy it manually.', 'error'); }
  }, [toast]);

  const markApplied = async (job: JobRow, days: number) => {
    if (data.mode === 'demo') {
      const t = Date.now();
      replace({ ...job, status: 'applied', applied_at: new Date(t).toISOString(), follow_up_at: new Date(t + days * 86_400_000).toISOString() });
      toast(`Marked applied. Follow-up draft in ${days} days.`, 'success');
      return;
    }
    setBusy(true);
    const res = await markJobAppliedAction({ id: job.id, followUpDays: days });
    setBusy(false);
    if (!res.ok) { toast(res.error, 'error'); return; }
    replace(res.job);
    toast(`Marked applied. Follow-up draft in ${days} days.`, 'success');
  };
  const skip = async (job: JobRow) => {
    if (data.mode === 'demo') { replace({ ...job, status: 'skipped' }); toast('Skipped.', 'info'); close(); return; }
    setBusy(true);
    const res = await setJobStatusAction({ id: job.id, status: 'skipped' });
    setBusy(false);
    if (!res.ok) { toast(res.error, 'error'); return; }
    replace(res.job);
    toast('Skipped.', 'info');
    close();
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">Jobs</h1>
          <p className="text-[13px] text-[var(--color-muted)]">The Sales Agent&apos;s shortlist · you click apply{data.mode === 'demo' ? ' · demo data' : ''}</p>
        </div>
        <button onClick={() => setFinding(true)} className="ml-auto flex h-10 items-center gap-2 rounded-xl bg-[var(--color-primary)] px-4 text-sm font-medium hover:bg-[var(--color-primary-hover)]">
          <Briefcase size={16} aria-hidden /> Find jobs
        </button>
      </div>
      {data.error && <p role="alert" className="item px-4 py-3 text-sm text-[#ff8a8d]">Couldn&apos;t load jobs: {data.error}</p>}

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Job numbers">
        <Stat label="Shortlisted" value={stats.shortlisted} />
        <Stat label="Drafts ready" value={stats.drafts} tone="#b9a5ff" />
        <Stat label="Applied this week" value={stats.appliedWeek} />
        <Stat label="Follow-ups due" value={stats.followUpsDue} tone="#ffc861" />
      </section>

      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center" role="group" aria-label="Filters">
        <select value={f.platform} onChange={(e) => setF({ ...f, platform: e.target.value })} className={select} aria-label="Platform">
          <option value="">All platforms</option>
          {platforms.map((p) => <option key={p} value={p}>{p[0]!.toUpperCase() + p.slice(1)}</option>)}
        </select>
        <select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} className={select} aria-label="Source">
          <option value="">All sources</option>
          {sources.map((s) => <option key={s} value={s}>{sourceLabel(s)}</option>)}
        </select>
        <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} className={select} aria-label="Status">
          <option value="">All but skipped</option>
          <option value="open">Not applied yet</option>
          {JOB_STATUSES.map((s) => <option key={s} value={s}>{JOB_STATUS_LABEL[s]}</option>)}
        </select>
        <select value={f.minScore} onChange={(e) => setF({ ...f, minScore: Number(e.target.value) })} className={select} aria-label="Minimum fit score">
          <option value={0}>Any score</option>
          {[50, 70, 85].map((n) => <option key={n} value={n}>Score ≥ {n}</option>)}
        </select>
        <span className="col-span-2 text-right text-xs text-[var(--color-dim)] sm:ml-auto">{shown.length} of {jobs.length}</span>
      </div>

      {shown.length === 0 ? (
        <div className="card flex flex-col items-center gap-2 p-10 text-center">
          <Briefcase size={26} className="text-[var(--color-primary-hover)]" aria-hidden />
          <p className="text-[15px] font-medium">{jobs.length ? 'No jobs match these filters' : 'No jobs tracked yet'}</p>
          <p className="max-w-md text-[13px] text-[var(--color-muted)]">{jobs.length ? 'Loosen a filter to see more.' : 'Ask the Sales Agent to search. Public remote-board feeds are also checked every few hours.'}</p>
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="card hidden overflow-hidden md:block">
            <table className="w-full table-fixed text-left text-[14px]">
              <thead className="border-b border-[var(--color-line)] text-xs uppercase tracking-wide text-[var(--color-muted)]">
                <tr>
                  <th className="w-[36%] px-5 py-3 font-medium">Job</th>
                  <th className="w-[13%] px-3 py-3 font-medium">Source</th>
                  <th className="w-[12%] px-3 py-3 font-medium">Rate</th>
                  <th className="w-[7%] px-3 py-3 font-medium">Fit</th>
                  <th className="px-3 py-3 font-medium">Red flags</th>
                  <th className="w-[12%] px-3 py-3 font-medium">Status</th>
                  <th className="w-10 px-3 py-3"><span className="sr-only">Open</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((j) => (
                  <tr key={j.id} onClick={() => select_(j.id)} className={clsx('cursor-pointer border-b border-[var(--color-line)] last:border-0 hover:bg-[var(--color-panel-2)]', openId === j.id && 'bg-[var(--color-panel-2)]')}>
                    <td className="px-5 py-3">
                      <button onClick={(e) => { e.stopPropagation(); select_(j.id); }} className="block w-full min-w-0 text-left" aria-label={`Open ${j.title}`}>
                        <span className="block truncate font-medium">{j.title}</span>
                        <span className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-[var(--color-muted)]" suppressHydrationWarning>
                          <span className="truncate">{j.company ?? 'Company not named'}</span>
                          {j.posted_at && <span className="shrink-0 text-[var(--color-dim)]">· {relTime(j.posted_at, now)}</span>}
                        </span>
                      </button>
                    </td>
                    <td className="truncate px-3 py-3 text-[13px] text-[var(--color-muted)]">{sourceLabel(j.source)}</td>
                    <td className="truncate px-3 py-3 text-[13px]">{j.rate ?? <span className="text-[var(--color-dim)]">—</span>}</td>
                    <td className="px-3 py-3"><ScoreBadge score={j.fit_score} /></td>
                    <td className="px-3 py-3 text-[13px]">
                      {j.red_flags.length
                        ? <span className="flex min-w-0 items-center gap-1.5 text-[#ffb0b2]" title={j.red_flags.join('\n')}><AlertTriangle size={14} className="shrink-0 text-[var(--color-danger)]" aria-hidden /><span className="truncate">{j.red_flags[0]}</span>{j.red_flags.length > 1 && <span className="shrink-0 text-[var(--color-dim)]">+{j.red_flags.length - 1}</span>}</span>
                        : <span className="text-[var(--color-dim)]">None</span>}
                    </td>
                    <td className="px-3 py-3"><StatusPill status={j.status} /></td>
                    <td className="px-3 py-3 text-[var(--color-dim)]"><ChevronRight size={16} aria-hidden /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Phones: cards */}
          <ul className="flex flex-col gap-2.5 md:hidden">
            {shown.map((j) => (
              <li key={j.id}>
                <button onClick={() => select_(j.id)} className="item flex w-full items-start gap-3 p-3.5 text-left hover:border-[var(--color-line-active)]">
                  <ScoreBadge score={j.fit_score} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14.5px] font-medium leading-snug">{j.title}</span>
                    <span className="mt-0.5 block truncate text-[12.5px] text-[var(--color-muted)]">{[j.company, sourceLabel(j.source), j.rate].filter(Boolean).join(' · ')}</span>
                    <span className="mt-2 flex flex-wrap items-center gap-1.5">
                      <StatusPill status={j.status} />
                      {j.platform_tags.slice(0, 2).map((t) => <PlatformChip key={t} platform={t} />)}
                      {j.red_flags.length > 0 && <span className="inline-flex items-center gap-1 text-[11.5px] text-[#ffb0b2]"><AlertTriangle size={12} aria-hidden />{j.red_flags.length} flag{j.red_flags.length > 1 ? 's' : ''}</span>}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {open && <JobDrawer key={open.id} job={open} now={now} busy={busy} onClose={close} onCopy={copy} onApplied={(d) => markApplied(open, d)} onSkip={() => skip(open)} />}
      <PrefillRequestDialog open={finding} onClose={() => setFinding(false)} title="Find jobs"
        intro="The Sales Agent checks your job-alert emails, public remote boards and links you paste, screens them against brain/career/job-filters.md and drafts applications. You apply yourself."
        fields={FIND_FIELDS} build={buildFind} />
    </>
  );
}
