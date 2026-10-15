'use client';
// One camera on the wall: a desktop window showing what the worker has on screen (screenshot when there is one, else a
// rendering of its app from agent_screens), a Claude-style cursor that moves between the parts it works on with a
// highlight box and a click ripple, the step caption, and a CCTV overlay (camera number, REC, clock).
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Sparkles } from 'lucide-react';
import { CURSOR_SPOTS, camClock, type WallStep, type WallTile } from '@/lib/wallView';

const STATE_DOT: Record<WallTile['state'], string> = { working: '#34d399', waiting: '#fbbf24', blocked: '#f87171', idle: '#6e6a9e', offline: '#3f3b6b' };
const STATE_LABEL: Record<WallTile['state'], string> = { working: 'Working', waiting: 'Waiting', blocked: 'Stuck', idle: 'Idle', offline: 'Off' };

function useTicker(ms: number, on: boolean, offset = 0) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!on) return;
    let t: ReturnType<typeof setInterval> | undefined;
    const start = setTimeout(() => { setN((v) => v + 1); t = setInterval(() => setN((v) => v + 1), ms); }, offset);
    return () => { clearTimeout(start); if (t) clearInterval(t); };
  }, [ms, on, offset]);
  return n;
}

function lines(text: string, fallback: string[], max: number): string[] {
  const l = text.split(/\r?\n/).map((x) => x.replace(/\t/g, '  ')).filter((x) => x.trim()).slice(0, max);
  return l.length ? l : fallback;
}

const SKELETON = ['██████ ████ ███████', '████ ██████████', '███████ ███ █████ ██', '████████ ███', '██████ ██████████ ██'];

function AppBody({ tile, typed }: { tile: WallTile; typed: number }) {
  if (tile.imageUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={tile.imageUrl} alt={`${tile.name} screen`} className="h-full w-full object-cover object-top" />;
  }
  switch (tile.app) {
    case 'editor':
      return (
        <div className="h-full overflow-hidden bg-[#0d0b24] p-2 font-mono text-[9.5px] leading-[1.55] text-[#c9c4ff]">
          {lines(tile.content, SKELETON, 14).map((l, i, a) => (
            <div key={i} className="flex gap-2 whitespace-pre"><span className="w-4 shrink-0 text-right text-[#4b4680]">{i + 1}</span>
              <span className="truncate">{l}{i === a.length - 1 && <span className="wall-caret">▍</span>}</span></div>
          ))}
        </div>
      );
    case 'sheet':
      return (
        <div className="grid h-full grid-cols-4 gap-px bg-[#2c2863] p-px text-[9px] text-[#a09cc9]">
          {Array.from({ length: 28 }, (_, i) => <div key={i} className={clsx('truncate bg-[#14123a] px-1 py-0.5', i < 4 && 'font-semibold text-[#d6d3ff]')}>{i < 4 ? ['Name', 'Company', 'Status', 'Score'][i] : '██ ███'}</div>)}
        </div>
      );
    case 'whiteboard':
      return (
        <div className="relative h-full bg-[#f4f2ff]">
          {[['#fde68a', 8, 14], ['#a7f3d0', 54, 30], ['#c4b5fd', 20, 62]].map(([c, x, y], i) => (
            <div key={i} className="absolute h-[22%] w-[36%] rotate-[-2deg] rounded-sm p-1 text-[8.5px] text-[#1f1d3a] shadow" style={{ background: c as string, left: `${x}%`, top: `${y}%` }}>
              {lines(tile.content, ['Plan step', 'Owner', 'Due'], 3)[i] ?? ''}
            </div>
          ))}
        </div>
      );
    case 'chat': {
      const draft = tile.content || tile.note;
      return (
        <div className="flex h-full flex-col justify-end gap-1.5 bg-[#f8f9fb] p-2 text-[9px] text-[#1f2937]">
          <div className="w-[70%] rounded-lg bg-white px-2 py-1 shadow-sm">██████ █████ ███████ ██ ████?</div>
          <div className="w-[55%] rounded-lg bg-white px-2 py-1 shadow-sm">███ ██████ ████</div>
          <div className="mt-1 rounded-full border border-[#d1d5db] bg-white px-2 py-1 text-[#111827]">{draft.slice(0, Math.max(1, typed))}<span className="wall-caret">▍</span></div>
        </div>
      );
    }
    case 'idle':
      return (
        <div className="grid h-full place-items-center bg-[radial-gradient(circle_at_50%_40%,#1c1947,#0b0a1f)] text-center">
          <div><div className="mx-auto mb-1 grid h-7 w-7 place-items-center rounded-lg bg-[var(--color-primary)] text-xs font-bold text-white">R</div>
            <p className="text-[10px] text-[var(--color-muted)]">{tile.note}</p></div>
        </div>
      );
    default: // browser, doc, review
      return (
        <div className="flex h-full flex-col bg-white text-[9px] text-[#1f2937]">
          {tile.app !== 'doc' && (
            <div className="flex items-center gap-1 border-b border-[#e5e7eb] bg-[#f3f4f6] px-1.5 py-1">
              <span className="truncate rounded bg-white px-1.5 py-0.5 text-[8.5px] text-[#4b5563]">{tile.title || 'about:blank'}</span>
            </div>
          )}
          <div className="flex-1 space-y-1 overflow-hidden p-2">
            {tile.app === 'review'
              ? lines(tile.content, ['Headline clear', 'Mobile layout', 'Links work', 'Spelling'], 6).map((l, i) => <div key={i} className="flex gap-1"><span>{i % 3 === 2 ? '○' : '✓'}</span><span className="truncate">{l}</span></div>)
              : lines(tile.content, SKELETON, 8).map((l, i) => <p key={i} className={clsx('truncate', i === 0 && 'text-[11px] font-semibold')}>{l}</p>)}
          </div>
        </div>
      );
  }
}

