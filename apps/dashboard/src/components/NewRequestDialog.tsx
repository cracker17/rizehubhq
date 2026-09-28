'use client';
import { X } from 'lucide-react';
import { useEffect } from 'react';
import { NewRequestForm } from './NewRequestForm';

export function NewRequestDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="glass-scrim fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center" onClick={onClose}>
      <div role="dialog" aria-modal aria-labelledby="nr-title" className="glass w-full max-w-xl rounded-[20px] p-5 sm:p-6" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 id="nr-title" className="text-lg font-semibold">New request</h2>
          <button onClick={onClose} aria-label="Close" className="text-[var(--color-muted)] hover:text-white"><X size={20} /></button>
        </div>
        <NewRequestForm autoFocus onDone={onClose} />
        <p className="mt-3 text-xs text-[var(--color-dim)]">It&apos;s staged right away; the COO plans it and the plan lands in your Approvals.</p>
      </div>
    </div>
  );
}
