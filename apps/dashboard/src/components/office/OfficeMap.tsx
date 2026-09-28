'use client';
// The virtual office (docs/07): the painted RizeHub HQ floor (Phaser canvas: background + animated people)
// with crisp HTML overlays laid out in world pixels: room signs, the live wall screens, the doormat,
// the CEO's approval bubble, name tags and the toolbar. Loaded only on the client (next/dynamic, ssr: false).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { AlertTriangle, Expand, Hand, Hourglass, Maximize2, MessageSquareMore, Minimize, Minus, Moon, Plus, Scan, Sun, SunMoon, Volume2, VolumeX } from 'lucide-react';
import type { HqSnapshot } from '@/lib/data/types';
import { deriveOffice, diffEvents, type AgentView, type OfficeModel } from './logic/director';
import { LAYOUT, type XY } from './logic/layout';
import type { OfficeController } from './engine/game';
import type { FrameInfo } from './engine/OfficeScene';
import { officeAudio } from './engine/audio';
import { DAY_LIGHT, NIGHT_LIGHT, ambientAt, manilaMinutes } from './logic/ambient';

const DOT: Record<string, string> = {
  working: '#1f9d6b', idle: '#f5a524', waiting: '#7c5cff', blocked: '#e5484d', offline: '#6e6a9e',
};
const S = LAYOUT.image.scale;
const WORLD_W = LAYOUT.image.width * S;
const WORLD_H = LAYOUT.image.height * S;
const COMPACT_BELOW = 0.34;

export function manilaNight(d = new Date()) {
  const p = ambientAt(manilaMinutes(d)).phase;
  return p === 'night' || p === 'dusk';
}
type LightMode = 'auto' | 'day' | 'night';

/** CSS matrix3d that maps a w×h box onto a quad (world px): used to paint HTML onto the wall screens. */
export function rectToQuad(w: number, h: number, q: XY[]): string {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2; const dx2 = x3 - x2; const dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2; const dy2 = y3 - y2; const dy3 = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / den;
  const hh = (dx1 * dy3 - dx3 * dy1) / den;
  const a = x1 - x0 + g * x1; const b = x3 - x0 + hh * x3; const c = x0;
  const d = y1 - y0 + g * y1; const e = y3 - y0 + hh * y3; const f = y0;
  const m = [a / w, d / w, 0, g / w, b / h, e / h, 0, hh / h, 0, 0, 1, 0, c, f, 0, 1];
  return `matrix3d(${m.map((v) => +v.toFixed(8)).join(',')})`;
}

const wq = (q: XY[]): XY[] => q.map(([x, y]) => [x * S, y * S]);

export interface OfficeMapProps {
  snap: HqSnapshot;
  variant: 'panel' | 'full';
  onOpen: (agentId: string) => void;
}

