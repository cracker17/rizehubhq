'use client';
// Isometric office map (docs/07): Phaser canvas + crisp React overlays (name tags, room signs, toolbar).
// Loaded only on the client (next/dynamic with ssr: false); Phaser itself is imported lazily below.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { AlertTriangle, Hand, Hourglass, Maximize2, Minus, Moon, Plus, Scan, Sun } from 'lucide-react';
import type { HqSnapshot } from '@/lib/data/types';
import { deriveOffice, diffEvents, type AgentView, type OfficeModel } from './logic/director';
import { OFFICE } from './logic/map';
import type { OfficeController } from './engine/game';
import type { FrameInfo } from './engine/OfficeScene';

const DOT: Record<string, string> = {
  working: '#1f9d6b', idle: '#f5a524', waiting: '#7c5cff', blocked: '#e5484d', offline: '#6e6a9e',
};
const ROOM_LABEL: Record<string, string> = Object.fromEntries(OFFICE.rooms.map((r) => [r.id, r.name]));
const COMPACT_BELOW = 0.45;

export function manilaNight(d = new Date()) {
  const h = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Manila' }).format(d));
  return h >= 19 || h < 6;
}

export interface OfficeMapProps {
  snap: HqSnapshot;
  variant: 'panel' | 'full';
  onOpen: (agentId: string) => void;
}

