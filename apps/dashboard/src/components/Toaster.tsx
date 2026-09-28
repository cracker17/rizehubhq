'use client';
import { X, CheckCircle2, AlertTriangle, Info } from 'lucide-react';
import { useHq } from '@/lib/data/store';

const TONE = {
  success: { color: 'var(--color-success)', icon: CheckCircle2 },
  error: { color: 'var(--color-danger)', icon: AlertTriangle },
  info: { color: 'var(--color-info)', icon: Info },
} as const;

export function Toaster() {
  const { toasts, dismissToast } = useHq();
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 lg:bottom-6 lg:items-end lg:px-6" aria-live="polite" role="status">
      {toasts.map((t) => {
        const { color, icon: Icon } = TONE[t.tone];
        return (
          <div key={t.id} className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-[14px] border border-[var(--color-line)] bg-[var(--color-panel-2)] px-4 py-3 text-sm shadow-[0_10px_30px_rgba(0,0,0,.45)]"
            style={{ borderLeft: `3px solid ${color}` }}>
            <Icon size={18} style={{ color }} className="mt-0.5 shrink-0" aria-hidden />
            <p className="min-w-0 flex-1 leading-snug">{t.text}</p>
            <button onClick={() => dismissToast(t.id)} aria-label="Dismiss" className="text-[var(--color-muted)] hover:text-white"><X size={16} /></button>
          </div>
        );
      })}
    </div>
  );
}
