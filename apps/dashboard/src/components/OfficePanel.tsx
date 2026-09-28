'use client';
import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { LayoutGrid, Box } from 'lucide-react';
import { useHq } from '@/lib/data/store';
import { toTileAgent } from '@/lib/data/derive';
import { AgentTile } from './AgentTile';
import { AgentPanel } from './AgentPanel';

const DEPTS: { id: string; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'leadership', label: 'Leadership' }, { id: 'ops', label: 'Ops' },
  { id: 'growth', label: 'Growth' }, { id: 'dev', label: 'Dev' }, { id: 'design', label: 'Design' },
  { id: 'content', label: 'Content' }, { id: 'multimedia', label: 'Multimedia' }, { id: 'qa', label: 'QA' },
];

export function OfficePanel() {
  const [view, setView] = useState<'grid' | 'map'>('grid');
  const [dept, setDept] = useState<string>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const { snap, idx } = useHq();
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

  return (
    <section className="card flex min-w-0 flex-col p-4 sm:p-5" aria-labelledby="office-title">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 id="office-title" className="text-lg font-semibold">Office Floor</h2>
        <p className="text-sm text-[var(--color-muted)]">
          <span className="text-[var(--color-success)]">{counts.working} working</span> · <span className="text-[var(--color-warning)]">{counts.idle} on break</span> · <span className="text-[var(--color-danger)]">{counts.needs} need you</span>
        </p>
        <div className="ml-auto flex rounded-xl bg-[var(--color-panel-2)] p-1" role="tablist" aria-label="Office view">
          {([['grid', 'Grid', LayoutGrid], ['map', 'Office map', Box]] as const).map(([id, label, Icon]) => (
            <button key={id} role="tab" aria-selected={view === id} onClick={() => setView(id)}
              className={clsx('flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm', view === id ? 'bg-[var(--color-primary)] text-white' : 'text-[var(--color-muted)]')}>
              <Icon size={15} /> {label}
            </button>
          ))}
        </div>
      </div>

      {view === 'grid' ? (
        <>
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
        </>
      ) : (
        <div className="item flex min-h-[420px] flex-col items-center justify-center gap-3 p-8 text-center">
          <Box size={36} className="text-[var(--color-primary-hover)]" />
          <p className="text-lg font-medium">Isometric office map</p>
          <p className="max-w-md text-[15px] text-[var(--color-muted)]">The 2.5D office from the chosen concept: agents at their desks when working, in the coffee lounge, game room or lobby when idle, and in the Boardroom when planning. Built in milestone M8 (docs/07).</p>
        </div>
      )}
      <AgentPanel key={open?.id} agent={open} onClose={() => setOpenId(null)} />
    </section>
  );
}
