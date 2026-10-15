'use client';
// /operator → Jobs (docs/17-OPERATOR.md "Phase 2: worker mode", "Phase 3"): what the operator is working on for this
// client, what waits for your OK, what it finished (summary, links, QA, cost), and "Add task". A job's changes to the
// outside world are decided in Approvals / Telegram; here you only add and cancel.
import { useMemo, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { ChevronDown, ExternalLink, Plus, X } from 'lucide-react';
import { btn, inputCls } from '@/components/clients/ui';
import {
  ACTION_KIND_LABEL, ago, JOB_STATUS, sortJobs, usd,
  type OperatorClientRow, type OperatorHomeData, type OperatorJobRow,
} from '@/lib/operatorView';
import { addJobAction, cancelJobAction, type OperatorResult } from '@/app/operator-actions';
import { Pill } from './Pill';

type Run = (fn: () => Promise<OperatorResult>, done: string) => void;

export function OperatorJobs({ data, client, pending, run }: { data: OperatorHomeData; client: OperatorClientRow; pending: boolean; run: Run }) {
  const [adding, setAdding] = useState(false);
  const [brief, setBrief] = useState('');
  const [channel, setChannel] = useState('');
  const [showDone, setShowDone] = useState(false);
  const jobs = useMemo(() => sortJobs(data.jobs.filter((j) => j.client_slug === client.slug)), [data.jobs, client.slug]);
  const open = jobs.filter((j) => JOB_STATUS[j.status].open);
  const closed = jobs.filter((j) => !JOB_STATUS[j.status].open);
  const chats = data.channels.filter((c) => c.client_slug === client.slug && c.enabled);
  const shown = showDone ? [...open, ...closed] : [...open, ...closed.slice(0, 3)];

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await addJobAction(client.slug, brief, channel || null);
      if (r.ok) { setAdding(false); setBrief(''); setChannel(''); }
      return r;
    }, 'Task queued: Telegram tells you when it starts and when it\'s done');
  };

  return (
    <section aria-label="Jobs" className="card min-w-0 p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">Jobs</h2>
        {open.length > 0 && <Pill tone="brand">{open.length} open</Pill>}
        {!adding && (
          <button className={clsx(btn.primary, 'ml-auto')} disabled={data.demo} title={data.demo ? 'Works on the live dashboard' : undefined} onClick={() => setAdding(true)}>
            <Plus size={16} aria-hidden />Add task
          </button>
        )}
      </div>

      {adding && (
        <form onSubmit={submit} className="item mb-3 flex flex-col gap-2 p-3" style={{ animation: 'brain-in .25s ease-out' }}>
          <label htmlFor="op-task" className="text-[13px] font-medium">What should the operator do for {client.name}?</label>
          <textarea id="op-task" className={clsx(inputCls, 'min-h-[88px] py-2')} value={brief} onChange={(e) => setBrief(e.target.value)} maxLength={8000}
            placeholder="e.g. Add Sam Lee to the team page. Photo and bio are in the shared drive (Team folder)." autoFocus />
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <label htmlFor="op-task-chat" className="text-xs text-[var(--color-muted)]">Tell the client in</label>
            <select id="op-task-chat" className={clsx(inputCls, 'sm:max-w-xs')} value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="">Nobody (only Telegram)</option>
              {chats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <p className="text-xs text-[var(--color-dim)]">It works in {client.name}&apos;s browser and tools, checks the result on mobile and desktop, and asks you before publishing, sending or deleting anything.</p>
          <div className="flex gap-2">
            <button className={btn.primary} disabled={pending || brief.trim().length < 3}>Queue task</button>
            <button type="button" className={btn.ghost} onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </form>
      )}

      {jobs.length === 0 && !adding
        ? <p className="py-6 text-center text-sm text-[var(--color-muted)]">No jobs yet. Approving a &quot;new task&quot; reply starts one, or add a task here or with /task on Telegram.</p>
        : (
          <ul className="flex flex-col gap-2">
            {shown.map((j) => <JobItem key={j.id} job={j} data={data} pending={pending} run={run} />)}
          </ul>
        )}
      {closed.length > 3 && (
        <button className={clsx(btn.ghost, 'mt-2')} onClick={() => setShowDone((v) => !v)} aria-expanded={showDone}>
          <ChevronDown size={14} className={clsx('transition-transform', showDone && 'rotate-180')} aria-hidden />
          {showDone ? 'Show fewer' : `Show ${closed.length - 3} more finished`}
        </button>
      )}
    </section>
  );
}

