import { activity } from '@/lib/mock';

const TONE = { info: 'var(--color-info)', success: 'var(--color-success)', warning: 'var(--color-warning)', primary: 'var(--color-primary-hover)' } as const;

export function ActivityStrip() {
  return (
    <section className="card p-4 sm:p-5" aria-labelledby="act-title">
      <h2 id="act-title" className="mb-4 text-lg font-semibold">Today&apos;s Activity</h2>
      <ol className="scroll-thin flex gap-3 overflow-x-auto pb-1">
        {activity.map((a) => (
          <li key={a.id} className="item flex min-w-[220px] items-start gap-3 p-3.5">
            <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: TONE[a.tone] }} />
            <div>
              <p className="text-xs text-[var(--color-muted)] tabular-nums">{a.time}</p>
              <p className="text-sm leading-snug">{a.text}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