/** now = the wall's shared clock (null until mounted, so server and client render the same text). */
export function ScreenTile({ tile, now, replay, onOpen }: { tile: WallTile; now: Date | null; replay?: WallStep | null; large?: boolean; onOpen?: () => void }) {
  const live = tile.state === 'working' && !replay;
  const tick = useTicker(2400, live, (tile.cam * 370) % 2400);
  const typedTick = useTicker(90, live && tile.app === 'chat');
  const spots = CURSOR_SPOTS[tile.app];
  const spot = spots.length ? spots[tick % spots.length]! : null;
  const caption = replay?.text ?? tile.note;

  return (
    <div className={clsx('group relative overflow-hidden rounded-[14px] border bg-[#08071a]', live ? 'border-[color-mix(in_oklab,var(--color-line-active)_70%,transparent)] shadow-[0_0_24px_rgba(124,92,255,.25)]' : 'border-[var(--color-line)]')}>
      {/* window chrome */}
      <div className="flex items-center gap-1.5 border-b border-[var(--color-line)] bg-[var(--color-panel-2)] px-2.5 py-1.5">
        <span className="h-2 w-2 rounded-full bg-[#ff5f57]" /><span className="h-2 w-2 rounded-full bg-[#febc2e]" /><span className="h-2 w-2 rounded-full bg-[#28c840]" />
        <span className="ml-1.5 min-w-0 flex-1 truncate text-[11px] text-[var(--color-muted)]">{tile.app === 'idle' ? 'Desktop' : `${tile.app} — ${tile.title || tile.project || tile.name}`}</span>
      </div>

      <button type="button" onClick={onOpen} className="relative block aspect-[16/10] w-full text-left" aria-label={`Open ${tile.name}'s screen`}>
        <AppBody tile={tile} typed={typedTick} />

        {/* Claude-style cursor: highlight box, click ripple, pointer with label */}
        {live && spot && (
          <>
            <span className="wall-box pointer-events-none absolute rounded-md" key={`b${tick}`}
              style={{ left: `${spot.box.x}%`, top: `${spot.box.y}%`, width: `${spot.box.w}%`, height: `${spot.box.h}%` }} />
            <span className="pointer-events-none absolute z-10 transition-[left,top] duration-[900ms] ease-[cubic-bezier(.3,.7,.2,1)]" style={{ left: `${spot.x}%`, top: `${spot.y}%` }}>
              <span className="wall-ripple absolute -left-3 -top-3 h-6 w-6 rounded-full" key={`r${tick}`} />
              <svg width="16" height="18" viewBox="0 0 16 18" aria-hidden className="drop-shadow-[0_1px_2px_rgba(0,0,0,.6)]">
                <path d="M1 1 L1 15 L5 11 L8 17 L10.5 16 L7.6 10 L13 10 Z" fill="#d97757" stroke="#fff" strokeWidth="1.2" strokeLinejoin="round" />
              </svg>
              <span className="absolute left-3.5 top-4 whitespace-nowrap rounded-full bg-[#d97757] px-1.5 py-px text-[8.5px] font-semibold text-white">{tile.kind === 'operator' ? 'Operator' : tile.name.split(' ')[0]}</span>
            </span>
          </>
        )}

        {/* CCTV overlay */}
        <span className="wall-scan pointer-events-none absolute inset-0" aria-hidden />
        <span className="pointer-events-none absolute left-1.5 top-1.5 flex items-center gap-1.5 rounded bg-black/60 px-1.5 py-px font-mono text-[10px] text-white/90">
          CAM {String(tile.cam).padStart(2, '0')}
          {replay ? <span className="rounded bg-[#3b82f6] px-1 text-[9px]">REPLAY</span>
            : <span className="flex items-center gap-1"><span className={clsx('h-1.5 w-1.5 rounded-full', tile.state === 'offline' ? 'bg-[#6e6a9e]' : 'wall-rec bg-[#ef4444]')} />REC</span>}
        </span>
        <span className="pointer-events-none absolute right-1.5 top-1.5 rounded bg-black/60 px-1.5 py-px font-mono text-[10px] text-white/90">
          {replay ? camClock(new Date(replay.at)) : now ? camClock(now) : '--:--:--'}
        </span>
        {caption && tile.state !== 'idle' && tile.state !== 'offline' && (
          <span className="pointer-events-none absolute inset-x-2 bottom-2 flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] text-white glass">
            <Sparkles size={12} className="shrink-0 text-[#f0b49a]" aria-hidden /><span className="truncate">{caption}</span>
          </span>
        )}
        {tile.progress !== null && tile.state === 'working' && (
          <span className="absolute inset-x-0 bottom-0 h-[3px] bg-black/40"><span className="block h-full bg-[var(--color-primary)] transition-[width] duration-700" style={{ width: `${tile.progress}%` }} /></span>
        )}
      </button>

      {/* label */}
      <div className="flex items-center gap-2 px-2.5 py-2">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: STATE_DOT[tile.state] }} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">{tile.name}</span>
          <span className="block truncate text-[11px] text-[var(--color-dim)]">{STATE_LABEL[tile.state]}{tile.project ? ` · ${tile.project}` : ''}</span>
        </span>
      </div>
    </div>
  );
}
