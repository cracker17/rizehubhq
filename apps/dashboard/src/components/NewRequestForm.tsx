'use client';
import { useEffect, useRef, useState } from 'react';
import { useHq } from '@/lib/data/store';
import type { Priority } from '@/lib/data/types';

const field = 'h-10 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-2)] px-3 text-sm outline-none focus:border-[var(--color-line-active)]';

/** Big textarea + client / priority / due date. Submits through create_request (source 'dashboard'). */
export function NewRequestForm({ autoFocus, onDone, rows = 5 }: { autoFocus?: boolean; onDone?: () => void; rows?: number }) {
  const { createRequest, snap } = useHq();
  const [text, setText] = useState('');
  const [priority, setPriority] = useState<Priority>('normal');
  const [due, setDue] = useState('');
  const [client, setClient] = useState('');
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (autoFocus) setTimeout(() => ref.current?.focus(), 50); }, [autoFocus]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || sending) return;
    setSending(true);
    const ok = await createRequest({ text, priority, dueDate: due || null, clientSlug: client || null });
    setSending(false);
    if (ok) { setText(''); setDue(''); setPriority('normal'); setClient(''); onDone?.(); }
  };

  return (
    <form onSubmit={submit}>
      <label htmlFor="nr-text" className="sr-only">What do you need?</label>
      <textarea
        id="nr-text"
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit(e); }}
        rows={rows}
        placeholder="Tell the team what you need… e.g. Madam Muse needs a bundle landing page with SEO copy and 3 ad graphics, due Friday"
        className="w-full resize-none rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-2)] p-4 text-[15px] outline-none placeholder:text-[var(--color-dim)] focus:border-[var(--color-line-active)]"
      />
      <div className="mt-3 grid grid-cols-2 gap-3 sm:flex sm:flex-wrap sm:items-center">
        <select value={client} onChange={(e) => setClient(e.target.value)} className={`${field} col-span-2 sm:col-auto sm:max-w-[200px]`} aria-label="Client (optional)">
          <option value="">No client</option>
          {snap.clients.map((c) => <option key={c.id} value={c.slug}>{c.name}</option>)}
        </select>
        <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)} className={field} aria-label="Priority">
          <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option>
        </select>
        <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={`${field} min-w-0 [color-scheme:dark]`} aria-label="Due date (optional)" />
        <button type="submit" disabled={!text.trim() || sending}
          className="col-span-2 h-10 rounded-xl bg-[var(--color-primary)] px-5 text-sm font-medium hover:bg-[var(--color-primary-hover)] disabled:opacity-40 sm:col-auto sm:ml-auto">
          {sending ? 'Sending…' : 'Send to COO'}
        </button>
      </div>
    </form>
  );
}
