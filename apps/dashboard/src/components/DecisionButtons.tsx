'use client';
import { Check, MessageSquareWarning, X } from 'lucide-react';
import clsx from 'clsx';

export const btn = {
  approve: 'flex h-10 items-center justify-center gap-1.5 rounded-[10px] bg-[var(--color-success)] px-4 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50',
  changes: 'flex h-10 items-center justify-center gap-1.5 rounded-[10px] border border-[var(--color-line)] px-3 text-sm text-[var(--color-ink)] hover:border-[var(--color-line-active)] disabled:opacity-50',
  reject: 'flex h-10 items-center justify-center gap-1.5 rounded-[10px] border border-[color-mix(in_oklab,var(--color-danger)_50%,transparent)] px-3 text-sm text-[#ff8a8d] hover:bg-[color-mix(in_oklab,var(--color-danger)_12%,transparent)] disabled:opacity-50',
};

/** Approve / Request changes / Reject. Shortcut hints are shown when `keys` is set (Approvals page). */
export function DecisionButtons({ onApprove, onChanges, onReject, disabled, keys, compact, changesLabel = 'Request changes', approveLabel = 'Approve' }: {
  onApprove: () => void; onChanges: () => void; onReject: () => void; disabled?: boolean; keys?: boolean; compact?: boolean;
  changesLabel?: string; approveLabel?: string;
}) {
  const kbd = (k: string) => keys ? <kbd className="ml-1 hidden rounded border border-white/25 px-1 text-[10px] font-normal opacity-80 sm:inline">{k}</kbd> : null;
  return (
    <div className={clsx('flex gap-2', compact && 'h-9')}>
      <button onClick={onApprove} disabled={disabled} className={clsx(btn.approve, 'flex-1', compact && 'h-9')}>
        <Check size={16} aria-hidden /> {approveLabel}{kbd('A')}
      </button>
      <button onClick={onChanges} disabled={disabled} className={clsx(btn.changes, compact && 'h-9')} aria-label={changesLabel}>
        <MessageSquareWarning size={15} aria-hidden /> {compact ? <span>Changes</span> : <><span className="sm:hidden">Changes</span><span className="hidden sm:inline">{changesLabel}</span></>}{kbd('R')}
      </button>
      <button onClick={onReject} disabled={disabled} className={clsx(btn.reject, compact && 'h-9')} aria-label="Reject">
        <X size={15} aria-hidden /> <span>Reject</span>
      </button>
    </div>
  );
}
