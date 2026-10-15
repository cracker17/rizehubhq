'use client';
// /operator demo player (docs/17-OPERATOR.md "Demo"): plays the scripted LvlUp morning (lib/operatorDemo.ts) on the real
// Operator page, with the Telegram messages you would get on the right. Approval buttons there move the story on.
// Demo data only: nothing reaches the database, Telegram or any client tool.
import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Pause, Play, RotateCcw, Send } from 'lucide-react';
import { btn } from '@/components/clients/ui';
import { DEMO_SCRIPT, DEMO_TAPS, initialDemo, step, type DemoState, type TgMessage } from '@/lib/operatorDemo';
import type { OperatorHomeData } from '@/lib/operatorView';
import { OperatorHome } from './OperatorHome';
import { DemoScreen } from './DemoScreen';

export function OperatorDemoPlayer({ base, error }: { base: OperatorHomeData; error?: string }) {
  const [state, setState] = useState<DemoState>(() => initialDemo(base));
  const [pos, setPos] = useState(0);            // next event to apply
  const [playing, setPlaying] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const waiting = pos < DEMO_SCRIPT.length ? DEMO_SCRIPT[pos]!.waitFor ?? null : null;
  const tgEnd = useRef<HTMLDivElement>(null);

  // The position lives in a ref too, so each event is applied exactly once (React may run state updaters twice).
  const posRef = useRef(0);
  const moveTo = useCallback((p: number) => { posRef.current = p; setPos(p); }, []);
  const advance = useCallback(() => {
    const p = posRef.current;
    if (p >= DEMO_SCRIPT.length) return;
    const ev = DEMO_SCRIPT[p]!;
    const now = Date.now();
    setState((s) => step(s, ev, now));
    moveTo(p + 1);
  }, [moveTo]);

  // Timed beats run by themselves while playing; a beat that waits for a tap shows its caption and stops.
  useEffect(() => {
    if (!playing || pos >= DEMO_SCRIPT.length) return;
    const ev = DEMO_SCRIPT[pos]!;
    if (ev.waitFor) { if (ev.caption) setState((s) => ({ ...s, caption: ev.caption! })); return; }
    const prev = pos > 0 ? DEMO_SCRIPT[pos - 1]!.ms ?? 0 : 0;
    const t = setTimeout(advance, pos === 0 ? 300 : prev);
    return () => clearTimeout(t);
  }, [playing, pos, advance]);

  useEffect(() => { tgEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [state.telegram.length]);

  const tap = (b: { tap?: string; label: string }) => {
    if (b.tap && b.tap === waiting) { setHint(null); moveTo(posRef.current + 1); return; }
    setHint(b.tap ? 'Not yet: follow the caption above.' : `In the real bot, “${b.label}” works too. For this demo, tap the ✅ button.`);
  };
  const restart = () => { setState(initialDemo(base)); moveTo(0); setPlaying(true); setHint(null); };
  const tapsDone = DEMO_TAPS.filter((_, i) => DEMO_SCRIPT.findIndex((e) => e.waitFor === DEMO_TAPS[i]) < pos).length;

  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-4">
      <div className="card sticky top-[calc(env(safe-area-inset-top,0px)+8px)] z-20 flex flex-wrap items-center gap-3 px-4 py-3" role="status" aria-live="polite">
        <span className="rounded-full bg-[color-mix(in_oklab,var(--color-primary)_22%,transparent)] px-2.5 py-0.5 text-xs font-semibold text-[#d6ccff]">DEMO</span>
        <p className="min-w-0 flex-1 basis-[260px] text-[13px] leading-snug">{state.caption}</p>
        <span className="text-xs tabular-nums text-[var(--color-muted)]">Your taps {tapsDone}/{DEMO_TAPS.length}</span>
        {!playing && !state.done && <button className={btn.primary} onClick={() => setPlaying(true)}><Play size={16} aria-hidden />{pos === 0 ? 'Play demo' : 'Resume'}</button>}
        {playing && !state.done && !waiting && <button className={btn.ghost} onClick={() => setPlaying(false)}><Pause size={16} aria-hidden />Pause</button>}
        {(pos > 0 || state.done) && <button className={btn.ghost} onClick={restart}><RotateCcw size={16} aria-hidden />Restart</button>}
      </div>

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="order-2 min-w-0 xl:order-1">
          <OperatorHome data={state.data} error={error} scripted liveScreen={<DemoScreen screen={state.screen} />} />
        </div>
        <aside aria-label="Telegram" className="order-1 xl:order-2">
          <div className="card flex max-h-[70vh] flex-col overflow-hidden p-0 xl:sticky xl:top-24">
            <div className="flex items-center gap-2 border-b border-[var(--color-line)] px-4 py-3">
              <Send size={16} className="text-[#8fd0ff]" aria-hidden />
              <h2 className="text-sm font-semibold">Telegram · RizeHub HQ bot</h2>
            </div>
            <div className="scroll-thin flex min-h-[160px] flex-1 flex-col gap-2.5 overflow-y-auto p-3">
              {state.telegram.length === 0 && <p className="py-6 text-center text-xs text-[var(--color-muted)]">What the bot sends you shows up here.</p>}
              {state.telegram.map((m) => <TgBubble key={m.id} m={m} waiting={waiting} onTap={tap} />)}
              <div ref={tgEnd} />
            </div>
            {hint && <p className="border-t border-[var(--color-line)] px-4 py-2 text-xs text-[#fcd34d]">{hint}</p>}
          </div>
        </aside>
      </div>
    </div>
  );
}

function TgBubble({ m, waiting, onTap }: { m: TgMessage; waiting: string | null; onTap: (b: { tap?: string; label: string }) => void }) {
  return (
    <div className="flex flex-col gap-1.5" style={{ animation: 'brain-in .3s ease-out' }}>
      <div className="rounded-xl rounded-bl-sm bg-[var(--color-panel-2)] px-3 py-2 text-[12.5px] leading-snug">
        {m.lines.map((l, i) => <p key={i} className={clsx('whitespace-pre-wrap break-words', i === 0 && 'font-semibold', !l && 'h-1.5')}>{l}</p>)}
        {m.photos && (
          <div className="mt-2 grid grid-cols-[1fr_2fr] gap-1">
            {m.photos.map((p, i) => <div key={p} className={clsx('grid place-items-end justify-start rounded-md border border-[var(--color-line)] bg-[var(--color-panel)] p-1.5 text-[10px] text-[var(--color-muted)]', i === 0 ? 'aspect-[9/16]' : 'aspect-[16/10] self-end')}>📷 {p}</div>)}
          </div>
        )}
        {m.decided && <p className="mt-1.5 font-semibold text-[#6ee7b7]">{m.decided}</p>}
      </div>
      {m.buttons && (
        <div className="flex flex-wrap gap-1">
          {m.buttons.map((b) => (
            <button key={b.label} onClick={() => onTap(b)}
              className={clsx('flex-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-transform active:scale-[.97]',
                b.tap && b.tap === waiting ? 'bg-[var(--color-primary)] text-white shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-primary)_35%,transparent)]' : 'bg-[var(--color-panel-2)] text-[#8fd0ff]')}>
              {b.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
