'use client';
// Agents roster + agent page (docs/06 §8). Role files are read-only here (edited in git for now).
import { useMemo, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { ArrowLeft, ChevronRight, FileText, Search } from 'lucide-react';
import type { AgentStatus } from '@rizehubhq/shared';
import type { AgentDetail, RosterAgent } from '@/lib/data/vault';
import { useHq } from '@/lib/data/store';
import { STATUS_COLOR, STATUS_LABEL } from '@/lib/status';
import { relDay } from '@/lib/data/derive';
import { Avatar } from '../Avatar';

const DEPTS = ['all', 'leadership', 'growth', 'dev', 'design', 'content', 'qa'] as const;
const dept = (d: string) => (d === 'qa' ? 'QA' : d.replace(/^./, (c) => c.toUpperCase()));
const usd = (n: number) => `$${n.toFixed(2)}`;

function useLiveStatus(a: RosterAgent): AgentStatus {
  const { idx } = useHq();
  return (idx.agentById.get(a.id)?.status ?? a.status) as AgentStatus;
}

function StatusBadge({ status }: { status: AgentStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[13px]" style={{ color: `color-mix(in oklab, ${STATUS_COLOR[status]} 75%, white)` }}>
      <span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[status] }} aria-hidden />{STATUS_LABEL[status] ?? status}
    </span>
  );
}

function EnabledToggle({ on }: { on: boolean }) {
  return (
    <span role="switch" aria-checked={on} aria-readonly aria-label={on ? 'Enabled' : 'Disabled'} title="Read-only for now"
      className={clsx('relative inline-flex h-5 w-9 shrink-0 cursor-not-allowed items-center rounded-full opacity-80', on ? 'bg-[var(--color-success)]' : 'bg-[var(--color-line)]')}>
      <span className={clsx('absolute h-4 w-4 rounded-full bg-white transition-transform', on ? 'translate-x-[18px]' : 'translate-x-0.5')} />
    </span>
  );
}

function qaColor(p: number | null) {
  if (p === null) return 'var(--color-dim)';
  return p >= 85 ? 'var(--color-success)' : p >= 70 ? 'var(--color-warning)' : 'var(--color-danger)';
}

function Row({ a }: { a: RosterAgent }) {
  const status = useLiveStatus(a);
  return (
    <tr className="border-t border-[var(--color-line)] hover:bg-[var(--color-panel-2)]">
      <td className="py-2.5 pl-4 pr-2">
        <Link href={`/agents/${a.id}`} className="flex items-center gap-3">
          <Avatar name={a.name} color={a.color} status={status} size={34} />
          <span className="min-w-0"><span className="block truncate font-medium">{a.name}</span><span className="block text-xs text-[var(--color-dim)]">{a.id}</span></span>
        </Link>
      </td>
      <td className="px-2 text-[var(--color-muted)]">{dept(a.department)}</td>
      <td className="px-2"><span className="rounded-md bg-[var(--color-panel)] px-1.5 py-0.5 text-xs">{a.model_role}</span>{a.model_override && <span className="ml-1.5 text-xs text-[var(--color-dim)]" title="Model override">{a.model_override.split(':')[1] ?? a.model_override}</span>}</td>
      <td className="px-2"><StatusBadge status={status} /></td>
      <td className="px-2 text-right tabular-nums">{a.stats.tasksToday}</td>
      <td className="px-2 text-right tabular-nums" style={{ color: qaColor(a.stats.qaPass) }} title={`${a.stats.qaReviews} reviews in 7 days`}>{a.stats.qaPass === null ? '—' : `${a.stats.qaPass}%`}</td>
      <td className="px-2 text-right tabular-nums">{usd(a.stats.costToday)}<span className="text-xs text-[var(--color-dim)]"> / {usd(a.daily_budget_usd)}</span></td>
      <td className="px-2"><EnabledToggle on={a.enabled} /></td>
      <td className="pr-3"><Link href={`/agents/${a.id}`} aria-label={`Open ${a.name}`} className="text-[var(--color-dim)] hover:text-white"><ChevronRight size={18} /></Link></td>
    </tr>
  );
}

