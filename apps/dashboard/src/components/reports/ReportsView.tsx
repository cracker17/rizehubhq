'use client';
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { CalendarDays, ChevronLeft, ChevronRight, FileClock } from 'lucide-react';
import type { ReportsForDate } from '@/lib/data/reports';
import { DigestCard, MorningBriefCard } from './DigestCard';
import { StandupCard } from './StandupCard';
import { WeeklyPanel } from './WeeklyPanel';
import { prettyDate } from './ui';

export type ReportsTab = 'daily' | 'weekly';

function shift(date: string, n: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function Empty({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card flex min-h-[220px] flex-col items-center justify-center gap-2 p-8 text-center">
      <FileClock size={28} className="text-[var(--color-primary-hover)]" aria-hidden />
      <p className="text-[15px] font-medium">{title}</p>
      <p className="max-w-md text-sm text-[var(--color-muted)]">{children}</p>
    </div>
  );
}

export function ReportsView({ reports, tab }: { reports: ReportsForDate; tab: ReportsTab }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const { date, today } = reports;
  const go = (next: { date?: string; tab?: ReportsTab }) => {
    const d = next.date ?? date;
    const t = next.tab ?? tab;
    const qs = new URLSearchParams();
    if (d !== today) qs.set('date', d);
    if (t !== 'daily') qs.set('tab', t);
    start(() => router.push(`/reports${qs.toString() ? `?${qs.toString()}` : ''}`, { scroll: false }));
  };
  const isToday = date === today;

  return (
    <div className={clsx('flex min-w-0 flex-col gap-4 lg:gap-5', pending && 'opacity-70 transition-opacity')} aria-busy={pending}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">Daily Reports</h1>
          <p className="text-sm text-[var(--color-muted)]">
            {prettyDate(date)}{isToday ? ' · today' : ''} · Asia/Manila
          </p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <div className="flex gap-1 rounded-xl bg-[var(--color-panel)] p-1" role="tablist" aria-label="Report type">
            {(['daily', 'weekly'] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} onClick={() => go({ tab: t })}
                className={clsx('rounded-lg px-3 py-1.5 text-sm capitalize', tab === t ? 'bg-[var(--color-primary)] text-white' : 'text-[var(--color-muted)] hover:text-white')}>
                {t}
              </button>
            ))}
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-1 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-1 sm:ml-0">
            <button onClick={() => go({ date: shift(date, -1) })} aria-label="Previous day" className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-white"><ChevronLeft size={18} /></button>
            <label className="relative flex min-w-0 items-center gap-1.5 px-1 text-sm">
              <CalendarDays size={16} className="shrink-0 text-[var(--color-muted)]" aria-hidden />
              <span className="sr-only">Report date</span>
              <input type="date" value={date} max={today} onChange={(e) => e.target.value && go({ date: e.target.value })}
                className="w-[8.75rem] min-w-0 bg-transparent text-sm tabular-nums text-[var(--color-ink)] outline-none [color-scheme:dark]" />
            </label>
            <button onClick={() => go({ date: shift(date, 1) })} disabled={date >= today} aria-label="Next day" className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-white disabled:opacity-30 disabled:hover:bg-transparent"><ChevronRight size={18} /></button>
            {!isToday && <button onClick={() => go({ date: today })} className="rounded-lg px-2.5 py-1 text-sm text-[var(--color-primary-hover)] hover:bg-[var(--color-panel-2)]">Today</button>}
          </div>
        </div>
      </div>

      {reports.error && <p role="alert" className="item px-4 py-3 text-sm text-[#ff8a8d]">Couldn&apos;t load reports: {reports.error}</p>}

      {tab === 'daily' ? (
        <>
          {reports.digest ? <DigestCard report={reports.digest} /> : (
            <Empty title={isToday ? 'Today’s digest isn’t written yet' : 'No digest for this day'}>
              {isToday ? 'The COO writes the CEO digest at the digest time (18:00 by default) from every agent’s standup. It also lands in Telegram.' : 'The worker was not running that day, or nothing happened.'}
            </Empty>
          )}
          {reports.morning && <MorningBriefCard report={reports.morning} />}
          <section aria-labelledby="standups-title" className="flex min-w-0 flex-col gap-3">
            <h2 id="standups-title" className="flex items-center gap-2 text-lg font-semibold">
              Standups <span className="rounded-md bg-[var(--color-panel)] px-1.5 text-sm font-medium text-[var(--color-muted)]">{reports.standups.length}</span>
            </h2>
            {reports.standups.length ? (
              <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {reports.standups.map((r) => <StandupCard key={r.id} report={r} />)}
              </div>
            ) : <p className="text-sm text-[var(--color-dim)]">Standups appear here for every agent that worked this day.</p>}
          </section>
        </>
      ) : reports.weekly ? <WeeklyPanel report={reports.weekly} /> : (
        <Empty title="No weekly summary yet">The COO writes it every Monday at 08:00, covering the previous Monday to Sunday.</Empty>
      )}
    </div>
  );
}
