'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { ArrowLeft, Inbox } from 'lucide-react';
import { useHq } from '@/lib/data/store';
import { asAction, qaScore, relDay } from '@/lib/data/derive';
import type { ApprovalRow, Decision } from '@/lib/data/types';
import { KIND } from '../approvalKinds';
import { DecisionButtons } from '../DecisionButtons';
import { ApprovalBody, ApprovalHeader, DecisionRecord } from './ApprovalDetail';

const TABS = [
  { id: 'pending', label: 'Pending' },
  { id: 'plan', label: 'Plans' },
  { id: 'deliverable', label: 'Deliverables' },
  { id: 'external_action', label: 'Actions' },
  { id: 'history', label: 'History' },
] as const;
type TabId = (typeof TABS)[number]['id'];

function filterFor(tab: TabId, list: ApprovalRow[]) {
  if (tab === 'history') {
    return list.filter((a) => a.status !== 'pending').sort((a, b) => (b.decided_at ?? '').localeCompare(a.decided_at ?? ''));
  }
  const pending = list.filter((a) => a.status === 'pending').sort((a, b) => b.created_at.localeCompare(a.created_at));
  return tab === 'pending' ? pending : pending.filter((a) => a.kind === tab);
}

function noteLabel(ap: ApprovalRow) {
  if (ap.kind === 'plan') return 'Note to the COO (answers, changes)';
  if (ap.kind === 'external_action') return asAction(ap).type === 'question' ? 'Your answer' : 'Note to the agent';
  return 'Note (required to request changes)';
}

function Row({ ap, active, onSelect }: { ap: ApprovalRow; active: boolean; onSelect: () => void }) {
  const { idx } = useHq();
  const k = KIND[ap.kind]; const Icon = k.icon;
  const agent = ap.agent_id ? idx.agentById.get(ap.agent_id)?.name : undefined;
  const score = qaScore(ap);
  return (
    <li>
      <button onClick={onSelect} aria-current={active ? 'true' : undefined} data-approval-id={ap.id}
        className={clsx('flex w-full items-start gap-3 rounded-[14px] border p-3.5 text-left transition-colors',
          active ? 'border-[var(--color-line-active)] bg-[var(--color-panel-2)]' : 'border-transparent hover:bg-[var(--color-panel-2)]')}>
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ background: `color-mix(in oklab, ${k.color} 18%, transparent)`, color: k.color }}><Icon size={16} aria-hidden /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-medium">{ap.title}</span>
          <span className="block truncate text-[13px] text-[var(--color-muted)]" suppressHydrationWarning>
            {k.label}{agent ? ` · ${agent}` : ''} · {relDay(ap.status === 'pending' ? ap.created_at : ap.decided_at ?? ap.created_at)}
          </span>
        </span>
        {score !== undefined && <span className="shrink-0 rounded-md bg-[color-mix(in_oklab,var(--color-teal)_18%,transparent)] px-1.5 py-0.5 text-xs text-[var(--color-teal)]">QA {score}</span>}
        {ap.status !== 'pending' && (
          <span className="shrink-0 text-xs" style={{ color: ap.status === 'approved' ? 'var(--color-success)' : ap.status === 'rejected' ? 'var(--color-danger)' : 'var(--color-warning)' }}>
            {ap.status === 'changes_requested' ? 'Changes' : ap.status === 'approved' ? 'Approved' : 'Rejected'}
          </span>
        )}
      </button>
    </li>
  );
}

