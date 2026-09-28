'use client';
// "Find leads" / "Find jobs": a New Request prefilled from a few fields. The text stays editable; it is sent through the
// same createRequest (create_request RPC, source 'dashboard') as the top-bar New Request, so the COO plans it.
import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useHq } from '@/lib/data/store';

export interface PrefillField {
  id: string;
  label: string;
  kind: 'select' | 'text' | 'number';
  options?: { value: string; label: string }[];
  placeholder?: string;
  min?: number;
  max?: number;
  initial: string;
}

const field = 'h-10 w-full min-w-0 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-2)] px-3 text-sm outline-none focus:border-[var(--color-line-active)]';

export function PrefillRequestDialog({ open, onClose, title, intro, fields, build, submitLabel = 'Send to COO' }: {
  open: boolean; onClose: () => void; title: string; intro: string; fields: PrefillField[];
  build: (values: Record<string, string>) => string; submitLabel?: string;
}) {
  const { createRequest } = useHq();
  const initial = useMemo(() => Object.fromEntries(fields.map((f) => [f.id, f.initial])), [fields]);
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [text, setText] = useState(() => build(initial));
  const [edited, setEdited] = useState(false);
  const [sending, setSending] = useState(false);
  const first = useRef<HTMLSelectElement | HTMLInputElement | null>(null);

  // Reset only when the dialog opens (callers may pass inline callbacks).
  const latest = useRef({ initial, build, onClose });
  latest.current = { initial, build, onClose };
  useEffect(() => {
    if (!open) return;
    const l = latest.current;
    setValues(l.initial); setText(l.build(l.initial)); setEdited(false);
    setTimeout(() => first.current?.focus(), 50);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') latest.current.onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;
  const set = (id: string, v: string) => {
    const next = { ...values, [id]: v };
    setValues(next);
    if (!edited) setText(build(next));
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || sending) return;
    setSending(true);
    const ok = await createRequest({ text: text.trim(), priority: 'normal', dueDate: null, clientSlug: null });
    setSending(false);
    if (ok) onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-3 sm:items-center sm:p-4" onClick={onClose}>
      <div role="dialog" aria-modal aria-labelledby="prefill-title" className="card max-h-[92vh] w-full max-w-xl overflow-y-auto p-5 sm:p-6" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center justify-between gap-3">
          <h2 id="prefill-title" className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="text-[var(--color-muted)] hover:text-white"><X size={20} /></button>
        </div>
        <p className="mb-4 text-[13px] text-[var(--color-muted)]">{intro}</p>
        <form onSubmit={submit}>
          <div className="grid grid-cols-2 gap-3">
            {fields.map((f, i) => (
              <label key={f.id} className={f.kind === 'text' ? 'col-span-2 flex flex-col gap-1.5' : 'flex flex-col gap-1.5'}>
                <span className="text-xs text-[var(--color-muted)]">{f.label}</span>
                {f.kind === 'select' ? (
                  <select ref={i === 0 ? (el) => { first.current = el; } : undefined} value={values[f.id]} onChange={(e) => set(f.id, e.target.value)} className={field}>
                    {f.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : (
                  <input ref={i === 0 ? (el) => { first.current = el; } : undefined} type={f.kind} inputMode={f.kind === 'number' ? 'numeric' : undefined}
                    min={f.min} max={f.max} value={values[f.id]} placeholder={f.placeholder} onChange={(e) => set(f.id, e.target.value)} className={field} />
                )}
              </label>
            ))}
          </div>
          <label className="mt-4 flex flex-col gap-1.5">
            <span className="flex items-center justify-between text-xs text-[var(--color-muted)]">
              Request to the COO
              {edited && <button type="button" onClick={() => { setText(build(values)); setEdited(false); }} className="text-[var(--color-primary-hover)] hover:underline">Reset from fields</button>}
            </span>
            <textarea value={text} rows={4} onChange={(e) => { setText(e.target.value); setEdited(true); }}
              className="w-full resize-none rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-2)] p-3.5 text-[15px] outline-none focus:border-[var(--color-line-active)]" />
          </label>
          <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-[var(--color-dim)]">The COO plans it; the plan lands in your Approvals.</p>
            <button type="submit" disabled={!text.trim() || sending}
              className="h-10 rounded-xl bg-[var(--color-primary)] px-5 text-sm font-medium hover:bg-[var(--color-primary-hover)] disabled:opacity-40">
              {sending ? 'Sending…' : submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
