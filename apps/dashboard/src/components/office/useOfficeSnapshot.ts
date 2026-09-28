'use client';
// The snapshot the office views render: the live store snapshot in LIVE mode; in DEMO mode the store
// snapshot plus the office simulator's overlay (a few agents change state every 20–40 s).
import { useEffect, useMemo, useRef, useState } from 'react';
import { useHq } from '@/lib/data/store';
import { buildIndexes } from '@/lib/data/derive';
import type { HqSnapshot } from '@/lib/data/types';
import { applyOverlay, emptyOverlay, simStep, type SimOverlay } from './logic/demoSim';
import { mulberry32 } from './logic/rng';

export function useOfficeSnapshot() {
  const { snap, session } = useHq();
  const demo = session.mode === 'demo';
  const [overlay, setOverlay] = useState<SimOverlay>(emptyOverlay);
  const baseRef = useRef<HqSnapshot>(snap);
  baseRef.current = snap;

  useEffect(() => {
    if (!demo) return;
    const rng = mulberry32((Date.now() & 0xffffff) || 1);
    let timer: ReturnType<typeof setTimeout>;
    let first = true;
    const loop = () => {
      const wait = first ? 8_000 + rng() * 4_000 : 20_000 + rng() * 20_000;
      first = false;
      timer = setTimeout(() => {
        if (document.visibilityState === 'visible') {
          setOverlay((o) => simStep(applyOverlay(baseRef.current, o), o, rng, Date.now()));
        }
        loop();
      }, wait);
    };
    loop();
    return () => clearTimeout(timer);
  }, [demo]);

  const view = useMemo(() => (demo ? applyOverlay(snap, overlay) : snap), [demo, snap, overlay]);
  const idx = useMemo(() => buildIndexes(view), [view]);
  return { snap: view, idx, demo };
}
