'use client';
import { AlertTriangle, CheckCircle2, Coins, Inbox, Loader, Sun, Users } from 'lucide-react';
import Link from 'next/link';
import type { DigestData, MorningData, ReportRow } from '@/lib/data/reports';
import { AgentChip, LineList, manilaTime, Stat, usd } from './ui';

export function DigestCard({ report }: { report: ReportRow & { data: DigestData } }) {
  const d = report.data;
  const needs = d.counts.blocked + d.counts.approvals_waiting;
  return (
    <section className="card flex min-w-0 flex-col gap-4 p-4 sm:p-5" aria-labelledby="digest-title">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_oklab,var(--color-primary)_22%,transparent)] text-[var(--color-primary-hover)]"><Inbox size={18} /></span>
          <div className="min-w-0">
            <h2 id="digest-title" className="text-lg font-semibold">CEO Digest</h2>
            <p className="text-[13px] text-[var(--color-muted)]" suppressHydrationWarning>Written {manilaTime(report.created_at)} by</p>
          </div>
          <AgentChip id={report.agent_id} />
        </div>
        {needs > 0 && (
          <Link href="/approvals" className="rounded-[10px] bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]">
            {needs} need{needs === 1 ? 's' : ''} you →
          </Link>
        )}
      </header>

      <p className="text-[17px] leading-relaxed sm:text-lg">{d.headline}</p>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-6">
        <Stat label="Done today" value={String(d.counts.done)} tone="var(--color-success)" />
        <Stat label="In progress" value={String(d.counts.in_progress)} tone="var(--color-info)" />
        <Stat label="Blocked" value={String(d.counts.blocked)} tone={d.counts.blocked ? 'var(--color-danger)' : undefined} />
        <Stat label="Approvals waiting" value={String(d.counts.approvals_waiting)} tone={d.counts.approvals_waiting ? 'var(--color-primary-hover)' : undefined} />
        <Stat label="QA pass rate" value={d.qa.pass_rate === null ? '—' : `${d.qa.pass_rate}%`} tone="var(--color-teal)" hint={`${d.qa.passed} of ${d.qa.reviews} reviews passed`} />
        <Stat label="Spend today" value={usd(d.spend_usd)} hint="Sum of model costs in the activity log" />
      </div>

      <div className="grid min-w-0 gap-3 lg:grid-cols-3">
        <LineList title="Done today" icon={<CheckCircle2 size={16} />} lines={d.done} empty="Nothing finished today." tone="var(--color-success)" />
        <LineList title="In progress" icon={<Loader size={16} />} lines={d.in_progress} empty="Nothing in progress." tone="var(--color-info)" />
        <div className="flex min-w-0 flex-col gap-3">
          <LineList title="Blocked / needs you" icon={<AlertTriangle size={16} />} lines={d.blocked} empty="Nothing blocked." tone="var(--color-danger)" max={5} />
          <LineList title="Approvals waiting" icon={<Inbox size={16} />} lines={d.approvals} empty="Inbox zero." tone="var(--color-primary-hover)" max={5} />
        </div>
      </div>

      {d.clients.length > 0 && (
        <section className="item min-w-0 p-4" aria-label="Clients">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-[var(--color-muted)]"><Users size={16} />Clients</h3>
          <ul className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2 xl:grid-cols-3">
            {d.clients.map((c) => (
              <li key={c.name} className="flex min-w-0 items-center justify-between gap-3 text-sm">
                <span className="min-w-0 truncate font-medium">{c.name}</span>
                <span className="flex shrink-0 items-center gap-2.5 text-[13px] tabular-nums text-[var(--color-muted)]">
                  <span title="Done"><span className="text-[var(--color-success)]">●</span> {c.done}</span>
                  <span title="In progress"><span className="text-[var(--color-info)]">●</span> {c.in_progress}</span>
                  {c.blocked > 0 && <span title="Blocked"><span className="text-[var(--color-danger)]">●</span> {c.blocked}</span>}
                  <span className="inline-flex items-center gap-1" title="Spend"><Coins size={13} />{usd(c.spend_usd)}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

export function MorningBriefCard({ report }: { report: ReportRow & { data: MorningData } }) {
  const m = report.data;
  return (
    <details className="card group min-w-0 p-4 sm:p-5">
      <summary className="flex cursor-pointer list-none items-start gap-2.5 [&::-webkit-details-marker]:hidden">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_oklab,var(--color-warning)_20%,transparent)] text-[var(--color-warning)]"><Sun size={18} /></span>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold">Morning brief <span className="font-normal text-[var(--color-muted)]" suppressHydrationWarning>· {manilaTime(report.created_at)}</span></span>
          <span className="block text-[14px] text-[var(--color-muted)]">{m.headline}</span>
        </span>
        <span className="mt-1 shrink-0 text-xs text-[var(--color-dim)] group-open:hidden">Show</span>
        <span className="mt-1 hidden shrink-0 text-xs text-[var(--color-dim)] group-open:inline">Hide</span>
      </summary>
      <div className="mt-4 grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <LineList title="Approvals waiting" icon={<Inbox size={16} />} lines={m.approvals} empty="Inbox zero." max={4} />
        <section className="item min-w-0 p-4">
          <h3 className="mb-3 text-sm font-semibold">Due soon <span className="text-xs font-normal text-[var(--color-muted)]">(next 3 days)</span></h3>
          {m.due_soon.length ? (
            <ul className="flex flex-col gap-2.5 text-sm">
              {m.due_soon.map((r) => (
                <li key={r.title} className="min-w-0"><p className="leading-snug">{r.title}</p>
                  <p className="text-xs text-[var(--color-muted)]">{r.client ? `${r.client} · ` : ''}due {new Date(`${r.due_date}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })}</p></li>
              ))}
            </ul>
          ) : <p className="text-sm text-[var(--color-dim)]">Nothing due.</p>}
        </section>
        <LineList title="In progress" icon={<Loader size={16} />} lines={m.in_progress} empty="Nothing in progress." max={4} />
        <LineList title="Today's queue" icon={<CheckCircle2 size={16} />} lines={m.queue} empty="Queue is empty." max={4} />
      </div>
      <p className="mt-3 text-[13px] text-[var(--color-dim)]">Yesterday: {m.yesterday.done} done, {usd(m.yesterday.spend_usd)} spent.</p>
    </details>
  );
}
