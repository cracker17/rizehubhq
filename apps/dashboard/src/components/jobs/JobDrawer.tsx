'use client';
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CalendarClock, Check, CheckCircle2, Copy, ExternalLink, SkipForward, X } from 'lucide-react';
import { PlatformChip } from '../leads/LeadCard';
import { JOB_STATUS_COLOR, JOB_STATUS_LABEL, fitTone, relTime, safeHref, sourceLabel, type JobRow } from '@/lib/data/rizehubView';

export function StatusPill({ status }: { status: JobRow['status'] }) {
  const c = JOB_STATUS_COLOR[status];
  return (
    <span className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11.5px] font-medium"
      style={{ background: `color-mix(in oklab, ${c} 18%, transparent)`, color: `color-mix(in oklab, ${c} 55%, white)` }}>
      {JOB_STATUS_LABEL[status]}
    </span>
  );
}

export function ScoreBadge({ score }: { score: number | null }) {
  if (score === null) return <span className="text-[13px] text-[var(--color-dim)]">—</span>;
  const c = fitTone(score);
  return (
    <span className="inline-flex h-7 min-w-9 items-center justify-center rounded-lg px-1.5 text-[13px] font-semibold tabular-nums"
      style={{ background: `color-mix(in oklab, ${c} 20%, transparent)`, color: `color-mix(in oklab, ${c} 60%, white)` }} title={`Fit score ${score}/100`}>
      {score}
    </span>
  );
}

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'Asia/Manila' }) : '');
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