export function ApprovalsInbox({ initialId }: { initialId?: string }) {
  const { snap, decide, busy } = useHq();
  const initial = initialId ? snap.approvals.find((a) => a.id === initialId) : undefined;
  const [tab, setTab] = useState<TabId>(initial && initial.status !== 'pending' ? 'history' : 'pending');
  const [selectedId, setSelectedId] = useState<string | null>(initial?.id ?? null);
  const [sheet, setSheet] = useState(Boolean(initial)); // phones: detail as a full-screen sheet
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [needNote, setNeedNote] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  // Render the detail in exactly one place: side panel (lg+) or sheet (phones). null = not measured yet.
  const [desktop, setDesktop] = useState<boolean | null>(null);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const on = () => setDesktop(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const list = useMemo(() => filterFor(tab, snap.approvals), [tab, snap.approvals]);
  const counts = useMemo(() => Object.fromEntries(TABS.map((t) => [t.id, filterFor(t.id, snap.approvals).length])) as Record<TabId, number>, [snap.approvals]);
  const selected = (selectedId ? snap.approvals.find((a) => a.id === selectedId) : undefined) ?? list[0];
  const note = selected ? notes[selected.id] ?? '' : '';
  const setNote = (v: string) => selected && setNotes((n) => ({ ...n, [selected.id]: v }));

  // Keep the URL shareable (?id=) without a navigation.
  useEffect(() => {
    if (!selected) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('id') !== selected.id) { url.searchParams.set('id', selected.id); window.history.replaceState(null, '', url); }
  }, [selected]);
  useEffect(() => { setNeedNote(false); }, [selected?.id]);

  const select = useCallback((id: string, openSheet = true) => { setSelectedId(id); if (openSheet) setSheet(true); }, []);
  const move = useCallback((dir: 1 | -1) => {
    if (!list.length) return;
    const i = Math.max(0, list.findIndex((a) => a.id === selected?.id));
    const next = list[Math.min(list.length - 1, Math.max(0, i + dir))];
    setSelectedId(next.id);
    document.querySelector(`[data-approval-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [list, selected?.id]);

  const run = useCallback(async (d: Decision) => {
    if (!selected || selected.status !== 'pending' || busy.has(selected.id)) return;
    if (d === 'changes' && !note.trim()) { setNeedNote(true); noteRef.current?.focus(); return; }
    const i = list.findIndex((a) => a.id === selected.id);
    const nextId = list[i + 1]?.id ?? list[i - 1]?.id ?? null;
    const ok = await decide(selected.id, d, note.trim() || null);
    if (ok && tab !== 'history') { setSelectedId(nextId); if (!nextId) setSheet(false); }
  }, [selected, busy, note, list, decide, tab]);

  // Keyboard: A approve · R request changes · J/K next/prev (ignored while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || t.closest('input, textarea, select, [contenteditable="true"]')) return;
      const k = e.key.toLowerCase();
      if (k === 'j') { e.preventDefault(); move(1); }
      else if (k === 'k') { e.preventDefault(); move(-1); }
      else if (k === 'a') { e.preventDefault(); void run('approve'); }
      else if (k === 'r') { e.preventDefault(); void run('changes'); }
      else if (e.key === 'Escape') setSheet(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [move, run]);

  const pickOption = (o: string) => { setNote(o); noteRef.current?.focus(); };
  const isQuestion = selected?.kind === 'external_action' && asAction(selected).type === 'question';

  const detail = selected ? (
    <div className="flex flex-col gap-4">
      <ApprovalHeader ap={selected} />
      {selected.summary && selected.kind !== 'plan' && <p className="text-[15px] text-[var(--color-muted)]">{selected.summary}</p>}
      <ApprovalBody ap={selected} onPickOption={pickOption} />
      {selected.status === 'pending' ? (
        <div className="sticky bottom-0 -mx-5 -mb-5 flex flex-col gap-3 rounded-b-[20px] border-t border-[var(--color-line)] bg-[var(--color-panel)] px-5 pb-5 pt-4 shadow-[0_-12px_24px_rgba(11,10,31,.55)] max-lg:-mx-4 max-lg:mb-0 max-lg:rounded-none max-lg:px-4 max-lg:pb-4">
          <div>
            <label htmlFor="decision-note" className="mb-1.5 block text-sm text-[var(--color-muted)]">{noteLabel(selected)}</label>
            <textarea id="decision-note" ref={noteRef} value={note} rows={2}
              onChange={(e) => { setNote(e.target.value); if (e.target.value.trim()) setNeedNote(false); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void run(note.trim() && !isQuestion ? 'changes' : 'approve'); } }}
              placeholder={isQuestion ? 'Type or pick an answer…' : 'Optional for approve/reject, required for changes'}
              aria-invalid={needNote} aria-describedby={needNote ? 'note-error' : undefined}
              className={clsx('w-full resize-none rounded-[10px] border bg-[var(--color-panel-2)] p-3 text-sm outline-none placeholder:text-[var(--color-dim)] focus:border-[var(--color-line-active)]',
                needNote ? 'border-[var(--color-danger)]' : 'border-[var(--color-line)]')} />
            {needNote && <p id="note-error" className="mt-1 text-xs text-[#ff8a8d]">Say what should change, then press Request changes.</p>}
          </div>
          <DecisionButtons keys disabled={busy.has(selected.id)} approveLabel={isQuestion ? 'Send answer' : 'Approve'}
            onApprove={() => void run('approve')} onChanges={() => void run('changes')} onReject={() => void run('reject')} />
        </div>
      ) : (
        <DecisionRecord ap={selected} />
      )}
    </div>
  ) : (
    <div className="flex min-h-[320px] flex-col items-center justify-center gap-2 text-center text-[var(--color-muted)]">
      <Inbox size={32} className="text-[var(--color-primary-hover)]" aria-hidden />
      <p className="text-[15px]">{tab === 'history' ? 'No decisions yet.' : 'All clear. Nothing waiting for you.'}</p>
    </div>
  );

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">Approvals</h1>
        <p className="hidden text-sm text-[var(--color-dim)] lg:block">
          <kbd className="rounded border border-[var(--color-line)] px-1">A</kbd> approve · <kbd className="rounded border border-[var(--color-line)] px-1">R</kbd> request changes · <kbd className="rounded border border-[var(--color-line)] px-1">J</kbd>/<kbd className="rounded border border-[var(--color-line)] px-1">K</kbd> next/prev
        </p>
      </div>
      <div className="scroll-thin -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div className="flex w-max gap-1 rounded-xl bg-[var(--color-panel)] p-1" role="tablist" aria-label="Approval types">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => { setTab(t.id); setSelectedId(null); }}
              className={clsx('flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm', tab === t.id ? 'bg-[var(--color-primary)] text-white' : 'text-[var(--color-muted)] hover:text-white')}>
              {t.label}
              {t.id !== 'history' && counts[t.id] > 0 && <span className={clsx('rounded px-1 text-xs', tab === t.id ? 'bg-white/20' : 'bg-[var(--color-panel-2)]')}>{counts[t.id]}</span>}
            </button>
          ))}
        </div>
      </div>
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)] lg:gap-5">
        <section className="card min-w-0 p-2" aria-label="Approval list">
          {list.length === 0 ? (
            <p className="p-6 text-center text-[15px] text-[var(--color-muted)]">{tab === 'history' ? 'No decisions yet.' : 'Nothing here.'}</p>
          ) : (
            <ul className="scroll-thin flex flex-col gap-1 lg:max-h-[calc(100vh-220px)] lg:overflow-y-auto">
              {list.map((ap) => <Row key={ap.id} ap={ap} active={selected?.id === ap.id} onSelect={() => select(ap.id)} />)}
            </ul>
          )}
        </section>
        <section className="card hidden min-w-0 p-5 lg:block" aria-label="Approval detail">{desktop !== false && detail}</section>
      </div>
      {/* Phones / tablets: detail as a sheet */}
      {desktop === false && sheet && selected && (
        <div className="glass fixed inset-0 z-50 flex flex-col border-0" role="dialog" aria-modal aria-label={selected.title}>
          <div className="flex items-center gap-2 border-b border-[var(--color-line)] px-4 py-3">
            <button onClick={() => setSheet(false)} className="flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm text-[var(--color-muted)] hover:text-white"><ArrowLeft size={18} /> Approvals</button>
          </div>
          <div className="scroll-thin flex-1 overflow-y-auto px-4 pt-4">{detail}</div>
        </div>
      )}
    </>
  );
}
