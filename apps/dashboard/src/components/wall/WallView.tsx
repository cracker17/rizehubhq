'use client';
// /wall: every AI worker's screen at once, like a CCTV wall. Agents come from the live HQ store (agent_screens +
// activity_log over realtime), the Operator from operator_actions. Click a camera for the big view with its recording:
// drag the scrubber back through the steps it took.
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { ExternalLink, MonitorPlay, X } from 'lucide-react';
import { useHq } from '@/lib/data/store';
import { btn } from '@/components/clients/ui';
import { buildWall, replayStep, camClock } from '@/lib/wallView';
import { isOnline, type OperatorHomeData } from '@/lib/operatorView';
import { useOperatorLive } from '@/components/operator/useOperatorLive';
import { ScreenTile } from './ScreenTile';

type Filter = 'all' | 'active';

export function WallView({ operator }: { operator: OperatorHomeData | null }) {
  const { snap, session } = useHq();
  const { actions } = useOperatorLive(operator?.actions ?? [], operator?.demo ?? session.mode === 'demo');
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<string | null>(null);
  const [back, setBack] = useState(0);
  // One clock for every camera, started after mount (no server/client mismatch, one timer instead of one per tile).
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => { setNow(new Date()); const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);

  const tiles = useMemo(() => buildWall({
    snap,
    operator: operator ? { clients: operator.clients, actions, online: isOnline(operator.heartbeatAt) } : null,
  }), [snap, operator, actions]);
  const shown = filter === 'active' ? tiles.filter((t) => t.state === 'working' || t.state === 'waiting' || t.state === 'blocked') : tiles;
  const working = tiles.filter((t) => t.state === 'working').length;
  const focus = tiles.find((t) => t.id === open) ?? null;
  const replay = focus && back > 0 ? replayStep(focus.steps, back - 1) : null;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">Live wall</h1>
          <p className="text-sm text-[var(--color-muted)]">Every AI worker&apos;s screen at once. {working} working now. Click a screen to watch it big and replay what it did.</p>
        </div>
        <div role="tablist" aria-label="Show" className="flex gap-1 rounded-full border border-[var(--color-line)] p-1">
          {(['all', 'active'] as Filter[]).map((f) => (
            <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}
              className={clsx('h-7 rounded-full px-3 text-[13px] transition-colors', filter === f ? 'bg-[color-mix(in_oklab,var(--color-primary)_24%,transparent)] text-[#d6ccff]' : 'text-[var(--color-muted)] hover:text-white')}>
              {f === 'all' ? `All (${tiles.length})` : 'Busy only'}
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0
        ? <p className="card px-6 py-12 text-center text-sm text-[var(--color-muted)]">Nobody is busy right now. Switch to All to see every screen.</p>
        : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {shown.map((t) => <ScreenTile key={t.id} tile={t} now={now} onOpen={() => { setOpen(t.id); setBack(0); }} />)}
          </div>
        )}

      {focus && (
        <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-label={`${focus.name}'s screen`}>
          <button className="glass-scrim absolute inset-0" aria-label="Close" onClick={() => setOpen(null)} />
          <div className="glass relative flex max-h-[100dvh] w-full max-w-5xl flex-col gap-3 overflow-y-auto rounded-t-[20px] p-3 sm:rounded-[20px] sm:p-4" style={{ animation: 'brain-in .2s ease-out' }}>
            <div className="flex items-center gap-2">
              <MonitorPlay size={18} className="text-[#c4b5ff]" aria-hidden />
              <h2 className="min-w-0 flex-1 truncate text-base font-semibold">{focus.name}{focus.project ? ` · ${focus.project}` : ''}</h2>
              {focus.viewerUrl && <a className={btn.small} href={focus.viewerUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} aria-hidden />Real screen</a>}
              <Link className={btn.small} href={focus.href}>Details</Link>
              <button className={btn.small} onClick={() => setOpen(null)} aria-label="Close"><X size={14} aria-hidden /></button>
            </div>
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">
              <ScreenTile tile={focus} now={now} replay={replay} large />
              <div className="flex min-w-0 flex-col gap-2">
                <label className="flex flex-col gap-1 text-[12px] text-[var(--color-muted)]">
                  <span>{back === 0 ? 'Live' : `Replay: ${back} step${back > 1 ? 's' : ''} back`}</span>
                  <input type="range" min={0} max={Math.max(0, focus.steps.length)} value={back} onChange={(e) => setBack(Number(e.target.value))}
                    className="accent-[var(--color-primary)]" aria-label="Recording position (right = live)" style={{ direction: 'rtl' }} disabled={!focus.steps.length} />
                </label>
                <ol className="scroll-thin flex max-h-[360px] flex-col gap-0.5 overflow-y-auto pr-1">
                  {focus.steps.length === 0 && <li className="py-4 text-center text-[13px] text-[var(--color-muted)]">No recorded steps yet.</li>}
                  {focus.steps.map((s, i) => (
                    <li key={`${s.at}-${i}`}>
                      <button onClick={() => setBack(i + 1)} className={clsx('flex w-full gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] hover:bg-[var(--color-panel-2)]', back === i + 1 && 'bg-[color-mix(in_oklab,var(--color-primary)_20%,transparent)]')}>
                        <span className="shrink-0 font-mono text-[11px] text-[var(--color-dim)]">{camClock(new Date(s.at)).slice(0, 5)}</span>
                        <span className="min-w-0">{s.text}</span>
                      </button>
                    </li>
                  ))}
                </ol>
                {back > 0 && <button className={btn.small} onClick={() => setBack(0)}>Back to live</button>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
