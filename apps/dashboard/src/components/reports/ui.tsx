'use client';
// Small building blocks shared by the report cards.
import clsx from 'clsx';
import { useHq } from '@/lib/data/store';
import type { DigestLine } from '@/lib/data/reports';
import { Avatar, portraitUrl } from '../Avatar';

export const usd = (n: number | string | null | undefined) => `$${(Number(n) || 0).toFixed(2)}`;

export function prettyDate(date: string, opts: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric' }) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });
}

export function manilaTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' });
}

export function deptLabel(d: string) {
  return d === 'qa' ? 'QA' : d.replace(/^./, (c) => c.toUpperCase());
}

export function useAgent(id: string | null | undefined) {
  const { idx } = useHq();
  const a = id ? idx.agentById.get(id) : undefined;
  return { id: a?.id ?? id ?? null, name: a?.name ?? id ?? 'Team', color: a?.avatar?.color ?? '#6D4AFF', department: a?.department ?? '' };
}

export function AgentChip({ id, size = 20 }: { id: string | null; size?: number }) {
  const a = useAgent(id);
  if (!id) return null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-[13px] text-[var(--color-muted)]">
      {size >= 32 || portraitUrl(a.id) ? <Avatar id={a.id} name={a.name} color={a.color} size={size} /> : (
        <span aria-hidden className="flex shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
          style={{ width: size, height: size, background: `radial-gradient(circle at 30% 25%, ${a.color}, color-mix(in oklab, ${a.color} 55%, #0b0a1f))` }}>
          {a.name.replace(/[^A-Za-z0-9 ]/g, ' ').trim()[0]?.toUpperCase()}
        </span>
      )}
      <span className="truncate">{a.name}</span>
    </span>
  );
}

export function Stat({ label, value, tone, hint }: { label: string; value: string; tone?: string; hint?: string }) {
  return (
    <div className="item min-w-0 px-3.5 py-3" title={hint}>
      <p className="truncate text-[13px] text-[var(--color-muted)]">{label}</p>
      <p className="mt-0.5 text-2xl font-semibold tabular-nums sm:text-[28px] sm:leading-tight" style={tone ? { color: tone } : undefined}>{value}</p>
    </div>
  );
}

export function LineList({ title, icon, lines, empty, tone, max = 8 }: {
  title: string; icon: React.ReactNode; lines: DigestLine[]; empty: string; tone?: string; max?: number;
}) {
  return (
    <section className="item min-w-0 p-4" aria-label={title}>
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold" style={tone ? { color: tone } : undefined}>
        {icon}{title}<span className="rounded-md bg-[var(--color-panel)] px-1.5 text-xs font-medium text-[var(--color-muted)]">{lines.length}</span>
      </h3>
      {lines.length === 0 ? <p className="text-sm text-[var(--color-dim)]">{empty}</p> : (
        <ul className="flex flex-col gap-3">
          {lines.slice(0, max).map((l, i) => (
            <li key={`${l.title}-${i}`} className="min-w-0">
              <p className="text-[14px] leading-snug">{l.title}</p>
              <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <AgentChip id={l.agent_id} size={18} />
                {l.client && <span className="rounded-md bg-[var(--color-panel)] px-1.5 py-0.5 text-xs text-[var(--color-muted)]">{l.client}</span>}
                {l.note && <span className={clsx('text-xs', tone ? '' : 'text-[var(--color-dim)]')} style={tone ? { color: `color-mix(in oklab, ${tone} 75%, white)` } : undefined}>{l.note}</span>}
              </div>
            </li>
          ))}
          {lines.length > max && <li className="text-xs text-[var(--color-dim)]">…and {lines.length - max} more</li>}
        </ul>
      )}
    </section>
  );
}

/** Horizontal bars (no chart library). */
export function HBars({ rows, color, format = (n) => String(n) }: { rows: { label: string; value: number }[]; color: string; format?: (n: number) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <p className="text-sm text-[var(--color-dim)]">No data this week.</p>;
  return (
    <ul className="flex flex-col gap-2.5">
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)_auto] items-center gap-3 text-sm">
          <span className="truncate capitalize text-[var(--color-muted)]">{r.label}</span>
          <span className="h-2.5 overflow-hidden rounded-full bg-[var(--color-line)]" aria-hidden>
            <span className="block h-full rounded-full" style={{ width: `${Math.max(4, (r.value / max) * 100)}%`, background: color }} />
          </span>
          <span className="tabular-nums">{format(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}