export default function OfficeMap({ snap, variant, onOpen }: OfficeMapProps) {
  const host = useRef<HTMLDivElement>(null);
  const worldEl = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<OfficeController | null>(null);
  const [ctrl, setCtrl] = useState<OfficeController | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [model, setModel] = useState<OfficeModel | null>(null);
  const [compact, setCompact] = useState(variant === 'panel');
  const [followId, setFollowId] = useState<string>('');
  const [minute, setMinute] = useState(() => manilaMinutes());
  const [lightMode, setLightMode] = useState<LightMode>('auto');
  const [music, setMusic] = useState(() => officeAudio.musicOn);
  useEffect(() => officeAudio.onChange(setMusic), []);
  const light = lightMode === 'day' ? DAY_LIGHT : lightMode === 'night' ? NIGHT_LIGHT : ambientAt(minute);
  const [near, setNear] = useState<string | null>(null);
  const [avatar, setAvatar] = useState(false);
  const tagEls = useRef(new Map<string, HTMLElement>());
  const ceoEl = useRef<HTMLDivElement>(null);
  const widths = useRef(new Map<string, number>());
  const compactRef = useRef(compact);
  const nearRef = useRef<string | null>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const rootEl = useRef<HTMLDivElement>(null);
  const [isFs, setIsFs] = useState(false);
  useEffect(() => {
    const sync = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  const toggleFs = useCallback(() => {
    // Browser full screen (desktop + Android); iOS Safari and some app views don't allow it — the map already fills the window there.
    const el = variant === 'full' ? document.documentElement : rootEl.current;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void el?.requestFullscreen?.().catch(() => {});
  }, [variant]);

  // ---- model from data (+ a slow clock so the COO alternates tasks)
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
    const w = worldEl.current;
    if (w) {
      w.style.transform = `translate(${f.view.tx.toFixed(2)}px, ${f.view.ty.toFixed(2)}px) scale(${f.view.scale.toFixed(5)})`;
      w.style.setProperty('--inv', String(1 / f.view.scale));
    }
    // Declutter name tags: place bottom-up and nudge overlapping ones upwards.
    const placed: { x0: number; x1: number; y: number }[] = [];
    const H = isCompact ? 19 : 22;
    const order = [...f.tags].filter((t) => t.visible).sort((a, b) => b.y - a.y);
    const finalY = new Map<string, number>();
    for (const t of order) {
      const tw = widths.current.get(t.id) ?? 80;
      let y = t.y;
      for (let i = 0; i < 6; i++) {
        const hit = placed.find((p) => t.x - tw / 2 < p.x1 && t.x + tw / 2 > p.x0 && Math.abs(p.y - y) < H);
        if (!hit) break;
        y = hit.y - H;
      }
      placed.push({ x0: t.x - tw / 2, x1: t.x + tw / 2, y });
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

  useEffect(() => {
    if (!ctrl) return;
    if (model) ctrl.setModel(model, []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctrl]);
  useEffect(() => { ctrl?.setAmbient({ color: light.color, alpha: light.alpha, lamps: light.lamps }); }, [ctrl, light.color, light.alpha, light.lamps]);
  // The office light follows the Philippine clock (checked every minute).
  useEffect(() => { const t = setInterval(() => setMinute(manilaMinutes()), 60_000); return () => clearInterval(t); }, []);

  useLayoutEffect(() => {
    for (const [id, el] of tagEls.current) widths.current.set(id, el.offsetWidth + 4);
  }, [model, compact]);

  const agents = useMemo(() => (model?.agents ?? []).filter((a) => a.goal), [model]);
  const meeting = model?.meeting ?? null;
  const nearAgent = near ? agents.find((a) => a.id === near) : null;
  const pending = useMemo(() => snap.approvals.filter((a) => a.status === 'pending'), [snap.approvals]);
  const board = useMemo(() => salesBoard(snap), [snap]);
  const live = useMemo(() => liveBoard(snap, pending.length, now), [snap, pending.length, now]);

  const setTag = (id: string) => (el: HTMLElement | null) => { if (el) tagEls.current.set(id, el); else tagEls.current.delete(id); };
  const at = ([x, y]: XY) => ({ left: x * S, top: y * S });
  const screenQuad = (id: string) => LAYOUT.wallScreens.find((s) => s.id === id)?.quad;
  const pipelineQuad = screenQuad('pipeline');
  const tvQuad = screenQuad('board-tv');
  const mat = LAYOUT.doormat;

  return (
    <div ref={rootEl} className="relative h-full w-full select-none overflow-hidden bg-[#15131f]">
      <div ref={host} className="absolute inset-0 touch-none" role="application" aria-label="RizeHub HQ office. Tap a person or their name tag to open their screen and chat." />

      {/* world-space overlays (follow the camera) */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" style={{ visibility: ready ? 'visible' : 'hidden' }}>
        <div ref={worldEl} className="absolute left-0 top-0 origin-top-left" style={{ width: WORLD_W, height: WORLD_H, ['--inv' as string]: '1' }}>
          {/* live wall screens */}
          {pipelineQuad && (
            <div className="absolute left-0 top-0 origin-top-left overflow-hidden" style={{ width: 300, height: 130, transform: rectToQuad(300, 130, wq(pipelineQuad)) }} aria-hidden>
              <div className="flex h-full w-full flex-col bg-[#f7f8f5] px-3 py-2 font-sans text-[#1e2530]">
                <div className="flex items-center justify-between text-[15px] font-bold tracking-tight">
                  <span>Sales pipeline</span><span className="flex items-center gap-1 text-[11px] font-semibold text-[#1f9d6b]"><span className="h-2 w-2 animate-pulse rounded-full bg-[#1f9d6b]" />live</span>
                </div>
                <div className="mt-1 grid flex-1 grid-cols-4 items-end gap-2">
                  {board.map((b) => (
                    <div key={b.label} className="flex h-full flex-col justify-end">
                      <div className="rounded-t-sm" style={{ height: `${Math.max(8, b.pct)}%`, background: b.color }} />
                      <div className="mt-0.5 text-center text-[17px] font-bold leading-none tabular-nums">{b.value}</div>
                      <div className="text-center text-[10px] font-semibold uppercase leading-tight tracking-wide text-[#5b6472]">{b.label}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
          {tvQuad && (
            <div className="absolute left-0 top-0 origin-top-left overflow-hidden" style={{ width: 360, height: 220, transform: rectToQuad(360, 220, wq(tvQuad)) }} aria-hidden>
              <LiveTv board={live} minute={minute} />
            </div>
          )}

          {/* doormat */}
          <div className="absolute whitespace-nowrap font-serif text-[22px] font-semibold tracking-[0.08em] text-[#d9cdb8]/80"
            style={{ ...at(mat.center), transform: `translate(-50%, -50%) rotate(${mat.angle}deg) skewX(${mat.skewY}deg)`, textShadow: '0 1px 0 rgba(0,0,0,.45)' }} aria-hidden>
            {mat.text}
          </div>

          {/* room signs */}
          {LAYOUT.rooms.map((r) => (
            <div key={r.id} className="absolute" style={{ ...at(r.label), transform: 'translate(-50%, -50%) scale(var(--inv))' }}>
              <span className={clsx('block whitespace-nowrap rounded-full border border-black/10 bg-[#fbf8f2]/95 font-semibold text-[#2b2750] shadow-[0_2px_6px_rgba(0,0,0,.28)]',
                compact ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-0.5 text-[12px]')}>
                {r.name}
              </span>
            </div>
          ))}

          {/* meeting label over the Boardroom */}
          {meeting && (
            <div className="absolute" style={{ ...at([1105, 205]), transform: 'translate(-50%, -100%) scale(var(--inv))' }}>
              <span className="flex max-w-[16rem] items-center gap-1.5 truncate whitespace-nowrap rounded-full bg-[var(--color-primary)] px-2.5 py-1 text-[11px] font-semibold text-white shadow-lg sm:max-w-[22rem]">
                <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-white" /> <span className="truncate">{meeting.label}</span>
              </span>
            </div>
          )}

          {/* awaiting CEO approval → chat bubble above the CEO office */}
          {pending.length > 0 && (
            <Link href="/approvals" className="pointer-events-auto absolute" style={{ ...at([1232, 548]), transform: 'translate(-50%, -100%) scale(var(--inv))' }}
              aria-label={`${pending.length} approval${pending.length === 1 ? '' : 's'} waiting for you`}>
              <span className="relative flex animate-bounce items-center gap-1.5 whitespace-nowrap rounded-2xl bg-[#8b5cf6] px-3 py-1.5 text-[12px] font-semibold text-white shadow-[0_6px_16px_rgba(80,40,160,.45)] ring-2 ring-white/70 [animation-duration:2.2s]">
                <MessageSquareMore size={14} aria-hidden /> {pending.length} to approve
                <span className="absolute -bottom-1.5 left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 bg-[#8b5cf6]" />
              </span>
            </Link>
          )}
        </div>
      </div>

      {/* screen-space overlays (name tags) */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {agents.map((a) => <NameTag key={a.id} a={a} compact={compact} refFn={setTag(a.id)} onOpen={onOpen} />)}
        <div ref={ceoEl} className="absolute left-0 top-0" style={{ visibility: 'hidden' }}>
          <span className={clsx('flex items-center gap-1 whitespace-nowrap rounded-full bg-[var(--color-primary)] font-semibold text-white shadow-lg ring-1 ring-white/20',
            compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-[11.5px]')}>
            Julev <span className="font-normal opacity-80">(CEO)</span>
          </span>
        </div>
      </div>

      {/* toolbar */}
      <div className={clsx('absolute right-2 flex items-center gap-1 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)]/90 p-1 shadow-lg backdrop-blur sm:right-3', variant === 'full' ? 'top-14' : 'top-2 sm:top-3')}>
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
        <ToolButton label={isFs ? 'Exit full screen' : 'Full screen'} onClick={toggleFs}>
          {isFs ? <Minimize size={16} /> : <Expand size={16} />}
        </ToolButton>
        <ToolButton label={music ? 'Mute music' : 'Play music'} onClick={() => officeAudio.setMusic(!music)}>
          {music ? <Volume2 size={16} /> : <VolumeX size={16} />}
        </ToolButton>
        <ToolButton
          label={lightMode === 'auto' ? `Light follows Philippine time (${light.phase}) · click for day` : lightMode === 'day' ? 'Always day · click for night' : 'Always night · click for Philippine time'}
          onClick={() => setLightMode((m) => (m === 'auto' ? 'day' : m === 'day' ? 'night' : 'auto'))}>
          {lightMode === 'auto' ? <SunMoon size={16} /> : lightMode === 'day' ? <Sun size={16} /> : <Moon size={16} />}
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
        <div className="absolute inset-0 flex items-center justify-center bg-[#15131f]" aria-live="polite">
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

/** The Growth & Sales wall screen: this week's sales work by pipeline stage (from the Sales Agent's tasks). */
export function salesBoard(snap: HqSnapshot) {
  const weekAgo = Date.now() - 7 * 86_400_000;
  const recent = snap.tasks.filter((t) => t.agent_id === 'sales' && Date.parse(t.created_at) >= weekAgo);
  const count = (types: string[]) => recent.filter((t) => types.includes(t.work_type)).length;
  const rows = [
    { label: 'Found', value: count(['lead-finder-search', 'lead-report']), color: '#94a3b8' },
    { label: 'Researched', value: count(['lead-qualification']), color: '#60a5fa' },
    { label: 'Contacted', value: count(['outreach-draft', 'follow-up-email', 'dm-reply-draft']), color: '#a78bfa' },
    { label: 'Proposals', value: count(['proposal']), color: '#1f9d6b' },
  ];
  const max = Math.max(1, ...rows.map((r) => r.value));
  return rows.map((r) => ({ ...r, pct: Math.round((r.value / max) * 100) }));
}

/** The Boardroom TV: what needs the CEO, what the team is doing, and the last 7 days of output. */
export function liveBoard(snap: HqSnapshot, pending: number, nowMs = Date.now()) {
  const working = snap.agents.filter((a) => a.status === 'working').length;
  const review = snap.tasks.filter((t) => t.status === 'qa_pending' || t.status === 'qa_reviewing' || t.status === 'awaiting_ceo').length;
  const open = snap.requests.filter((r) => !['done', 'cancelled', 'rejected'].includes(r.status as string)).length;
  const dayKey = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(ms);
  const days = Array.from({ length: 7 }, (_, i) => {
    const ms = nowMs - (6 - i) * 86_400_000;
    return { key: dayKey(ms), label: new Intl.DateTimeFormat('en-US', { weekday: 'narrow', timeZone: 'Asia/Manila' }).format(ms), done: 0 };
  });
  const byKey = new Map(days.map((d) => [d.key, d]));
  for (const t of snap.tasks) {
    if (t.status !== 'done' && t.status !== 'awaiting_ceo') continue;
    const at = t.completed_at ?? t.updated_at;
    const d = at ? byKey.get(dayKey(Date.parse(at))) : undefined;
    if (d) d.done++;
  }
  const weekAgo = nowMs - 7 * 86_400_000;
  const reviews = (snap.qaReviews ?? []).filter((r) => Date.parse(r.created_at) >= weekAgo);
  const passRate = reviews.length ? Math.round((reviews.filter((r) => r.verdict === 'pass').length / reviews.length) * 100) : null;
  const active = snap.tasks.filter((t) => t.status === 'working');
  const progress = snap.screens.filter((x) => active.some((t) => t.id === x.task_id) && x.progress != null).map((x) => x.progress as number);
  const avgProgress = progress.length ? Math.round(progress.reduce((a, b) => a + b, 0) / progress.length) : null;
  return {
    kpis: [
      { label: 'Waiting for you', value: pending, color: '#7c3aed' },
      { label: 'Agents working', value: working, color: '#15803d' },
      { label: 'In review', value: review, color: '#b45309' },
      { label: 'Open requests', value: open, color: '#1d4ed8' },
    ],
    days,
    weekDone: days.reduce((a, d) => a + d.done, 0),
    passRate,
    avgProgress,
  };
}
/** Kept for the Grid view / tests: the four headline numbers. */
export function todayBoard(snap: HqSnapshot, pending: number) {
  return liveBoard(snap, pending).kpis.map((k) => ({ label: k.label, value: k.value, color: k.color }));
}

function LiveTv({ board, minute }: { board: ReturnType<typeof liveBoard>; minute: number }) {
  const max = Math.max(1, ...board.days.map((d) => d.done));
  const ring = board.passRate ?? board.avgProgress ?? 0;
  const hh = String(Math.floor(minute / 60)).padStart(2, '0'); const mm = String(minute % 60).padStart(2, '0');
  return (
    <div className="flex h-full w-full flex-col gap-2 bg-[#0d1426] p-3 font-sans text-white">
      <div className="flex items-center justify-between">
        <span className="text-[17px] font-bold tracking-tight">RizeHub HQ <span className="font-medium text-white/60">· Live</span></span>
        <span className="flex items-center gap-1.5 text-[12px] font-semibold tabular-nums text-white/70"><span className="h-2 w-2 animate-pulse rounded-full bg-[#34d399]" />{hh}:{mm} PHT</span>
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        {board.kpis.map((k) => (
          <div key={k.label} className="rounded-md bg-white/[0.07] px-1.5 py-1">
            <div className="text-[22px] font-extrabold leading-none tabular-nums" style={{ color: k.value ? '#fff' : 'rgba(255,255,255,.55)' }}>{k.value}</div>
            <div className="mt-0.5 flex items-center gap-1 text-[9.5px] font-semibold uppercase leading-tight tracking-wide text-white/65"><span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: k.color }} />{k.label}</div>
          </div>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 gap-2">
        <div className="flex min-w-0 flex-1 flex-col rounded-md bg-white/[0.05] px-2 pb-1 pt-1.5">
          <div className="flex justify-between text-[10px] font-semibold uppercase tracking-wide text-white/60"><span>Tasks done · 7 days</span><span className="tabular-nums text-white">{board.weekDone}</span></div>
          <div className="mt-1 grid flex-1 grid-cols-7 items-end gap-1">
            {board.days.map((d, i) => (
              <div key={d.key} className="flex h-full flex-col justify-end">
                <div className="rounded-t-[3px]" style={{ height: `${Math.max(4, (d.done / max) * 100)}%`, background: i === 6 ? '#34d399' : '#6366f1' }} />
                <div className="mt-0.5 text-center text-[9px] font-semibold text-white/55">{d.label}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="flex w-[92px] flex-col items-center justify-center rounded-md bg-white/[0.05]">
          <svg viewBox="0 0 42 42" className="h-[58px] w-[58px] -rotate-90">
            <circle cx="21" cy="21" r="16" fill="none" stroke="rgba(255,255,255,.12)" strokeWidth="5" />
            <circle cx="21" cy="21" r="16" fill="none" stroke="#34d399" strokeWidth="5" strokeLinecap="round" strokeDasharray={`${(ring / 100) * 100.5} 100.5`} />
          </svg>
          <div className="-mt-[42px] mb-[22px] text-[13px] font-extrabold tabular-nums">{board.passRate ?? board.avgProgress ?? '–'}{(board.passRate ?? board.avgProgress) !== null ? '%' : ''}</div>
          <div className="text-center text-[9px] font-semibold uppercase leading-tight tracking-wide text-white/60">{board.passRate !== null ? 'QA pass rate' : 'Avg progress'}</div>
        </div>
      </div>
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
  const task = a.status === 'working' || a.status === 'waiting' || a.status === 'blocked' ? a.tag : null;
  return (
    <button ref={refFn} type="button" onClick={() => onOpen(a.id)}
      aria-label={`${a.name}: ${a.tag}. Open screen and chat`}
      className="group pointer-events-auto absolute left-0 top-0 outline-none" style={{ visibility: 'hidden' }}>
      <span className={clsx('flex max-w-[15rem] items-center gap-1 whitespace-nowrap rounded-full bg-[#0b0a1f]/82 font-medium text-white shadow-[0_2px_8px_rgba(0,0,0,.35)] ring-1 backdrop-blur-sm transition-colors group-hover:bg-[#1c1947] group-focus-visible:ring-2',
        a.badge === 'hand' ? 'ring-[#7c5cff]' : 'ring-white/15',
        compact ? 'px-1.5 py-[1px] text-[10px]' : 'px-2 py-0.5 text-[11.5px]')}>
        <span className={clsx('shrink-0 rounded-full', compact ? 'h-1.5 w-1.5' : 'h-2 w-2', a.badge === 'hand' && 'animate-pulse')} style={{ background: DOT[a.status] }} />
        {Badge && <Badge size={compact ? 10 : 12} style={{ color: badgeColor }} className={a.badge === 'hand' ? 'animate-bounce' : undefined} aria-hidden />}
        <span className="shrink-0">{compact ? a.short : a.name}</span>
        {!compact && task && <span className="truncate font-normal text-white/70">· {task.replace(/^[^·]*·\s*/, '')}</span>}
      </span>
      <span className="pointer-events-none absolute bottom-full left-1/2 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-2)] px-2 py-1 text-[11.5px] text-[var(--color-ink)] shadow-lg group-hover:block group-focus-visible:block">
        {a.tag}
      </span>
    </button>
  );
}