export function JobDrawer({ job, now, busy, onClose, onCopy, onApplied, onSkip }: {
  job: JobRow; now: Date; busy: boolean; onClose: () => void; onCopy: (text: string) => void;
  onApplied: (followUpDays: number) => void; onSkip: () => void;
}) {
  const [days, setDays] = useState(5);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const href = safeHref(job.url);
  const applied = ['applied', 'replied', 'interview', 'offer', 'rejected'].includes(job.status);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/55" onClick={onClose}>
      <aside role="dialog" aria-modal aria-labelledby="job-title" onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full flex-col border-l border-[var(--color-line)] bg-[var(--color-panel)] shadow-[0_10px_40px_rgba(0,0,0,.5)] sm:max-w-[520px]">
        <header className="flex items-start gap-3 border-b border-[var(--color-line)] p-4 sm:p-5">
          <div className="min-w-0 flex-1">
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
              <StatusPill status={job.status} />
              {job.platform_tags.map((t) => <PlatformChip key={t} platform={t} />)}
            </div>
            <h2 id="job-title" className="text-lg font-semibold leading-snug">{job.title}</h2>
            <p className="mt-0.5 text-[13px] text-[var(--color-muted)]" suppressHydrationWarning>
              {[job.company ?? 'Company not named', sourceLabel(job.source), job.rate, job.posted_at ? `posted ${relTime(job.posted_at, now)}` : null].filter(Boolean).join(' · ')}
            </p>
          </div>
          <ScoreBadge score={job.fit_score} />
          <button ref={closeRef} onClick={onClose} aria-label="Close" className="-mr-1 rounded-lg p-1 text-[var(--color-muted)] hover:text-white"><X size={20} /></button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto p-4 scroll-thin sm:p-5">
          <div className="grid grid-cols-2 gap-2">
            {href ? (
              <a href={href} target="_blank" rel="noopener noreferrer nofollow"
                className="flex h-10 items-center justify-center gap-2 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-2)] text-sm font-medium hover:border-[var(--color-line-active)]">
                <ExternalLink size={16} aria-hidden /> Open job
              </a>
            ) : <span className="flex h-10 items-center justify-center rounded-xl border border-dashed border-[var(--color-line)] text-sm text-[var(--color-dim)]">No link</span>}
            <button onClick={() => job.draft && onCopy(job.draft)} disabled={!job.draft}
              className="flex h-10 items-center justify-center gap-2 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-2)] text-sm font-medium hover:border-[var(--color-line-active)] disabled:opacity-40">
              <Copy size={16} aria-hidden /> Copy draft
            </button>
          </div>

          {href && <p className="break-all text-[12px] text-[var(--color-dim)]">{href}</p>}

          <section aria-labelledby="fit-h">
            <h3 id="fit-h" className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">Why it fits</h3>
            {job.fit_reasons.length ? (
              <ul className="space-y-1.5">
                {job.fit_reasons.map((r, i) => (
                  <li key={i} className="flex gap-2 text-[14px] leading-snug"><CheckCircle2 size={16} className="mt-0.5 shrink-0 text-[var(--color-success)]" aria-hidden />{r}</li>
                ))}
              </ul>
            ) : <p className="text-[13px] text-[var(--color-dim)]">Not screened yet. Job Scout scores it in the next job search.</p>}
          </section>

          <section aria-labelledby="flags-h">
            <h3 id="flags-h" className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">Red flags</h3>
            {job.red_flags.length ? (
              <ul className="space-y-1.5">
                {job.red_flags.map((r, i) => (
                  <li key={i} className="flex gap-2 text-[14px] leading-snug text-[#ffb0b2]"><AlertTriangle size={16} className="mt-0.5 shrink-0 text-[var(--color-danger)]" aria-hidden />{r}</li>
                ))}
              </ul>
            ) : <p className="text-[13px] text-[var(--color-dim)]">None found.</p>}
          </section>

          {job.notes && (
            <section aria-labelledby="notes-h">
              <h3 id="notes-h" className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">Notes</h3>
              <p className="text-[14px] leading-snug">{job.notes}</p>
            </section>
          )}

          <section aria-labelledby="draft-h">
            <div className="mb-2 flex items-center justify-between">
              <h3 id="draft-h" className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">Tailored draft</h3>
              {job.draft && <span className="text-xs tabular-nums text-[var(--color-dim)]">{words(job.draft)} words</span>}
            </div>
            {job.draft ? (
              <div className="item whitespace-pre-wrap break-words p-3.5 text-[14px] leading-relaxed">{job.draft}</div>
            ) : <p className="text-[13px] text-[var(--color-dim)]">No draft yet. Shortlisted jobs get a draft in the job-application step.</p>}
          </section>

          {(job.applied_at || job.follow_up_at) && (
            <section className="item flex flex-col gap-1.5 p-3.5 text-[13.5px]" aria-label="Tracking">
              {job.applied_at && <p className="flex items-center gap-2"><Check size={15} className="text-[var(--color-success)]" aria-hidden /> Applied {fmtDate(job.applied_at)}</p>}
              {job.follow_up_at && (
                <p className="flex items-center gap-2" suppressHydrationWarning><CalendarClock size={15} className="text-[var(--color-warning)]" aria-hidden />
                  Follow-up draft {Date.parse(job.follow_up_at) <= now.getTime() ? 'due now' : `on ${fmtDate(job.follow_up_at)}`} (needs your approval before sending)
                </p>
              )}
            </section>
          )}
        </div>

        <footer className="border-t border-[var(--color-line)] p-4 sm:p-5">
          {applied ? (
            <p className="text-center text-[13px] text-[var(--color-muted)]">Tracked as {JOB_STATUS_LABEL[job.status].toLowerCase()}. Job Scout drafts the follow-up when it is due.</p>
          ) : (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <label className="flex items-center gap-2 text-[13px] text-[var(--color-muted)]">
                Follow up in
                <select value={days} onChange={(e) => setDays(Number(e.target.value))}
                  className="h-9 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-2)] px-2 text-sm text-white outline-none focus:border-[var(--color-line-active)]">
                  {[3, 5, 7, 10, 14].map((d) => <option key={d} value={d}>{d} days</option>)}
                </select>
              </label>
              <div className="flex gap-2 sm:ml-auto">
                {job.status !== 'skipped' && (
                  <button onClick={onSkip} disabled={busy} className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl border border-[var(--color-line)] px-3 text-sm text-[var(--color-muted)] hover:text-white disabled:opacity-40 sm:flex-none">
                    <SkipForward size={15} aria-hidden /> Skip
                  </button>
                )}
                <button onClick={() => onApplied(days)} disabled={busy}
                  className="flex h-10 flex-[2] items-center justify-center gap-1.5 rounded-xl bg-[var(--color-success)] px-4 text-sm font-medium text-white hover:brightness-110 disabled:opacity-40 sm:flex-none">
                  <Check size={16} aria-hidden /> {busy ? 'Saving…' : 'Mark applied'}
                </button>
              </div>
            </div>
          )}
        </footer>
      </aside>
    </div>
  );
}
