'use client';
import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { Send, MessageCircle, CalendarClock, Webhook } from 'lucide-react';
import { useHq } from '@/lib/data/store';
import { PIPELINE, clip, money, pipelineStep, relDay, requestProgress } from '@/lib/data/derive';
import type { RequestRow } from '@/lib/data/types';
import { NewRequestForm } from './NewRequestForm';

const FILTERS = [
  { id: 'active', label: 'Active' }, { id: 'review', label: 'Needs review' }, { id: 'done', label: 'Done' }, { id: 'all', label: 'All' },
] as const;
type FilterId = (typeof FILTERS)[number]['id'];

const SOURCE = { dashboard: Send, telegram: MessageCircle, schedule: CalendarClock, rizehub: Webhook } as const;
const PRIORITY_COLOR = { urgent: 'var(--color-danger)', high: 'var(--color-warning)', low: 'var(--color-dim)', normal: 'var(--color-muted)' } as const;
const TERMINAL: Record<string, string> = { rejected: 'Rejected', cancelled: 'Cancelled', failed: 'Failed' };

function Pipeline({ r }: { r: RequestRow }) {
  const step = pipelineStep(r.status);
  if (step < 0) {
    return <span className="rounded-full border border-[color-mix(in_oklab,var(--color-danger)_50%,transparent)] px-2.5 py-0.5 text-xs text-[#ff8a8d]">{TERMINAL[r.status] ?? r.status}</span>;
  }
  return (
    <div className="min-w-0" aria-label={`Status: ${PIPELINE[step]} (step ${step + 1} of ${PIPELINE.length})`} role="img">
      <div className="flex items-center gap-1">
        {PIPELINE.map((p, i) => (
          <span key={p} className="h-1.5 flex-1 rounded-full" style={{
            background: i < step || step === 4 ? 'var(--color-success)' : i === step ? 'var(--color-primary-hover)' : 'var(--color-line)',
          }} />
        ))}
      </div>
      <div className="mt-1.5 hidden grid-cols-5 gap-1 text-[11px] sm:grid">
        {PIPELINE.map((p, i) => (
          <span key={p} className={clsx('truncate capitalize', i === step ? 'font-medium text-white' : 'text-[var(--color-dim)]')}>{p}</span>
        ))}
      </div>
      <p className="mt-1.5 text-xs capitalize text-white sm:hidden">{PIPELINE[step]}{r.status === 'awaiting_ceo' ? ' · needs you' : ''}</p>
    </div>
  );
}

function RequestItem({ r }: { r: RequestRow }) {
  const { snap, idx } = useHq();
  const client = r.client_id ? idx.clientById.get(r.client_id)?.name : undefined;
  const prog = requestProgress(r, snap.tasks);
  const Icon = SOURCE[r.source] ?? Send;
  const pending = r.id.startsWith('temp-');
  return (
    <li className={clsx('item flex flex-col gap-3 p-4 transition-opacity', pending && 'opacity-60')}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-panel)] text-[var(--color-muted)]" title={`From ${r.source}`}>
          <Icon size={15} aria-label={`From ${r.source}`} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-medium leading-snug">{r.title ?? clip(r.raw_text, 120)}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-[var(--color-muted)]" suppressHydrationWarning>
            {client && <span className="rounded-full bg-[var(--color-panel)] px-2 py-0.5 text-xs text-[var(--color-ink)]">{client}</span>}
            {r.priority !== 'normal' && <span className="text-xs font-medium capitalize" style={{ color: PRIORITY_COLOR[r.priority] }}>{r.priority}</span>}
            <span>{relDay(r.created_at)}</span>
            {r.due_date && <span>· due {relDay(r.due_date)}</span>}
            {Number(r.cost_usd) > 0 && <span>· {money(r.cost_usd)}</span>}
          </p>
          {r.title && <p className="mt-1 line-clamp-1 text-[13px] text-[var(--color-dim)]">“{r.raw_text}”</p>}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_160px] sm:items-start sm:gap-6">
        <Pipeline r={r} />
        <div>
          <div className="flex items-center justify-between text-xs text-[var(--color-muted)]">
            <span>Tasks</span><span className="tabular-nums">{prog.total ? `${prog.done}/${prog.total} · ${prog.pct}%` : pending ? 'Sending…' : 'Not planned yet'}</span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--color-line)]" role="progressbar" aria-valuenow={prog.pct} aria-valuemin={0} aria-valuemax={100} aria-label="Task progress">
            <div className="h-full rounded-full bg-[var(--color-info)] transition-[width] duration-500" style={{ width: `${prog.pct}%` }} />
          </div>
        </div>
      </div>
    </li>
  );
}

export function RequestsView() {
  const { snap } = useHq();
  const [filter, setFilter] = useState<FilterId>('active');
  const list = useMemo(() => {
    const sorted = [...snap.requests].sort((a, b) => b.created_at.localeCompare(a.created_at));
    switch (filter) {
      case 'active': return sorted.filter((r) => ['staged', 'planning', 'plan_review', 'in_progress', 'awaiting_ceo'].includes(r.status));
      case 'review': return sorted.filter((r) => r.status === 'plan_review' || r.status === 'awaiting_ceo');
      case 'done': return sorted.filter((r) => ['done', 'rejected', 'cancelled', 'failed'].includes(r.status));
      default: return sorted;
    }
  }, [snap.requests, filter]);

  return (
    <>
      <h1 className="text-2xl font-semibold">Requests</h1>
      <section className="card p-4 sm:p-5" aria-labelledby="new-req">
        <h2 id="new-req" className="mb-3 text-lg font-semibold">New request</h2>
        <NewRequestForm rows={3} />
      </section>
      <section className="card p-4 sm:p-5" aria-labelledby="req-list">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h2 id="req-list" className="text-lg font-semibold">Everything you asked for</h2>
          <div className="flex flex-wrap gap-2 sm:ml-auto">
            {FILTERS.map((f) => (
              <button key={f.id} onClick={() => setFilter(f.id)} aria-pressed={filter === f.id}
                className={clsx('rounded-full border px-3 py-1 text-[13px]', filter === f.id ? 'border-[var(--color-line-active)] bg-[var(--color-panel-2)] text-white' : 'border-[var(--color-line)] text-[var(--color-muted)]')}>
                {f.label}
              </button>
            ))}
          </div>
        </div>
        {list.length === 0 ? (
          <p className="item p-6 text-center text-[15px] text-[var(--color-muted)]">No requests here yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">{list.map((r) => <RequestItem key={r.id} r={r} />)}</ul>
        )}
      </section>
    </>
  );
}
