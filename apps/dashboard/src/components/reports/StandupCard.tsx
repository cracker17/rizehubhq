'use client';
import { AlertTriangle, ArrowRight, Check } from 'lucide-react';
import type { ReportRow } from '@/lib/data/reports';
import { Avatar } from '../Avatar';
import { deptLabel, useAgent, usd } from './ui';

function Part({ title, icon, items, empty, tone }: { title: string; icon: React.ReactNode; items: string[]; empty: string; tone: string }) {
  return (
    <div className="min-w-0">
      <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide" style={{ color: tone }}>{icon}{title}</h4>
      {items.length ? (
        <ul className="flex flex-col gap-1.5 text-[14px] leading-snug">
          {items.map((x, i) => <li key={i} className="relative pl-3.5 before:absolute before:left-0 before:top-[0.55em] before:h-1.5 before:w-1.5 before:rounded-full before:bg-[var(--color-line-active)]">{x}</li>)}
        </ul>
      ) : <p className="text-[13px] text-[var(--color-dim)]">{empty}</p>}
    </div>
  );
}

export function StandupCard({ report }: { report: ReportRow }) {
  const a = useAgent(report.agent_id);
  const blocked = report.blockers.length > 0;
  const spend = Number((report.data as { spend_usd?: number } | null)?.spend_usd ?? 0);
  return (
    <article className="item flex min-w-0 flex-col gap-3.5 p-4" style={blocked ? { borderColor: 'color-mix(in oklab, var(--color-danger) 45%, var(--color-line))' } : undefined}>
      <header className="flex items-center gap-3">
        <Avatar id={a.id} name={a.name} color={a.color} size={40} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-medium">{a.name}</h3>
          <p className="truncate text-[13px] text-[var(--color-muted)]">{deptLabel(a.department || 'team')}{spend > 0 ? ` · ${usd(spend)}` : ''}</p>
        </div>
        {blocked && <span className="shrink-0 rounded-md bg-[color-mix(in_oklab,var(--color-danger)_18%,transparent)] px-2 py-0.5 text-xs text-[#ff8a8d]">Blocked</span>}
      </header>
      <Part title="Done" icon={<Check size={13} />} items={report.done} empty="Nothing finished." tone="var(--color-success)" />
      <Part title="Next" icon={<ArrowRight size={13} />} items={report.next} empty="Nothing queued." tone="var(--color-info)" />
      <Part title="Blockers" icon={<AlertTriangle size={13} />} items={report.blockers} empty="None." tone={blocked ? 'var(--color-danger)' : 'var(--color-dim)'} />
    </article>
  );
}