export default function OfficeMap({ snap, variant, onOpen }: OfficeMapProps) {
  const host = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<OfficeController | null>(null);
  const [ctrl, setCtrl] = useState<OfficeController | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [model, setModel] = useState<OfficeModel | null>(null);
  const [compact, setCompact] = useState(variant === 'panel');
  const [followId, setFollowId] = useState<string>('');
  const [night, setNight] = useState<boolean>(() => manilaNight());
  const [nightManual, setNightManual] = useState(false);
  const [near, setNear] = useState<string | null>(null);
  const [avatar, setAvatar] = useState(false);
  const tagEls = useRef(new Map<string, HTMLElement>());
  const roomEls = useRef(new Map<string, HTMLElement>());
  const ceoEl = useRef<HTMLDivElement>(null);
  const meetingEl = useRef<HTMLDivElement>(null);
  const widths = useRef(new Map<string, number>());
  const compactRef = useRef(compact);
  const nearRef = useRef<string | null>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  // ---- model from data (+ a slow clock so the COO alternates whiteboard / desk)
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 10_000); return () => clearInterval(t); }, []);
  const spotsRef = useRef<Map<string, string> | undefined>(undefined);
  const prevSnap = useRef<HqSnapshot | null>(null);
  useEffect(() => {
    const m = deriveOffice(snap, { nowMs: now, prevSpots: spotsRef.current });
    spotsRef.current = m.spots;
    const events = prevSnap.current && prevSnap.current !== snap ? diffEvents(prevSnap.current, snap) : [];
    prevSnap.current = snap;
    setModel(m);
    ctrlRef.current?.setModel(m, events);
  }, [snap, now]);

  // ---- frame → overlay positions (imperative, no React re-render per frame)
  const onFrame = useCallback((f: FrameInfo) => {
    const isCompact = f.zoom < COMPACT_BELOW;
    if (isCompact !== compactRef.current) { compactRef.current = isCompact; setCompact(isCompact); }
    if (f.near !== nearRef.current) { nearRef.current = f.near; setNear(f.near); }
    // Declutter: place tags bottom-up and nudge overlapping ones upwards.
    const placed: { x0: number; x1: number; y: number }[] = [];
    const H = isCompact ? 19 : 22;
    const order = [...f.tags].filter((t) => t.visible).sort((a, b) => b.y - a.y);
    const finalY = new Map<string, number>();
    for (const t of order) {
      const w = widths.current.get(t.id) ?? 80;
      let y = t.y;
      for (let i = 0; i < 6; i++) {
        const hit = placed.find((p) => t.x - w / 2 < p.x1 && t.x + w / 2 > p.x0 && Math.abs(p.y - y) < H);
        if (!hit) break;
        y = hit.y - H;
      }
      placed.push({ x0: t.x - w / 2, x1: t.x + w / 2, y });
      finalY.set(t.id, y);
    }
    for (const t of f.tags) {
      const el = tagEls.current.get(t.id);
      if (!el) continue;
      const y = finalY.get(t.id);
      if (!t.visible || y === undefined) { el.style.visibility = 'hidden'; continue; }
      el.style.visibility = 'visible';
      el.style.transform = `translate(${t.x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
    }
    if (ceoEl.current && f.ceo) {
      ceoEl.current.style.visibility = f.ceo.visible ? 'visible' : 'hidden';
      ceoEl.current.style.transform = `translate(${f.ceo.x.toFixed(1)}px, ${f.ceo.y.toFixed(1)}px) translate(-50%, -100%)`;
    }
    for (const r of f.rooms) {
      const el = roomEls.current.get(r.id);
      if (!el) continue;
      el.style.visibility = r.visible ? 'visible' : 'hidden';
      el.style.transform = `translate(${r.x.toFixed(1)}px, ${r.y.toFixed(1)}px) translate(-50%, -50%)`;
      // Signs step back (fade) when a name tag sits on top of them.
      const sw = (ROOM_LABEL[r.id]?.length ?? 8) * (isCompact ? 6.2 : 7.4) + 16;
      const sh = isCompact ? 14 : 18;
      const covered = placed.some((p) => r.x - sw / 2 < p.x1 && r.x + sw / 2 > p.x0 && p.y > r.y - sh / 2 && p.y - H < r.y + sh / 2);
      el.style.opacity = covered ? '0.3' : '1';
    }
    if (meetingEl.current) {
      meetingEl.current.style.visibility = f.meeting.visible ? 'visible' : 'hidden';
      meetingEl.current.style.transform = `translate(${f.meeting.x.toFixed(1)}px, ${f.meeting.y.toFixed(1)}px) translate(-50%, -100%)`;
    }
  }, []);

  // ---- boot Phaser
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    const desktop = window.matchMedia('(pointer: fine)').matches && window.innerWidth >= 768;
    setAvatar(desktop);
    import('./engine/game')
      .then(({ createOfficeGame }) => {
        if (disposed) return;
        const c = createOfficeGame(el, {
          avatar: desktop,
          wheel: variant === 'full' ? 'always' : 'modifier',
          onSelect: (id) => onOpenRef.current(id),
          onFrame,
          onReady: () => setReady(true),
          onUserCamera: () => setFollowId(''),
        });
        ctrlRef.current = c;
        setCtrl(c);
      })
      .catch((e: unknown) => setFailed(e instanceof Error ? e.message : 'Could not load the office map'));
    return () => { disposed = true; ctrlRef.current?.destroy(); ctrlRef.current = null; setCtrl(null); };
  }, [variant, onFrame]);

  // push current state to a freshly created controller
  useEffect(() => {
    if (!ctrl) return;
    if (model) ctrl.setModel(model, []);
    ctrl.setNight(night);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctrl]);
  useEffect(() => { ctrl?.setNight(night); }, [ctrl, night]);
  useEffect(() => {
    if (nightManual) return;
    const t = setInterval(() => setNight(manilaNight()), 60_000);
    return () => clearInterval(t);
  }, [nightManual]);

  // measure tag widths for decluttering
  useLayoutEffect(() => {
    for (const [id, el] of tagEls.current) widths.current.set(id, el.offsetWidth + 4);
  }, [model, compact]);

  const agents = useMemo(() => (model?.agents ?? []).filter((a) => a.goal), [model]);
  const meeting = model?.meeting ?? null;
  const nearAgent = near ? agents.find((a) => a.id === near) : null;

  const setTag = (id: string) => (el: HTMLElement | null) => { if (el) tagEls.current.set(id, el); else tagEls.current.delete(id); };
  const setRoom = (id: string) => (el: HTMLElement | null) => { if (el) roomEls.current.set(id, el); else roomEls.current.delete(id); };

  return (
    <div className="relative h-full w-full select-none overflow-hidden bg-[#0e0d26]">
      <div ref={host} className="absolute inset-0 touch-none" role="application" aria-label="Isometric office map. Use the name tags to open an agent." />

      {/* overlays */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {OFFICE.rooms.map((r) => (
          <div key={r.id} ref={setRoom(r.id)} className="absolute left-0 top-0 transition-opacity duration-300" style={{ visibility: 'hidden' }}>
            <span className={clsx('block whitespace-nowrap rounded-md bg-[#fbf8f2]/85 font-semibold uppercase tracking-[0.08em] text-[#2b2750] shadow-[0_2px_6px_rgba(0,0,0,.25)]',
              compact ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-0.5 text-[10.5px]')}>
              {ROOM_LABEL[r.id]}
            </span>
          </div>
        ))}
        <div ref={meetingEl} className="absolute left-0 top-0" style={{ visibility: 'hidden' }}>
          {meeting && (
            <span className="flex max-w-[16rem] items-center gap-1.5 truncate whitespace-nowrap rounded-full bg-[var(--color-primary)] px-2.5 py-1 text-[11px] font-semibold text-white shadow-lg sm:max-w-[22rem]">
              <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-white" /> <span className="truncate">{meeting.label}</span>
            </span>
          )}
        </div>

        {agents.map((a) => <NameTag key={a.id} a={a} compact={compact} refFn={setTag(a.id)} onOpen={onOpen} />)}

        <div ref={ceoEl} className="absolute left-0 top-0" style={{ visibility: 'hidden' }}>
          <span className={clsx('flex items-center gap-1 whitespace-nowrap rounded-full bg-[var(--color-primary)] font-semibold text-white shadow-lg ring-1 ring-white/20',
            compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-[11.5px]')}>
            Julev <span className="font-normal opacity-80">(you)</span>
          </span>
        </div>
      </div>

      {/* toolbar */}
      <div className="absolute right-2 top-2 flex items-center gap-1 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)]/90 p-1 shadow-lg backdrop-blur sm:right-3 sm:top-3">
        <ToolButton label="Zoom in" onClick={() => ctrl?.zoomBy(1.25)}><Plus size={16} /></ToolButton>
        <ToolButton label="Zoom out" onClick={() => ctrl?.zoomBy(0.8)}><Minus size={16} /></ToolButton>
        <ToolButton label="Reset view" onClick={() => { setFollowId(''); ctrl?.resetView(); }}><Scan size={16} /></ToolButton>
        <label className="sr-only" htmlFor={`follow-${variant}`}>Follow agent</label>
        <select id={`follow-${variant}`} value={followId}
          onChange={(e) => { setFollowId(e.target.value); ctrl?.follow(e.target.value || null); }}
          className="h-8 max-w-[7.5rem] rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-2)] px-1.5 text-[12px] text-[var(--color-ink)] outline-none sm:max-w-[10rem]">
          <option value="">Follow…</option>
          <option value="ceo">You (CEO)</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <ToolButton label={night ? 'Switch to day' : 'Switch to night'} onClick={() => { setNightManual(true); setNight((n) => !n); }}>
          {night ? <Moon size={16} /> : <Sun size={16} />}
        </ToolButton>
        {variant === 'panel' && (
          <Link href="/office" aria-label="Full-screen office" title="Full-screen office"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-white">
            <Maximize2 size={16} />
          </Link>
        )}
      </div>

      {/* legend / hints */}
      <div className="pointer-events-none absolute bottom-2 left-2 hidden items-center gap-3 rounded-lg bg-[#0b0a1f]/75 px-2.5 py-1.5 text-[11px] text-[var(--color-muted)] backdrop-blur md:flex">
        {[['working', 'Working'], ['idle', 'On break'], ['waiting', 'Needs you'], ['blocked', 'Blocked']].map(([k, l]) => (
          <span key={k} className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: DOT[k] }} />{l}</span>
        ))}
        {avatar && <span className="border-l border-[var(--color-line)] pl-3">Click the floor or use WASD to walk</span>}
      </div>
      {nearAgent && (
        <button onClick={() => onOpen(nearAgent.id)}
          className="absolute bottom-10 left-1/2 -translate-x-1/2 rounded-full border border-[var(--color-line-active)] bg-[var(--color-panel)]/95 px-3 py-1.5 text-[12.5px] shadow-lg md:bottom-12">
          Press <kbd className="rounded bg-[var(--color-panel-2)] px-1.5 font-mono">E</kbd> to see {nearAgent.name}&apos;s screen
        </button>
      )}

      {!ready && !failed && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#0e0d26]" aria-live="polite">
          <span className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
            <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--color-primary)]" /> Opening the office…
          </span>
        </div>
      )}
      {failed && (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-[#ff8a8d]">The office map could not start: {failed}. The Grid view still works.</div>
      )}
    </div>
  );
}

function ToolButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label}
      className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-white">
      {children}
    </button>
  );
}

function NameTag({ a, compact, refFn, onOpen }: { a: AgentView; compact: boolean; refFn: (el: HTMLElement | null) => void; onOpen: (id: string) => void }) {
  const Badge = a.badge === 'hand' ? Hand : a.badge === 'warning' ? AlertTriangle : a.badge === 'hourglass' ? Hourglass : null;
  const badgeColor = a.badge === 'hand' ? '#b9a8ff' : a.badge === 'warning' ? '#ff8a8d' : '#f5c46b';
  return (
    <button ref={refFn} type="button" onClick={() => onOpen(a.id)}
      aria-label={`${a.name}: ${a.tag}. Open screen and chat`}
      className="group pointer-events-auto absolute left-0 top-0 outline-none" style={{ visibility: 'hidden' }}>
      <span className={clsx('flex items-center gap-1 whitespace-nowrap rounded-full bg-[#0b0a1f]/80 font-medium text-white shadow-[0_2px_8px_rgba(0,0,0,.35)] ring-1 backdrop-blur-sm transition-colors group-hover:bg-[#1c1947] group-focus-visible:ring-2',
        a.badge === 'hand' ? 'ring-[#7c5cff]' : 'ring-white/15',
        compact ? 'px-1.5 py-[1px] text-[10px]' : 'px-2 py-0.5 text-[11.5px]')}>
        <span className={clsx('shrink-0 rounded-full', compact ? 'h-1.5 w-1.5' : 'h-2 w-2', a.badge === 'hand' && 'animate-pulse')} style={{ background: DOT[a.status] }} />
        {Badge && <Badge size={compact ? 10 : 12} style={{ color: badgeColor }} className={a.badge === 'hand' ? 'animate-bounce' : undefined} aria-hidden />}
        {compact ? a.short : a.name}
      </span>
      <span className="pointer-events-none absolute bottom-full left-1/2 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-2)] px-2 py-1 text-[11.5px] text-[var(--color-ink)] shadow-lg group-hover:block group-focus-visible:block">
        {a.tag}
      </span>
    </button>
  );
}
