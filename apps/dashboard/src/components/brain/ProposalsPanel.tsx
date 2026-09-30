'use client';
// Agent proposals (M14.4): what the HQ agents suggested for the memory, and what happened to each. Deciding happens in
// the normal Approvals inbox (or Telegram); approved ones are written to the vault by the brain within ~20 s.
import Link from 'next/link';
import clsx from 'clsx';
import { ago, type BrainProposal } from '@/lib/brainView';

const STATUS: Record<BrainProposal['status'], { label: string; color: string }> = {
  pending: { label: 'Waiting for you', color: '#fbbf24' },
  approved: { label: 'Approved · saving', color: '#5eead4' },
  applying: { label: 'Saving…', color: '#5eead4' },
  applied: { label: 'Saved', color: '#34d399' },
  rejected: { label: 'Rejected', color: 'var(--color-dim)' },
  failed: { label: 'Could not save', color: '#f87171' },
};
const KIND: Record<string, string> = { decision: 'Decision', next_step: 'Next step', fact: 'Fact', lesson: 'Lesson', session_note: 'Session note', lead_note: 'Lead note' };

export function ProposalsPanel({ proposals }: { proposals: BrainProposal[] }) {
  if (!proposals.length) {
    return <p className="text-sm text-[var(--color-muted)]">No proposals yet. When an agent learns something worth keeping, it suggests it here and in Approvals.</p>;
  }
  const pending = proposals.filter((p) => p.status === 'pending').length;
  return (
    <div className="flex flex-col gap-3">
      {pending > 0 && <p className="text-sm"><strong>{pending}</strong> waiting for you in <Link href="/approvals" className="text-[#7dd3fc] underline underline-offset-2">Approvals</Link> (or on Telegram).</p>}
      <ul className="grid gap-2 md:grid-cols-2">
        {proposals.slice(0, 12).map((p) => {
          const s = STATUS[p.status];
          const body = (
            <>
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                <span className="rounded-full border px-2 py-0.5" style={{ borderColor: s.color, color: s.color }}>{s.label}</span>
                <span className="text-[var(--color-muted)]">{KIND[p.kind] ?? p.kind}{p.section ? ` · ${p.section}` : ''} · {p.project_name ?? p.project_slug}</span>
              </span>
              <span className="mt-1.5 line-clamp-3 block text-sm">{p.text}</span>
              <span className="mt-1 block text-[11px] text-[var(--color-dim)]">
                {p.agent_name ?? p.agent_id} · {ago(p.created_at)}{p.status === 'failed' && p.error ? ` · ${p.error}` : ''}{p.status === 'rejected' && p.ceo_note ? ` · “${p.ceo_note}”` : ''}
              </span>
            </>
          );
          return (
            <li key={p.id}>
              {p.approval_id && p.status === 'pending'
                ? <Link href={`/approvals?id=${p.approval_id}`} className={clsx('item block px-3.5 py-3 hover:border-[var(--color-line-active)]')}>{body}</Link>
                : p.status === 'applied' ? <Link href={`/brain/${p.project_slug}`} className="item block px-3.5 py-3 hover:border-[var(--color-line-active)]">{body}</Link>
                : <div className="item px-3.5 py-3">{body}</div>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
