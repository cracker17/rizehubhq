import { kpis } from '@/lib/mock';

function Spark({ points, color }: { points: number[]; color: string }) {
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
  const max = Math.max(...values);
  return (
    <div className="flex h-10 items-end gap-1" aria-hidden>
      {values.map((v, i) => (
        <span key={i} className="w-3 rounded-t" style={{ height: `${(v / max) * 100}%`, background: color, opacity: 0.35 + (i / values.length) * 0.65 }} />
      ))}
    </div>
  );
}

export function KpiCards() {
  const cards = [
    { label: 'Active Agents', value: `${kpis.activeAgents}/${kpis.totalAgents}`, viz: <Spark points={[4, 6, 5, 9, 11, 10, 14]} color="var(--color-success)" /> },
    { label: 'Pending Approvals', value: String(kpis.pendingApprovals), viz: <Bars values={[2, 2, 3, 4, 5]} color="var(--color-primary-hover)" /> },
    { label: 'Tasks Done Today', value: String(kpis.tasksDoneToday), viz: <Spark points={[3, 8, 9, 15, 20, 27, 32]} color="var(--color-info)" /> },
    { label: 'QA Pass Rate', value: `${kpis.qaPassRate}%`, viz: <Bars values={[88, 90, 89, 93, 94]} color="var(--color-teal)" /> },
  ];
  return (
    <section className="grid grid-cols-2 gap-3 xl:grid-cols-4 xl:gap-4" aria-label="Key numbers">
      {cards.map((c) => (
        <div key={c.label} className="card flex items-end justify-between gap-2 p-4 sm:p-5">
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
