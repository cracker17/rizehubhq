'use client';
import { useEffect, useMemo, useRef } from 'react';
import { useHq } from '@/lib/data/store';
import { describeActivity, isToday, timeHM, type Tone } from '@/lib/data/derive';

const TONE: Record<Tone, string> = {
  info: 'var(--color-info)', success: 'var(--color-success)', warning: 'var(--color-warning)',
  primary: 'var(--color-primary-hover)', danger: 'var(--color-danger)',
};

export function ActivityStrip() {
  const { snap, idx } = useHq();
  const items = useMemo(() => {
    const today = snap.activity.filter((a) => isToday(a.created_at));
    const list = (today.length ? today : snap.activity.slice(0, 8)).slice(0, 24);
    return [...list].sort((a, b) => a.created_at.localeCompare(b.created_at)).map((a) => ({ a, ...describeActivity(a, snap, idx) }));
  }, [snap, idx]);
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => { ref.current?.scrollTo({ left: ref.current.scrollWidth }); }, [items.length]);

  return (
    <section className="card p-4 sm:p-5" aria-labelledby="act-title">
      <h2 id="act-title" className="mb-4 text-lg font-semibold">Today&apos;s Activity</h2>
      {items.length === 0 ? (
        <p className="item p-4 text-sm text-[var(--color-muted)]">Quiet so far. New requests, plans and QA results show up here live.</p>
      ) : (
        <ol ref={ref} className="scroll-thin flex gap-3 overflow-x-auto pb-1">
          {items.map(({ a, text, tone }) => (
            <li key={a.id} className="item flex min-w-[220px] max-w-[280px] items-start gap-3 p-3.5">
              <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: TONE[tone] }} aria-hidden />
              <div className="min-w-0">
                <p className="text-xs text-[var(--color-muted)] tabular-nums"><time dateTime={a.created_at} suppressHydrationWarning>{timeHM(a.created_at)}</time></p>
                <p className="text-sm leading-snug">{text}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