function JobItem({ job, data, pending, run }: { job: OperatorJobRow; data: OperatorHomeData; pending: boolean; run: Run }) {
  const [open, setOpen] = useState(job.status === 'waiting' || job.status === 'escalated');
  const st = JOB_STATUS[job.status];
  const actions = data.jobActions.filter((a) => a.job_id === job.id);
  const waiting = actions.filter((a) => a.status === 'pending');
  const links = (job.result?.links ?? []).filter((l) => /^https:\/\//.test(l)).slice(0, 4);
  const why = job.status === 'escalated' ? job.result?.needs_from_julev || job.error : job.status === 'failed' ? job.error : null;
  return (
    <li className="item px-3.5 py-3" style={{ animation: 'brain-in .3s ease-out' }}>
      <button className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{job.title}</span>
        <Pill tone={st.tone}>{st.label}{waiting.length ? ` · ${waiting.length}` : ''}</Pill>
        <ChevronDown size={14} className={clsx('text-[var(--color-dim)] transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      <p className="mt-1 text-[11px] text-[var(--color-dim)]">
        {job.source === 'ceo' ? 'You added it' : 'From the client chat'} · {ago(job.created_at)} · run {job.runs}/{job.max_runs} · {usd(job.cost_usd)}
      </p>
      {why && <p className="mt-1.5 text-[13px] text-[#ff9a9d]">{why}</p>}
      {open && (
        <div className="mt-2 flex flex-col gap-2 text-[13px]">
          <p className="whitespace-pre-line text-[var(--color-muted)]">{job.brief}</p>
          {job.result?.summary && job.status === 'done' && <p>{job.result.summary}</p>}
          {links.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {links.map((l) => <a key={l} href={l} target="_blank" rel="noopener noreferrer" className={btn.small}><ExternalLink size={13} aria-hidden />{l.replace(/^https:\/\//, '').slice(0, 40)}</a>)}
            </div>
          )}
          {job.qa && <p className="text-xs text-[var(--color-muted)]">QA {job.qa.pass ? '✓ passed (375 / 1366 px, console, requests, links)' : `✗ ${job.qa.errors?.length ?? 0} issue(s)`}{job.qa.evidence?.length ? ` · ${job.qa.evidence.length} screenshots on Telegram` : ''}</p>}
          {job.feedback && job.status === 'queued' && <p className="text-xs text-[#fcd34d]">Next run fixes: {job.feedback.slice(0, 300)}</p>}
          {actions.length > 0 && (
            <ul className="flex flex-col gap-1">
              {actions.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--color-panel-2)] px-2.5 py-1.5">
                  <span className="min-w-0 flex-1 text-xs"><b className="font-medium">{ACTION_KIND_LABEL[a.kind] ?? a.kind}:</b> {a.summary}</span>
                  {a.status === 'pending' && a.approval_id
                    ? <Link href={`/approvals?id=${a.approval_id}`} className={btn.small}>Decide</Link>
                    : <Pill tone={a.status === 'done' ? 'success' : a.status === 'failed' || a.status === 'rejected' ? 'danger' : a.status === 'pending' ? 'warning' : 'muted'}>{a.status}</Pill>}
                </li>
              ))}
            </ul>
          )}
          {st.open && !data.demo && (
            <button className={clsx(btn.ghost, 'self-start')} disabled={pending} onClick={() => run(() => cancelJobAction(job.id), 'Job cancelled; its waiting changes will not run')}>
              <X size={14} aria-hidden />Cancel job
            </button>
          )}
        </div>
      )}
    </li>
  );
}
