'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useHq } from '@/lib/data/store';
import { qaScore, relDay } from '@/lib/data/derive';
import type { ApprovalRow, Decision } from '@/lib/data/types';
import { KIND } from './approvalKinds';
import { DecisionButtons } from './DecisionButtons';

const DONE_TEXT = { approved: 'Approved', rejected: 'Rejected', changes_requested: 'Changes requested', pending: '' } as const;

function Item({ ap, fading }: { ap: ApprovalRow; fading: boolean }) {
  const { idx, decide, busy } = useHq();
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const k = KIND[ap.kind]; const Icon = k.icon;
  const agent = ap.agent_id ? idx.agentById.get(ap.agent_id) : undefined;
  const req = ap.request_id ? idx.requestById.get(ap.request_id) : undefined;
  const client = req?.client_id ? idx.clientById.get(req.client_id)?.name : undefined;
  const due = relDay(req?.due_date ?? null);
  const score = qaScore(ap);
  const run = async (d: Decision) => { const ok = await decide(ap.id, d, d === 'changes' ? note : null); if (ok) setNoteOpen(false); };

  return (
    <li className="item p-4 transition-opacity duration-500" style={{ opacity: fading ? 0.5 : 1 }}>
      <Link href={`/approvals?id=${ap.id}`} className="flex items-start gap-3 rounded-lg">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl" style={{ background: `color-mix(in oklab, ${k.color} 18%, transparent)`, color: k.color }}><Icon size={18} aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-medium leading-snug">{ap.title}</p>
          <p className="mt-0.5 text-[13px] text-[var(--color-muted)]" suppressHydrationWarning>
            {k.label}{agent ? ` · ${agent.name}` : ''}{client ? ` · ${client}` : ''}{due ? ` · ${due}` : ''}
          </p>
          {ap.summary && <p className="mt-1.5 line-clamp-2 text-[13px] text-[var(--color-dim)]">{ap.summary}{score && !ap.summary.includes('QA') ? ` · QA ${score}` : ''}</p>}
        </div>
      </Link>
      {fading ? (
        <p className="mt-3 text-sm" style={{ color: ap.status === 'approved' ? 'var(--color-success)' : ap.status === 'rejected' ? 'var(--color-danger)' : 'var(--color-warning)' }}>{DONE_TEXT[ap.status]}</p>
      ) : noteOpen ? (
        <form className="mt-3 flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void run('changes'); }}>
          <label htmlFor={`note-${ap.id}`} className="sr-only">What should change?</label>
          <textarea id={`note-${ap.id}`} autoFocus value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="What should change?"
            className="w-full resize-none rounded-[10px] border border-[var(--color-line)] bg-[var(--color-panel)] p-3 text-sm outline-none placeholder:text-[var(--color-dim)] focus:border-[var(--color-line-active)]" />
          <div className="flex gap-2">
            <button type="submit" disabled={!note.trim() || busy.has(ap.id)} className="h-9 flex-1 rounded-[10px] bg-[var(--color-primary)] text-sm font-medium disabled:opacity-40">Send changes</button>
            <button type="button" onClick={() => setNoteOpen(false)} className="h-9 rounded-[10px] border border-[var(--color-line)] px-3 text-sm text-[var(--color-muted)]">Cancel</button>
          </div>
        </form>
      ) : (
        <div className="mt-3">
          <DecisionButtons compact disabled={busy.has(ap.id)} onApprove={() => void run('approve')} onChanges={() => setNoteOpen(true)} onReject={() => void run('reject')} />
        </div>
      )}
    </li>
  );
}

export function ApprovalsColumn() {
  const { snap, kpis } = useHq();
  // Keep just-decided items visible for a moment so the decision is acknowledged in place.
  const [recent] = useState(() => new Map<string, number>());
  const [tick, setTick] = useState(0);
  const items = useMemo(() => {
    const now = Date.now();
    const list = snap.approvals.filter((a) => {
      if (a.status === 'pending') return true;
      if (a.decided_via !== 'dashboard' || !a.decided_at) return false;
      const t = recent.get(a.id) ?? new Date(a.decided_at).getTime();
      recent.set(a.id, t);
      return now - t < 1500;
    });
    return list.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 5);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.approvals, recent, tick]);
  const fadingCount = items.filter((a) => a.status !== 'pending').length;
  useEffect(() => {
    if (!fadingCount) return;
    const t = setTimeout(() => setTick((n) => n + 1), 1600);
    return () => clearTimeout(t);
  }, [fadingCount, tick]);

  return (
    <section className="card flex min-w-0 flex-col p-4 sm:p-5" aria-labelledby="ap-title">
      <div className="mb-4 flex items-center gap-2">
        <h2 id="ap-title" className="text-lg font-semibold">Approvals</h2>
        <span className="rounded-md bg-[var(--color-primary)] px-1.5 text-sm font-semibold">{kpis.pendingApprovals}</span>
        <Link href="/approvals" className="ml-auto text-sm text-[var(--color-primary-hover)] hover:underline">View all</Link>
      </div>
      <ul className="flex flex-col gap-3">
        {items.length === 0 && <li className="item p-6 text-center text-[15px] text-[var(--color-muted)]">All clear. Nothing waiting for you.</li>}
        {items.map((ap) => <Item key={ap.id} ap={ap} fading={ap.status !== 'pending'} />)}
      </ul>
    </section>
  );
}
