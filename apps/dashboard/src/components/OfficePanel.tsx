'use client';
import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import clsx from 'clsx';
import { LayoutGrid, Box } from 'lucide-react';
import { toTileAgent } from '@/lib/data/derive';
import { AgentTile } from './AgentTile';
import { AgentPanel } from './AgentPanel';
import { useOfficeSnapshot } from './office/useOfficeSnapshot';
import { MapSkeleton } from './office/MapSkeleton';

// Phaser only runs in the browser: the map (and the engine it imports) is split out and loaded lazily.
const OfficeMap = dynamic(() => import('./office/OfficeMap'), { ssr: false, loading: () => <MapSkeleton /> });

const DEPTS: { id: string; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'leadership', label: 'Leadership' }, { id: 'ops', label: 'Ops' },
  { id: 'growth', label: 'Growth' }, { id: 'dev', label: 'Dev' }, { id: 'design', label: 'Design' },
  { id: 'content', label: 'Content' }, { id: 'multimedia', label: 'Multimedia' }, { id: 'qa', label: 'QA' },
];
const VIEW_KEY = 'hq-office-view';

type View = 'auto' | 'grid' | 'map';

export function OfficePanel() {
  // 'auto' = map on ≥1024px, grid on phones (docs/06). An explicit choice is remembered per device.
  const [view, setView] = useState<View>('auto');
  const [desktop, setDesktop] = useState<boolean | null>(null);
  const [dept, setDept] = useState<string>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const { snap, idx } = useOfficeSnapshot();

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const sync = () => setDesktop(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    try {
      const saved = window.localStorage.getItem(VIEW_KEY);
      if (saved === 'grid' || saved === 'map') setView(saved);
    } catch { /* storage unavailable */ }
    return () => mq.removeEventListener('change', sync);
  }, []);
  const choose = (v: 'grid' | 'map') => {
    setView(v);
    try { window.localStorage.setItem(VIEW_KEY, v); } catch { /* ignore */ }
  };
  const effective: 'grid' | 'map' = view === 'auto' ? (desktop ? 'map' : 'grid') : view;

  const agents = useMemo(() => snap.agents.map((a) => toTileAgent(a, snap, idx)), [snap, idx]);
  const depts = useMemo(() => {
    const present = new Set(agents.map((a) => a.department));
    const known = DEPTS.filter((d) => d.id === 'all' || present.has(d.id));
    const extra = [...present].filter((p) => !DEPTS.some((d) => d.id === p)).map((p) => ({ id: p, label: p[0].toUpperCase() + p.slice(1) }));
    return [...known, ...extra];
  }, [agents]);
  const list = useMemo(() => (dept === 'all' ? agents : agents.filter((a) => a.department === dept)), [dept, agents]);
  const counts = useMemo(() => ({
    working: agents.filter((a) => a.status === 'working').length,
    idle: agents.filter((a) => a.status === 'idle').length,
    needs: agents.filter((a) => a.status === 'waiting' || a.status === 'blocked').length,
  }), [agents]);
  const open = openId ? agents.find((a) => a.id === openId) ?? null : null;

  // Before hydration knows the screen size, CSS picks the view so nothing jumps.
  const gridClass = view === 'auto' && desktop === null ? 'lg:hidden' : effective === 'grid' ? '' : 'hidden';
  const mapClass = view === 'auto' && desktop === null ? 'hidden lg:block' : effective === 'map' ? '' : 'hidden';

  return (
    <section className="card flex min-w-0 flex-col p-4 sm:p-5" aria-labelledby="office-title">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 id="office-title" className="text-lg font-semibold">Office Floor</h2>
        <p className="text-sm text-[var(--color-muted)]">
          <span className="text-[var(--color-success)]">{counts.working} working</span> · <span className="text-[var(--color-warning)]">{counts.idle} on break</span> · <span className="text-[var(--color-danger)]">{counts.needs} need you</span>
        </p>
        <div className="ml-auto flex rounded-xl bg-[var(--color-panel-2)] p-1" role="tablist" aria-label="Office view">
          {([['grid', 'Grid', LayoutGrid], ['map', 'Office map', Box]] as const).map(([id, label, Icon]) => (
            <button key={id} role="tab" aria-selected={effective === id} onClick={() => choose(id)}
              className={clsx('flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm', effective === id ? 'bg-[var(--color-primary)] text-white' : 'text-[var(--color-muted)]')}>
              <Icon size={15} /> {label}
            </button>
          ))}
        </div>
      </div>

      <div className={gridClass}>
        <div className="scroll-thin -mx-1 mb-4 flex gap-2 overflow-x-auto px-1 pb-1">
          {depts.map((d) => (
            <button key={d.id} onClick={() => setDept(d.id)} aria-pressed={dept === d.id}
              className={clsx('shrink-0 rounded-full border px-3 py-1 text-[13px]', dept === d.id ? 'border-[var(--color-line-active)] bg-[var(--color-panel-2)] text-white' : 'border-[var(--color-line)] text-[var(--color-muted)]')}>
              {d.label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-3">
          {list.map((a) => <AgentTile key={a.id} agent={a} onOpen={(x) => setOpenId(x.id)} />)}
          {list.length === 0 && <p className="item col-span-full p-6 text-center text-[15px] text-[var(--color-muted)]">No agents here yet. Run the seed (supabase/seed.sql) to add the team.</p>}
        </div>
      </div>

      <div className={clsx('item h-[clamp(360px,56vh,600px)] overflow-hidden', mapClass)}>
        {effective === 'map' && desktop !== null && <OfficeMap snap={snap} variant="panel" onOpen={setOpenId} />}
        {(effective !== 'map' || desktop === null) && <MapSkeleton />}
      </div>
      <AgentPanel key={open?.id} agent={open} onClose={() => setOpenId(null)} />
    </section>
  );
}