function MobileCard({ a }: { a: RosterAgent }) {
  const status = useLiveStatus(a);
  return (
    <li>
      <Link href={`/agents/${a.id}`} className="item flex items-center gap-3 p-3">
        <Avatar name={a.name} color={a.color} status={status} size={40} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center justify-between gap-2"><span className="truncate font-medium">{a.name}</span><EnabledToggle on={a.enabled} /></p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-[var(--color-muted)]">{dept(a.department)} · {a.model_role}<StatusBadge status={status} /></p>
          <p className="mt-1 flex gap-3 text-xs tabular-nums text-[var(--color-muted)]">
            <span>{a.stats.tasksToday} tasks today</span>
            <span style={{ color: qaColor(a.stats.qaPass) }}>QA {a.stats.qaPass === null ? '—' : `${a.stats.qaPass}%`}</span>
            <span>{usd(a.stats.costToday)}</span>
          </p>
        </div>
      </Link>
    </li>
  );
}

export function AgentsView({ agents, error }: { agents: RosterAgent[]; error?: string }) {
  const [d, setD] = useState<(typeof DEPTS)[number]>('all');
  const [q, setQ] = useState('');
  const list = useMemo(() => agents.filter((a) => (d === 'all' || a.department === d)
    && (!q.trim() || `${a.name} ${a.id} ${a.department}`.toLowerCase().includes(q.trim().toLowerCase()))), [agents, d, q]);
  const cost = agents.reduce((s, a) => s + a.stats.costToday, 0);
  const tasks = agents.reduce((s, a) => s + a.stats.tasksToday, 0);
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Agents</h1>
          <p className="text-sm text-[var(--color-muted)]">{agents.length} AI employees · {tasks} tasks today · {usd(cost)} spent today</p>
        </div>
        <label className="relative w-full sm:w-64">
          <span className="sr-only">Search agents</span>
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-dim)]" aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search agents"
            className="h-10 w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-2)] pl-9 pr-3 text-[14px] outline-none placeholder:text-[var(--color-dim)] focus:border-[var(--color-line-active)]" />
        </label>
      </div>
      {error && <p role="alert" className="item px-4 py-3 text-sm text-[#ff8a8d]">Couldn&apos;t load agents: {error}</p>}
      <section className="card p-3 sm:p-4" aria-label="Roster">
        <div className="scroll-thin mb-3 flex gap-2 overflow-x-auto pb-1">
          {DEPTS.map((x) => (
            <button key={x} onClick={() => setD(x)} aria-pressed={d === x}
              className={clsx('shrink-0 rounded-full border px-3 py-1 text-[13px]', d === x ? 'border-[var(--color-line-active)] bg-[var(--color-panel-2)] text-white' : 'border-[var(--color-line)] text-[var(--color-muted)]')}>
              {x === 'all' ? 'All' : dept(x)}
            </button>
          ))}
        </div>
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-[var(--color-dim)]">
                <th className="py-2 pl-4 pr-2 font-medium">Agent</th><th className="px-2 font-medium">Department</th><th className="px-2 font-medium">Model</th>
                <th className="px-2 font-medium">Status</th><th className="px-2 text-right font-medium">Tasks today</th><th className="px-2 text-right font-medium">QA pass (7d)</th>
                <th className="px-2 text-right font-medium">Cost today</th><th className="px-2 font-medium">Enabled</th><th className="w-8" />
              </tr>
            </thead>
            <tbody>{list.map((a) => <Row key={a.id} a={a} />)}</tbody>
          </table>
        </div>
        <ul className="flex flex-col gap-2 md:hidden">{list.map((a) => <MobileCard key={a.id} a={a} />)}</ul>
        {list.length === 0 && <p className="p-6 text-center text-sm text-[var(--color-muted)]">No agents match.</p>}
      </section>
    </>
  );
}

function splitFrontMatter(text: string): { fm: [string, string][]; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { fm: [], body: text };
  const fm = m[1]!.split('\n').map((l) => { const i = l.indexOf(':'); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] as [string, string]; }).filter(([k]) => k);
  return { fm, body: text.slice(m[0].length) };
}

const TASK_COLOR: Record<string, string> = { done: 'var(--color-success)', working: 'var(--color-info)', failed: 'var(--color-danger)', awaiting_ceo: 'var(--color-primary-hover)', qa_pending: 'var(--color-teal)', qa_reviewing: 'var(--color-teal)' };

