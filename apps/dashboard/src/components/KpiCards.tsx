'use client';
import { useHq } from '@/lib/data/store';

function Spark({ points, color }: { points: number[]; color: string }) {
  if (points.length < 2) points = [0, ...points, ...(points.length ? [] : [0])];
  const w = 80, h = 40, max = Math.max(...points), min = Math.min(...points);
  const xy = points.map((p, i) => [(i / (points.length - 1)) * w, h - ((p - min) / (max - min || 1)) * (h - 6) - 3]);
  const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lx, ly] = xy[xy.length - 1];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <path d={`${d} L${w},${h} L0,${h} Z`} fill={color} opacity={0.14} />
      <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lx} cy={ly} r={3} fill={color} />
    </svg>
  );
}

function Bars({ values, color }: { values: number[]; color: string }) {
  const max = Math.max(1, ...values);
  return (
    <div className="flex h-10 items-end gap-1" aria-hidden>
      {values.map((v, i) => (
        <span key={i} className="w-3 rounded-t" style={{ height: `${Math.max(6, (v / max) * 100)}%`, background: color, opacity: 0.35 + (i / values.length) * 0.65 }} />
      ))}
    </div>
  );
}

export function KpiCards() {
  const { kpis } = useHq();
  const cards = [
    { label: 'Active Agents', value: `${kpis.working}/${kpis.totalAgents}`, hint: 'Working now / enabled agents', viz: <Spark points={kpis.activeSpark} color="var(--color-success)" /> },
    { label: 'Pending Approvals', value: String(kpis.pendingApprovals), hint: `Plans ${kpis.pendingByKind[0]} · Deliverables ${kpis.pendingByKind[1]} · Actions ${kpis.pendingByKind[2]}`, viz: <Bars values={kpis.pendingByKind} color="var(--color-primary-hover)" /> },
    { label: 'Tasks Done Today', value: String(kpis.doneToday), hint: 'Tasks approved as done today', viz: <Spark points={kpis.doneSpark} color="var(--color-info)" /> },
    { label: 'QA Pass Rate', value: kpis.qaPassRate === null ? '—' : `${kpis.qaPassRate}%`, hint: 'First-pass and revised reviews, last 7 days', viz: <Bars values={kpis.qaDaily} color="var(--color-teal)" /> },
  ];
  return (
    <section className="grid grid-cols-2 gap-3 xl:grid-cols-4 xl:gap-4" aria-label="Key numbers">
      {cards.map((c) => (
        <div key={c.label} title={c.hint} className="card flex items-end justify-between gap-2 p-4 sm:p-5">
          <div className="min-w-0">
            <p className="text-sm leading-snug text-[var(--color-muted)] sm:text-[15px]">{c.label}</p>
            <p className="mt-1.5 text-3xl font-semibold tabular-nums sm:text-[40px] sm:leading-tight">{c.value}</p>
          </div>
          <div className="hidden shrink-0 sm:block">{c.viz}</div>
        </div>
      ))}
    </section>
  );
}
