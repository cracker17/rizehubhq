'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { RotateCcw } from 'lucide-react';
import { useHq } from '@/lib/data/store';
import { COLUMNS, columnFor, money, type Column } from '@/lib/data/derive';
import type { TaskRow } from '@/lib/data/types';
import { Avatar } from './Avatar';

const COL_COLOR: Record<Column, string> = {
  queued: 'var(--color-dim)', working: 'var(--color-success)', qa: 'var(--color-teal)', needs: 'var(--color-primary-hover)', done: 'var(--color-info)',
};
const STATUS_TEXT: Record<string, string> = {
  pending: 'Blocked by dep.', queued: 'Queued', revision: 'Revision', working: 'Working', qa_pending: 'QA queue',
  qa_reviewing: 'In review', awaiting_ceo: 'Approve', failed: 'Stuck', done: 'Done',
};
const select = 'h-9 min-w-0 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-2)] px-3 text-sm outline-none focus:border-[var(--color-line-active)]';

function Card({ t }: { t: TaskRow }) {
  const { idx, snap } = useHq();
  const agent = idx.agentById.get(t.agent_id);
  const client = t.client_id ? idx.clientById.get(t.client_id)?.name : undefined;
  const screen = idx.screenByAgent.get(t.agent_id);
  const progress = t.status === 'working' && screen?.task_id === t.id ? screen.progress : null;
  const approval = t.status === 'awaiting_ceo' || t.status === 'failed'
    ? snap.approvals.find((a) => a.task_id === t.id && a.status === 'pending') : undefined;
  const revision = t.status === 'queued' && t.revision_count > 0;
  const body = (
    <>
      <p className="text-[14px] font-medium leading-snug">{t.title}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {client && <span className="rounded-full bg-[var(--color-panel)] px-2 py-0.5 text-[11px]">{client}</span>}
        {t.revision_count > 0 && (
          <span className="flex items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--color-warning)_16%,transparent)] px-2 py-0.5 text-[11px] text-[var(--color-warning)]" title={`${t.revision_count} revision(s)`}>
            <RotateCcw size={11} aria-hidden /> {t.revision_count}
          </span>
        )}
        {Number(t.cost_usd) > 0 && <span className="text-[11px] text-[var(--color-dim)]">{money(t.cost_usd)}</span>}
      </div>
      {progress != null && (
        <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-[var(--color-line)]" aria-label={`${progress}% done`}>
          <div className="h-full rounded-full bg-[var(--color-success)]" style={{ width: `${progress}%` }} />
        </div>
      )}
      <div className="mt-2.5 flex items-center gap-2 border-t border-[var(--color-line)] pt-2.5">
        <Avatar id={t.agent_id} name={agent?.name ?? t.agent_id} color={agent?.avatar?.color ?? '#6D4AFF'} size={22} />
        <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-muted)]">{agent?.name ?? t.agent_id}</span>
        <span className="shrink-0 text-[11px] text-[var(--color-dim)]">{revision ? 'Revision' : STATUS_TEXT[t.status] ?? t.status}</span>
      </div>
    </>
  );
  return approval ? (
    <li><Link href={`/approvals?id=${approval.id}`} className="item block p-3 hover:border-[var(--color-line-active)]">{body}</Link></li>
  ) : (
    <li className="item p-3">{body}</li>
  );
}

export function TasksBoard() {
  const { snap } = useHq();
  const [client, setClient] = useState('');
  const [agent, setAgent] = useState('');
  const [priority, setPriority] = useState('');
  const [mobileCol, setMobileCol] = useState<Column>('working');

  const byCol = useMemo(() => {
    const now = new Date();
    const prio = new Map(snap.requests.map((r) => [r.id, r.priority]));
    const out: Record<Column, TaskRow[]> = { queued: [], working: [], qa: [], needs: [], done: [] };
    for (const t of snap.tasks) {
      if (client && t.client_id !== client) continue;
      if (agent && t.agent_id !== agent) continue;
      if (priority && prio.get(t.request_id) !== priority) continue;
      const c = columnFor(t, now);
      if (c) out[c].push(t);
    }
    for (const c of Object.keys(out) as Column[]) out[c].sort((a, b) => (c === 'done' ? (b.completed_at ?? '').localeCompare(a.completed_at ?? '') : a.created_at.localeCompare(b.created_at)));
    return out;
  }, [snap.tasks, snap.requests, client, agent, priority]);

  const agentsWithTasks = useMemo(() => {
    const ids = new Set(snap.tasks.map((t) => t.agent_id));
    return snap.agents.filter((a) => ids.has(a.id)).sort((a, b) => a.name.localeCompare(b.name));
  }, [snap.tasks, snap.agents]);

  const column = (c: (typeof COLUMNS)[number], showHeader = true) => (
    <section key={c.id} className="flex min-w-0 flex-col" aria-labelledby={showHeader ? `col-${c.id}` : undefined} aria-label={showHeader ? undefined : c.label}>
      {showHeader && (
        <h2 id={`col-${c.id}`} className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <span className="h-2 w-2 rounded-full" style={{ background: COL_COLOR[c.id] }} aria-hidden />
          {c.label}
          <span className="rounded bg-[var(--color-panel-2)] px-1.5 text-xs text-[var(--color-muted)]">{byCol[c.id].length}</span>
        </h2>
      )}
      {byCol[c.id].length === 0
        ? <p className="rounded-[14px] border border-dashed border-[var(--color-line)] p-4 text-center text-[13px] text-[var(--color-dim)]">Nothing here</p>
        : <ul className="flex flex-col gap-2.5 md:grid md:grid-cols-2 md:gap-3 xl:flex xl:flex-col xl:gap-2.5">{byCol[c.id].map((t) => <Card key={t.id} t={t} />)}</ul>}
    </section>
  );

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">Tasks</h1>
        <div className="grid w-full grid-cols-3 gap-2 sm:ml-auto sm:flex sm:w-auto">
          <select value={client} onChange={(e) => setClient(e.target.value)} className={select} aria-label="Filter by client">
            <option value="">All clients</option>
            {snap.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select value={agent} onChange={(e) => setAgent(e.target.value)} className={select} aria-label="Filter by agent">
            <option value="">All agents</option>
            {agentsWithTasks.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <select value={priority} onChange={(e) => setPriority(e.target.value)} className={select} aria-label="Filter by priority">
            <option value="">Any priority</option>
            <option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option>
          </select>
        </div>
      </div>

      {/* Phones/tablets: one column at a time */}
      <div className="card p-4 xl:hidden">
        <div className="mb-4 grid grid-cols-5 gap-1 rounded-xl bg-[var(--color-panel-2)] p-1" role="tablist" aria-label="Task columns">
          {COLUMNS.map((c) => (
            <button key={c.id} role="tab" aria-selected={mobileCol === c.id} onClick={() => setMobileCol(c.id)}
              className={clsx('flex min-w-0 flex-col items-center rounded-lg px-1 py-1.5 text-[11px] leading-tight sm:text-xs', mobileCol === c.id ? 'bg-[var(--color-primary)] text-white' : 'text-[var(--color-muted)]')}>
              <span className="text-base font-semibold tabular-nums">{byCol[c.id].length}</span>
              <span className="w-full truncate text-center">{c.label.replace(' today', '')}</span>
            </button>
          ))}
        </div>
        {column(COLUMNS.find((c) => c.id === mobileCol)!, false)}
      </div>

      {/* Desktop: full board */}
      <div className="card hidden grid-cols-5 gap-4 p-5 xl:grid">
        {COLUMNS.map((c) => column(c))}
      </div>
    </>
  );
}
