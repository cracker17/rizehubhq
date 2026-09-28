'use client';
import { AlertTriangle, BarChart3 } from 'lucide-react';
import type { ReportRow, WeeklyData } from '@/lib/data/reports';
import { AgentChip, HBars, manilaTime, prettyDate, Stat, usd } from './ui';

function QaTrend({ days }: { days: WeeklyData['qa_trend'] }) {
  return (
    <div className="flex h-40 items-end gap-1.5 sm:gap-2.5" role="img" aria-label={`QA pass rate by day: ${days.map((d) => `${prettyDate(d.date, { weekday: 'short' })} ${d.pass_rate ?? 'no reviews'}`).join(', ')}`}>
      {days.map((d) => (
        <div key={d.date} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5">
          <span className="text-[11px] tabular-nums text-[var(--color-muted)]">{d.pass_rate === null ? '—' : `${d.pass_rate}%`}</span>
          <span className="w-full max-w-10 rounded-t-md" style={{
            height: `${d.pass_rate === null ? 4 : Math.max(6, d.pass_rate)}%`,
            background: d.pass_rate === null ? 'var(--color-line)' : d.pass_rate >= 85 ? 'var(--color-teal)' : d.pass_rate >= 70 ? 'var(--color-warning)' : 'var(--color-danger)',
          }} />
          <span className="text-[11px] text-[var(--color-dim)]">{prettyDate(d.date, { weekday: 'short' })}</span>
        </div>
      ))}
    </div>
  );
}

export function WeeklyPanel({ report }: { report: ReportRow & { data: WeeklyData } }) {
  const w = report.data;
  return (
    <section className="card flex min-w-0 flex-col gap-4 p-4 sm:p-5" aria-labelledby="weekly-title">
      <header className="flex flex-wrap items-center gap-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_oklab,var(--color-teal)_20%,transparent)] text-[var(--color-teal)]"><BarChart3 size={18} /></span>
        <div className="min-w-0 flex-1">
          <h2 id="weekly-title" className="text-lg font-semibold">Weekly summary</h2>
          <p className="text-[13px] text-[var(--color-muted)]" suppressHydrationWarning>
            {prettyDate(w.range.from, { month: 'short', day: 'numeric' })} – {prettyDate(w.range.to, { month: 'short', day: 'numeric' })} · written {prettyDate(report.report_date, { weekday: 'short' })} {manilaTime(report.created_at)} by
          </p>
        </div>
        <AgentChip id={report.agent_id} />
      </header>
      <p className="text-[17px] leading-relaxed sm:text-lg">{w.headline}</p>
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <Stat label="Tasks delivered" value={String(w.done)} tone="var(--color-success)" />
        <Stat label="QA pass rate" value={w.qa.pass_rate === null ? '—' : `${w.qa.pass_rate}%`} tone="var(--color-teal)" hint={`${w.qa.passed} of ${w.qa.reviews} reviews`} />
        <Stat label="Model spend" value={usd(w.spend_usd)} />
        <Stat label="New requests" value={String(w.requests_created)} tone="var(--color-info)" />
      </div>
      <div className="grid min-w-0 gap-3 lg:grid-cols-3">
        <section className="item min-w-0 p-4"><h3 className="mb-3 text-sm font-semibold">Tasks by department</h3>
          <HBars rows={w.by_department.map((d) => ({ label: d.department, value: d.done }))} color="var(--color-primary-hover)" /></section>
        <section className="item min-w-0 p-4"><h3 className="mb-3 text-sm font-semibold">QA pass rate trend</h3><QaTrend days={w.qa_trend} /></section>
        <section className="item min-w-0 p-4"><h3 className="mb-3 text-sm font-semibold">Cost by client</h3>
          <HBars rows={w.cost_by_client.map((c) => ({ label: c.name, value: c.usd }))} color="var(--color-info)" format={usd} /></section>
      </div>
      <section className="item min-w-0 p-4" aria-label="Bottlenecks">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-[var(--color-warning)]"><AlertTriangle size={16} />Bottlenecks</h3>
        {w.bottlenecks.length ? (
          <ul className="flex flex-col gap-2 text-[14px] leading-snug">{w.bottlenecks.map((b) => <li key={b} className="relative pl-3.5 before:absolute before:left-0 before:top-[0.55em] before:h-1.5 before:w-1.5 before:rounded-full before:bg-[var(--color-warning)]">{b}</li>)}</ul>
        ) : <p className="text-sm text-[var(--color-dim)]">No bottlenecks this week.</p>}
      </section>
    </section>
  );
}