export function AgentDetailView({ detail, error }: { detail: AgentDetail; error?: string }) {
  const { agent: a, roleFile, tasks } = detail;
  const status = useLiveStatus(a);
  const rf = roleFile ? splitFrontMatter(roleFile.text) : null;
  return (
    <>
      <Link href="/agents" className="inline-flex w-fit items-center gap-1 text-sm text-[var(--color-muted)] hover:text-white"><ArrowLeft size={15} aria-hidden />Agents</Link>
      <div className="flex flex-wrap items-center gap-4">
        <Avatar name={a.name} color={a.color} status={status} size={56} />
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold">{a.name}</h1>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-[var(--color-muted)]">{dept(a.department)} · model role <b className="font-medium text-white">{a.model_role}</b>{a.model_override ? ` (override ${a.model_override})` : ''}<StatusBadge status={status} /></p>
        </div>
        <span className="flex items-center gap-2 text-sm text-[var(--color-muted)]"><EnabledToggle on={a.enabled} />{a.enabled ? 'Enabled' : 'Disabled'}</span>
      </div>
      {error && <p role="alert" className="item px-4 py-3 text-sm text-[#ff8a8d]">{error}</p>}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Stats">
        {[['Tasks today', String(a.stats.tasksToday)], ['QA pass (7 days)', a.stats.qaPass === null ? '—' : `${a.stats.qaPass}%`], ['Cost today', usd(a.stats.costToday)], ['Daily budget', usd(a.daily_budget_usd)]].map(([l, v]) => (
          <div key={l} className="card px-4 py-3"><p className="text-[13px] text-[var(--color-muted)]">{l}</p><p className="mt-0.5 text-2xl font-semibold tabular-nums">{v}</p></div>
        ))}
      </section>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="card min-w-0 p-4 sm:p-5" aria-labelledby="role-h">
          <h2 id="role-h" className="mb-3 flex items-center gap-2 text-lg font-semibold"><FileText size={18} aria-hidden />Role file <span className="text-xs font-normal text-[var(--color-dim)]">{roleFile?.path ?? ''} · read-only</span></h2>
          {!rf ? <p className="text-sm text-[var(--color-muted)]">Role file not found on this server (agents/{a.id}.md).</p> : (
            <>
              {rf.fm.length > 0 && (
                <dl className="item mb-3 grid gap-x-4 gap-y-1.5 p-3 text-[13px] sm:grid-cols-[140px_minmax(0,1fr)]">
                  {rf.fm.map(([k, v]) => <div key={k} className="contents"><dt className="text-[var(--color-dim)]">{k}</dt><dd className="break-words font-mono text-xs text-[var(--color-ink)]">{v}</dd></div>)}
                </dl>
              )}
              <pre className="scroll-thin max-h-[560px] overflow-auto whitespace-pre-wrap break-words rounded-[14px] bg-[var(--color-panel-2)] p-4 font-mono text-[12.5px] leading-relaxed text-[var(--color-muted)]">{rf.body.trim()}</pre>
            </>
          )}
        </section>
        <section className="card p-4 sm:p-5" aria-labelledby="tasks-h">
          <h2 id="tasks-h" className="mb-3 text-lg font-semibold">Recent tasks</h2>
          {tasks.length === 0 ? <p className="text-sm text-[var(--color-muted)]">No tasks yet.</p> : (
            <ul className="flex flex-col gap-2">
              {tasks.map((t) => (
                <li key={t.id} className="item px-3.5 py-2.5" suppressHydrationWarning>
                  <p className="text-[14px] font-medium leading-snug">{t.title}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--color-muted)]">
                    <span className="capitalize" style={{ color: TASK_COLOR[t.status] ?? 'var(--color-muted)' }}>{t.status.replace(/_/g, ' ')}</span>
                    <span>{t.work_type}</span>
                    {t.client_name && <span className="rounded bg-[var(--color-panel)] px-1.5 py-0.5">{t.client_name}</span>}
                    <span className="text-[var(--color-dim)]">{relDay(t.completed_at ?? t.created_at)}</span>
                    {t.cost_usd > 0 && <span className="text-[var(--color-dim)]">{usd(t.cost_usd)}</span>}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
