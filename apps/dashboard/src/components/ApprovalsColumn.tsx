'use client';
import { useState } from 'react';
import Link from 'next/link';
import { ClipboardList, FileCheck2, Zap, Check, X, Pencil } from 'lucide-react';
import { approvals as initial, agentById, type Approval } from '@/lib/mock';

const KIND = {
  plan: { label: 'Plan', icon: ClipboardList, color: 'var(--color-primary-hover)' },
  deliverable: { label: 'Deliverable', icon: FileCheck2, color: 'var(--color-teal)' },
  external_action: { label: 'Action', icon: Zap, color: 'var(--color-warning)' },
} as const;

export function ApprovalsColumn() {
  const [items, setItems] = useState<Approval[]>(initial);
  const [done, setDone] = useState<Record<string, 'approved' | 'rejected'>>({});
  const decide = (id: string, d: 'approved' | 'rejected') => {
    setDone((s) => ({ ...s, [id]: d }));
    setTimeout(() => setItems((s) => s.filter((x) => x.id !== id)), 900);
  };
  return (
    <section className="card flex min-w-0 flex-col p-4 sm:p-5" aria-labelledby="ap-title">
      <div className="mb-4 flex items-center gap-2">
        <h2 id="ap-title" className="text-lg font-semibold">Approvals</h2>
        <span className="rounded-md bg-[var(--color-primary)] px-1.5 text-sm font-semibold">{items.length}</span>
        <Link href="/approvals" className="ml-auto text-sm text-[var(--color-primary-hover)] hover:underline">View all</Link>
      </div>
      <ul className="flex flex-col gap-3">
        {items.length === 0 && <li className="item p-6 text-center text-[15px] text-[var(--color-muted)]">All clear. Nothing waiting for you.</li>}
        {items.map((ap) => {
          const k = KIND[ap.kind]; const Icon = k.icon; const agent = agentById[ap.agentId]; const state = done[ap.id];
          return (
            <li key={ap.id} className="item p-4 transition-opacity" style={{ opacity: state ? 0.5 : 1 }}>
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl" style={{ background: `color-mix(in oklab, ${k.color} 18%, transparent)`, color: k.color }}><Icon size={18} /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-medium leading-snug">{ap.title}</p>
                  <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">{k.label} · {agent?.name}{ap.client ? ` · ${ap.client}` : ''} · {ap.due}</p>
                  <p className="mt-1.5 text-[13px] text-[var(--color-dim)]">{ap.summary}{ap.qaScore ? ` · QA ${ap.qaScore}` : ''}</p>
                </div>
              </div>
              {state ? (
                <p className="mt-3 text-sm" style={{ color: state === 'approved' ? 'var(--color-success)' : 'var(--color-danger)' }}>{state === 'approved' ? 'Approved' : 'Rejected'}</p>
              ) : (
                <div className="mt-3 flex gap-2">
                  <button onClick={() => decide(ap.id, 'approved')} className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-[10px] bg-[var(--color-success)] text-sm font-medium"><Check size={16} /> Approve</button>
                  <button className="flex h-9 items-center justify-center gap-1.5 rounded-[10px] border border-[var(--color-line)] px-3 text-sm text-[var(--color-muted)]"><Pencil size={15} /> Edit</button>
                  <button onClick={() => decide(ap.id, 'rejected')} className="flex h-9 items-center justify-center gap-1.5 rounded-[10px] border border-[color-mix(in_oklab,var(--color-danger)_50%,transparent)] px-3 text-sm text-[#ff8a8d]"><X size={15} /> Reject</button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
