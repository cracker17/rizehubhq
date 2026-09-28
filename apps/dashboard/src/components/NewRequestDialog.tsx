'use client';
import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export function NewRequestDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [text, setText] = useState('');
  const [sent, setSent] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (open) { setSent(false); setTimeout(() => ref.current?.focus(), 50); } }, [open]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center" onClick={onClose}>
      <div role="dialog" aria-modal aria-labelledby="nr-title" className="card w-full max-w-xl p-6" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 id="nr-title" className="text-lg font-semibold">New request</h2>
          <button onClick={onClose} aria-label="Close" className="text-[var(--color-muted)] hover:text-white"><X size={20} /></button>
        </div>
        {sent ? (
          <p className="rounded-xl bg-[var(--color-panel-2)] p-4 text-[15px]">Staged. The COO is planning it and will send the plan to your Approvals. <span className="text-[var(--color-muted)]">(Demo: connects to the real queue in M4.)</span></p>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) setSent(true); }}>
            <textarea
              ref={ref}
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              placeholder="Tell the team what you need… e.g. Madam Muse needs a bundle landing page with SEO copy and 3 ad graphics, due Friday"
              className="w-full resize-none rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-2)] p-4 text-[15px] outline-none placeholder:text-[var(--color-dim)] focus:border-[var(--color-line-active)]"
            />
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <select className="h-10 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-2)] px-3 text-sm" defaultValue="normal" aria-label="Priority">
                <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option>
              </select>
              <input type="date" className="h-10 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-2)] px-3 text-sm [color-scheme:dark]" aria-label="Due date" />
              <button type="submit" disabled={!text.trim()} className="ml-auto h-10 rounded-xl bg-[var(--color-primary)] px-5 text-sm font-medium disabled:opacity-40">Send to COO</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
