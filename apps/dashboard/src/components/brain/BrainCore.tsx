'use client';
// The Brain Core (docs/16-BRAIN.md "UI" §1): a brain made of neurons and synapses. Each project is a region on the
// cortex, lit by its real activity (lib/brainNeural projectHeat: idle violet → warm teal → white-hot, ring = active
// in the last 10 minutes). Signals travel along the synapses: more activity, more signals. A save arrives as a light
// from where it came from (Claude left, the PC right, agents top, you bottom) and sets off a cascade from its region.
// Drag to turn, + / − / pinch (and the wheel in full screen, or Ctrl+wheel) to zoom, F for full screen.
// Plain 2D canvas with a 3D projection (no WebGL library). Reduced motion: no drift, no ambient signals.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { ArrowUpRight, Maximize2, Minimize2, Minus, Plus, RotateCcw, X } from 'lucide-react';
import { sourceOf, pulses as isPulse, dayAgo, ago, type BrainEvent, type BrainProject, type Source } from '@/lib/brainView';
import {
  brainNeurons, globalActivity, heatColor, heatLabel, placeLabels, projectAnchors, projectHeat, regions, shortName, synapses,
  type Heat, type RGB,
} from '@/lib/brainNeural';

const NEURONS = 900;
const FOCAL = 5;
const ZOOM_MIN = 0.6, ZOOM_MAX = 2.8;
const ORIGIN: Record<Source, [number, number]> = { claude: [0.0, 0.25], pc: [1.0, 0.35], agent: [0.5, 0.0], julev: [0.5, 1.0], service: [1.0, 0.85] };
const TEAL: RGB = [94, 234, 212], VIOLET: RGB = [139, 122, 230], WHITE: RGB = [236, 254, 255];
const rgba = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
const rgb = (c: RGB) => `rgb(${c.join(',')})`;

interface Signal { a: number; b: number; t: number; hops: number; speed: number; color: RGB; bright: number }
interface Incoming { slug: string; source: Source; start: number }
interface Tip { name: string; heat: Heat | undefined; project: BrainProject }

export function BrainCore({ projects, events, onOpen, className = 'h-[460px]', children }: {
  projects: BrainProject[]; events: BrainEvent[]; onOpen: (slug: string) => void; className?: string; children?: React.ReactNode;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  const [tip, setTip] = useState<Tip | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [zoomPct, setZoomPct] = useState(100);
  const [, tick] = useState(0);

  const listed = useMemo(() => projects.filter((p) => p.listed), [projects]);
  const heat = projectHeat(listed, events);
  const activity = globalActivity(events);
  // What the animation loop reads (it never re-subscribes on data changes).
  const live = useRef({ listed, heat, activity, full, selected });
  live.current = { listed, heat, activity, full, selected };
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  const cmd = useRef<{ zoom: (f: number) => void; reset: () => void } | null>(null);
  const incomingRef = useRef<Incoming[]>([]);
  const camRef = useRef({ yaw: 0.6, pitch: 0.22, zoom: 1 });
  const seenRef = useRef<Set<number> | null>(null);

  // Heat decays with time: re-derive it every 20 s even without new events.
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 20_000); return () => clearInterval(t); }, []);

  // New events (not the ones present at first render) arrive as lights.
  useEffect(() => {
    if (!seenRef.current) { seenRef.current = new Set(events.map((e) => e.id)); return; }
    const now = performance.now();
    for (const e of events) {
      if (seenRef.current.has(e.id)) continue;
      seenRef.current.add(e.id);
      if ((isPulse(e) || e.action === 'tool_call') && e.project_slug && listed.some((p) => p.slug === e.project_slug)) {
        incomingRef.current.push({ slug: e.project_slug, source: sourceOf(e.actor), start: now });
      }
    }
  }, [events, listed]);

  // ---------- full screen (Fullscreen API; a fixed overlay where it is missing, e.g. iPhone Safari) ----------
  const toggleFull = useCallback(() => {
    if (document.fullscreenElement) { void document.exitFullscreen(); setFull(false); return; }
    setFull((f) => !f);
  }, []);
  useEffect(() => {
    const el = wrapRef.current;
    if (full && el?.requestFullscreen && !document.fullscreenElement) el.requestFullscreen().catch(() => {});
    if (full) { const prev = document.body.style.overflow; document.body.style.overflow = 'hidden'; return () => { document.body.style.overflow = prev; }; }
  }, [full]);
  useEffect(() => {
    let was = false;
    const onFs = () => { if (document.fullscreenElement) was = true; else if (was) { was = false; setFull(false); } };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFull(); }
      else if (e.key === 'Escape' && full && !document.fullscreenElement) setFull(false);
      else if (full && (e.key === '+' || e.key === '=')) cmd.current?.zoom(1.2);
      else if (full && (e.key === '-' || e.key === '_')) cmd.current?.zoom(1 / 1.2);
      else if (full && e.key === '0') cmd.current?.reset();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleFull, full]);
  useEffect(() => { if (!full) setSelected(null); }, [full]);

  // ---------- the engine ----------
  useEffect(() => {
    const canvas = canvasRef.current!, wrap = wrapRef.current!;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const ns = brainNeurons(NEURONS);
    const adj = synapses(ns);
    const edges: Array<[number, number]> = [];
    adj.forEach((js, i) => js.forEach((j) => { if (j > i) edges.push([i, j]); }));
    const N = ns.length;
    // Outward surface normals (for rim light: neurons on the silhouette glow brighter, so the shape reads clearly).
    const nrm = ns.map(({ p: [x, y, z], part }) => {
      const v = part === 'cortex' ? [(x - Math.sign(x) * 0.34) / 0.31, (y - 0.12) / 0.41, z / 0.96]
        : part === 'cerebellum' ? [x / 0.25, (y + 0.42) / 0.05, (z + 0.6) / 0.09] : [0, 0, 0];
      const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
      return [v[0]! / l, v[1]! / l, v[2]! / l] as const;
    });
    const rim = new Float32Array(N);
    const px = new Float32Array(N), py = new Float32Array(N), pz = new Float32Array(N), ps = new Float32Array(N);
    const flash = new Float32Array(N);
    const scheduled: Array<{ i: number; at: number; v: number }> = [];
    let signals: Signal[] = [];
    let anchors: number[] = [], owner: number[] = [], anchorKey = '';
    let w = 0, h = 0, dpr = 1, raf = 0, running = false, visible = true, last = performance.now();
    let { yaw, pitch, zoom } = camRef.current, zoomTarget = zoom, autoPausedUntil = 0, spawnAcc = 0;
    setZoomPct(Math.round(zoom * 100));
    const screen = new Map<string, { x: number; y: number; r: number; front: boolean }>();
    let hover: string | null = null;

    const layout = () => {
      const key = live.current.listed.map((p) => p.slug).join(',');
      if (key === anchorKey) return;
      anchorKey = key;
      anchors = projectAnchors(ns, live.current.listed.length);
      owner = regions(ns, anchors);
    };

    const spawn = (from: number, hops: number, color: RGB, speed = 1, bright = 0.8) => {
      const nb = adj[from];
      if (!nb || !nb.length || signals.length > 220) return;
      signals.push({ a: from, b: nb[Math.floor(Math.random() * nb.length)]!, t: 0, hops, speed: speed * (0.7 + Math.random() * 0.6), color, bright });
    };

    const cascade = (from: number, now: number, color: RGB) => {
      const seen = new Set([from]);
      let ring = [from];
      for (let d = 0; d < 8 && ring.length; d++) {
        const next: number[] = [];
        for (const i of ring) {
          scheduled.push({ i, at: now + d * 75, v: 1 - d * 0.1 });
          for (const j of adj[i]!) if (!seen.has(j)) { seen.add(j); next.push(j); }
        }
        ring = next.slice(0, 60);
      }
      scheduled.sort((a, b) => a.at - b.at);
      for (let k = 0; k < 14; k++) spawn(from, 7 + Math.floor(Math.random() * 6), color, 1.4, 1);
    };

    function frame(now: number) {
      const dt = Math.min(64, now - last); last = now;
      const { listed, heat, activity } = live.current;
      layout();
      const c = ctx!;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.globalCompositeOperation = 'source-over';
      c.clearRect(0, 0, w, h);
      if (!reduced && now > autoPausedUntil) yaw += dt * 0.00009 * (1 + activity * 0.8);
      zoom += (zoomTarget - zoom) * Math.min(1, dt / 120);
      const narrow = w < 640;
      const cx = w / 2, cy = h / 2 + (narrow ? 18 : 6);
      const S = Math.min(w * (narrow ? 0.36 : live.current.full ? 0.32 : 0.3), h * (live.current.full ? 0.42 : 0.4)) * zoom;
      const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
      for (let i = 0; i < N; i++) {
        const [x0, y0, z0] = ns[i]!.p;
        const x1 = x0 * cyw + z0 * syw, z1 = -x0 * syw + z0 * cyw;
        const y2 = y0 * cp - z1 * sp, z2 = y0 * sp + z1 * cp;
        const s = FOCAL / (FOCAL - z2);
        px[i] = cx + x1 * S * s; py[i] = cy - y2 * S * s; pz[i] = z2; ps[i] = s;
        const [nx, ny, nz] = nrm[i]!;
        const nz2 = ny * sp + (-nx * syw + nz * cyw) * cp;
        rim[i] = nx || ny || nz ? (1 - Math.abs(nz2)) ** 2 : 0;
      }
      camRef.current = { yaw, pitch, zoom: zoomTarget };

      // ambient glow: brighter and faster breathing when the brain is busy
      const breath = reduced ? 0.7 : 0.62 + 0.1 * Math.sin(now / (1400 - 500 * activity));
      let g = c.createRadialGradient(cx, cy, 0, cx, cy, S * 1.7);
      g.addColorStop(0, rgba(TEAL, (0.1 + 0.16 * activity) * breath)); g.addColorStop(0.5, rgba(VIOLET, 0.07 * breath)); g.addColorStop(1, rgba(VIOLET, 0));
      c.fillStyle = g; c.fillRect(0, 0, w, h);

      // synapses in three depth bands, then the lit regions on top
      c.lineWidth = 0.6;
      for (let band = 0; band < 3; band++) {
        c.strokeStyle = rgba(band === 2 ? TEAL : VIOLET, [0.04, 0.07, 0.12][band]!);
        c.beginPath();
        for (const [a, b] of edges) {
          const d = (pz[a]! + pz[b]!) / 2;
          if ((d < -0.3 ? 0 : d < 0.3 ? 1 : 2) !== band) continue;
          c.moveTo(px[a]!, py[a]!); c.lineTo(px[b]!, py[b]!);
        }
        c.stroke();
      }
      const glows = listed.map((p) => heat.get(p.slug)?.glow ?? 0);
      c.globalCompositeOperation = 'lighter';
      c.lineWidth = 0.9;
      for (let k = 0; k < listed.length; k++) {
        const gl = glows[k]!;
        if (gl < 0.12) continue;
        c.strokeStyle = rgba(heatColor(gl), 0.08 + 0.32 * gl);
        c.beginPath();
        for (const [a, b] of edges) if (owner[a] === k && owner[b] === k) { c.moveTo(px[a]!, py[a]!); c.lineTo(px[b]!, py[b]!); }
        c.stroke();
      }

      // neurons (cascade flashes fire on schedule)
      while (scheduled.length && scheduled[0]!.at <= now) { const s = scheduled.shift()!; flash[s.i] = Math.min(1.5, flash[s.i]! + s.v); }
      const decay = Math.exp(-dt / 260);
      for (let i = 0; i < N; i++) {
        const n = ns[i]!;
        const depth = (pz[i]! + 1.1) / 2.2;
        const k = owner[i] ?? -1;
        const gl = k >= 0 ? glows[k]! : 0;
        const col = k >= 0 && gl > 0.1 ? heatColor(gl) : n.part === 'cortex' ? (i % 5 ? TEAL : VIOLET) : VIOLET;
        const base = n.part === 'inner' ? 0.1 : n.part === 'stem' ? 0.25 : 0.2;
        const f = flash[i]!;
        const a = Math.min(1, (base + 0.6 * depth) * (0.55 + 0.45 * Math.max(gl, 0.2)) + rim[i]! * 0.4 * (0.4 + depth) + f * 0.8);
        const r = (0.55 + 1.2 * depth) * ps[i]! * Math.sqrt(zoom) * (1 + gl * 0.5 + f * 0.9);
        c.fillStyle = rgba(f > 0.05 ? WHITE : col, a);
        c.beginPath(); c.arc(px[i]!, py[i]!, r, 0, Math.PI * 2); c.fill();
        flash[i] = f * decay;
      }

      // signals: mostly from lit regions, weighted by how hot they are; live regions keep firing
      if (!reduced) {
        spawnAcc += (dt / 1000) * (1.2 + 14 * activity);
        const total = glows.reduce((s, x) => s + x * x, 0);
        while (spawnAcc >= 1) {
          spawnAcc -= 1;
          let from = Math.floor(Math.random() * N);
          if (total > 0.02 && Math.random() < 0.7) {
            let r = Math.random() * total, k = 0;
            for (; k < glows.length - 1 && r > glows[k]! ** 2; k++) r -= glows[k]! ** 2;
            from = anchors[k] ?? from;
          }
          const k = owner[from] ?? -1;
          spawn(from, 4 + Math.floor(Math.random() * 6), k >= 0 ? heatColor(Math.max(0.4, glows[k]!)) : TEAL, 1, 0.7);
        }
        listed.forEach((p, k) => { if (heat.get(p.slug)?.live && Math.random() < dt / 450) spawn(anchors[k]!, 8, WHITE, 1.3, 1); });
      }
      const next: Signal[] = [];
      c.lineWidth = 1.6;
      for (const s of signals) {
        const la = ns[s.a]!.p, lb = ns[s.b]!.p;
        const len = Math.max(0.03, Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]));
        s.t += (dt / 1000) * s.speed * 1.1 / len;
        const t = Math.min(1, s.t), t0 = Math.max(0, t - 0.45);
        const x = px[s.a]! + (px[s.b]! - px[s.a]!) * t, y = py[s.a]! + (py[s.b]! - py[s.a]!) * t;
        const x0 = px[s.a]! + (px[s.b]! - px[s.a]!) * t0, y0 = py[s.a]! + (py[s.b]! - py[s.a]!) * t0;
        const depth = (pz[s.b]! + 1.1) / 2.2;
        c.strokeStyle = rgba(s.color, 0.5 * s.bright * depth);
        c.beginPath(); c.moveTo(x0, y0); c.lineTo(x, y); c.stroke();
        c.fillStyle = rgba(WHITE, s.bright * (0.5 + 0.5 * depth));
        c.beginPath(); c.arc(x, y, 1.6 + 0.8 * depth, 0, Math.PI * 2); c.fill();
        if (s.t >= 1) {
          flash[s.b] = Math.min(1.5, flash[s.b]! + 0.45 * s.bright);
          if (s.hops > 0) {
            const nb = adj[s.b]!.filter((j) => j !== s.a);
            if (nb.length) next.push({ ...s, a: s.b, b: nb[Math.floor(Math.random() * nb.length)]!, t: 0, hops: s.hops - 1, bright: s.bright * 0.93 });
          }
        } else next.push(s);
      }
      signals = next;

      // project nuclei, back to front
      screen.clear();
      c.globalCompositeOperation = 'source-over';
      const order = listed.map((p, k) => ({ p, i: anchors[k]! })).filter((x) => x.i !== undefined).sort((a, b) => pz[a.i]! - pz[b.i]!);
      for (const { p, i } of order) {
        const ht = heat.get(p.slug);
        const gl = ht?.glow ?? 0;
        const col = heatColor(gl);
        const front = pz[i]! > -0.25;
        const dim = front ? 1 : 0.4;
        const lit = hover === p.slug || live.current.selected === p.slug;
        const r = (3 + 5 * gl) * ps[i]! * Math.sqrt(zoom) * (lit ? 1.3 : 1);
        const halo = r * (3 + 4 * gl);
        g = c.createRadialGradient(px[i]!, py[i]!, 0, px[i]!, py[i]!, halo);
        g.addColorStop(0, rgba(col, (0.25 + 0.6 * gl) * dim)); g.addColorStop(1, rgba(col, 0));
        c.fillStyle = g; c.beginPath(); c.arc(px[i]!, py[i]!, halo, 0, Math.PI * 2); c.fill();
        c.fillStyle = rgba(gl > 0.6 ? WHITE : col, (0.75 + 0.25 * gl) * dim);
        c.beginPath(); c.arc(px[i]!, py[i]!, r, 0, Math.PI * 2); c.fill();
        c.strokeStyle = rgba(gl > 0.3 ? WHITE : [196, 188, 255], (0.35 + 0.3 * gl) * dim); c.lineWidth = 1;
        c.beginPath(); c.arc(px[i]!, py[i]!, r + 2.5, 0, Math.PI * 2); c.stroke();
        if (ht?.live && !reduced) {
          const ph = (now % 1600) / 1600;
          c.strokeStyle = rgba(WHITE, (1 - ph) * 0.8 * dim); c.lineWidth = 1.4;
          c.beginPath(); c.arc(px[i]!, py[i]!, r + 4 + ph * 22, 0, Math.PI * 2); c.stroke();
        }
        if (live.current.selected === p.slug) { c.strokeStyle = rgba(WHITE, 0.9); c.lineWidth = 1.2; c.beginPath(); c.arc(px[i]!, py[i]!, r + 6, 0, Math.PI * 2); c.stroke(); }
        screen.set(p.slug, { x: px[i]!, y: py[i]!, r: Math.max(9, r + 5), front });
      }

      // incoming lights (a save / a tool call on its way to its region), then a cascade
      c.globalCompositeOperation = 'lighter';
      incomingRef.current = incomingRef.current.filter((inc) => {
        const target = screen.get(inc.slug);
        const idx = listed.findIndex((p) => p.slug === inc.slug);
        if (!target || idx < 0) return false;
        const k = reduced ? 1 : (now - inc.start) / 1300;
        if (k >= 1) { cascade(anchors[idx]!, now, heatColor(Math.max(0.5, glows[idx] ?? 0.5))); return false; }
        const ox = ORIGIN[inc.source][0] * w, oy = ORIGIN[inc.source][1] * h;
        const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
        const qx = (ox + target.x) / 2, qy = Math.min(oy, target.y) - S * 0.35;
        for (let j = 10; j >= 0; j--) {
          const u = Math.max(0, e - j * 0.02);
          const x = (1 - u) ** 2 * ox + 2 * (1 - u) * u * qx + u * u * target.x;
          const y = (1 - u) ** 2 * oy + 2 * (1 - u) * u * qy + u * u * target.y;
          c.fillStyle = rgba(WHITE, (1 - j / 11) * 0.95);
          c.beginPath(); c.arc(x, y, 3.6 - j * 0.28, 0, Math.PI * 2); c.fill();
        }
        return true;
      });
      c.globalCompositeOperation = 'source-over';

      // labels: hovered / selected first, then live, then the hottest front regions; never overlapping
      c.font = `500 ${narrow ? 10.5 : 11.5}px Inter, system-ui, sans-serif`;
      const isFocus = (slug: string) => slug === hover || slug === live.current.selected;
      const cands = listed
        .map((p) => ({ p, s: screen.get(p.slug), gl: heat.get(p.slug)?.glow ?? 0, lv: !!heat.get(p.slug)?.live }))
        .filter((x): x is typeof x & { s: NonNullable<typeof x.s> } => !!x.s && (x.s.front || isFocus(x.p.slug)))
        .sort((a, b) => Number(isFocus(b.p.slug)) - Number(isFocus(a.p.slug)) || Number(b.lv) - Number(a.lv) || b.gl - a.gl);
      const maxLabels = live.current.full ? 14 : narrow ? 4 : 8;
      const boxes = cands.filter((x, n) => isFocus(x.p.slug) || x.lv || x.gl > 0.12 || live.current.full || n < 3).slice(0, maxLabels + 6).map((x) => {
        const text = shortName(x.p.name, narrow ? 18 : 26);
        const tw = c.measureText(text).width + 14;
        const bx = x.s.x < cx ? x.s.x - x.s.r - tw - 2 : x.s.x + x.s.r + 2;
        return { ...x, text, w: tw, h: 20, x: Math.max(4, Math.min(w - tw - 4, bx)), y: x.s.y - 10 };
      });
      c.textAlign = 'left'; c.textBaseline = 'middle';
      for (const b of placeLabels(boxes).slice(0, maxLabels)) {
        c.fillStyle = 'rgba(8,7,26,0.74)';
        c.beginPath(); c.roundRect(b.x, b.y, b.w, b.h, 10); c.fill();
        c.strokeStyle = rgba(heatColor(b.gl), 0.3 + 0.45 * b.gl); c.lineWidth = 1; c.stroke();
        c.fillStyle = 'rgba(243,242,255,0.94)';
        c.fillText(b.text, b.x + 7, b.y + 10.5);
      }

      // the hover card follows its node
      const t = tipRef.current;
      if (t) {
        const s = hover && !(live.current.full && hover === live.current.selected) ? screen.get(hover) : null; // the panel already shows it
        if (s) {
          const left = Math.max(8, Math.min(w - 252, s.x + 16)), top = Math.max(8, Math.min(h - 124, s.y + 14));
          t.style.transform = `translate(${left}px, ${top}px)`; t.style.opacity = '1';
        } else t.style.opacity = '0';
      }
    }

    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = wrap.clientWidth; h = wrap.clientHeight;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
      if (!running) frame(performance.now());
    };
    const loop = (now: number) => { frame(now); raf = running ? requestAnimationFrame(loop) : 0; };
    const setRunning = (on: boolean) => {
      if (on && !running) { running = true; last = performance.now(); raf = requestAnimationFrame(loop); }
      if (!on && running) { running = false; cancelAnimationFrame(raf); }
    };
    const ro = new ResizeObserver(resize); ro.observe(wrap); resize();
    const io = new IntersectionObserver(([e]) => { visible = !!e?.isIntersecting; setRunning(visible && document.visibilityState === 'visible'); });
    io.observe(wrap);
    const onVis = () => setRunning(visible && document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    setRunning(true);

    // ---------- input: drag to turn, pinch / buttons / wheel to zoom, click a region ----------
    const redraw = () => { if (!running) frame(performance.now()); };
    const setZoom = (z: number) => { zoomTarget = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z)); setZoomPct(Math.round(zoomTarget * 100)); autoPausedUntil = performance.now() + 2500; redraw(); };
    cmd.current = { zoom: (f) => setZoom(zoomTarget * f), reset: () => { pitch = 0.22; setZoom(1); } };
    const hit = (mx: number, my: number) => {
      let best: string | null = null, bd = Infinity;
      for (const [slug, s] of screen) { const d = Math.hypot(s.x - mx, s.y - my); if (d < s.r + 6 && d < bd && (s.front || d < s.r)) { best = slug; bd = d; } }
      return best;
    };
    const pointers = new Map<number, { x: number; y: number }>();
    let downAt: { x: number; y: number } | null = null, dragged = false, pinch0 = 0, zoom0 = 1;
    const local = (e: PointerEvent | MouseEvent) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const setHover = (slug: string | null) => {
      if (slug === hover) return;
      hover = slug;
      canvas.style.cursor = slug ? 'pointer' : 'grab';
      const p = slug ? live.current.listed.find((x) => x.slug === slug) : undefined;
      setTip(p ? { name: p.name, heat: live.current.heat.get(p.slug), project: p } : null);
      redraw();
    };
    const onDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, local(e));
      if (pointers.size === 1) { downAt = local(e); dragged = false; }
      if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch0 = Math.hypot(a!.x - b!.x, a!.y - b!.y); zoom0 = zoomTarget; }
    };
    const onMove = (e: PointerEvent) => {
      const p = local(e);
      const prev = pointers.get(e.pointerId);
      if (prev) {
        pointers.set(e.pointerId, p);
        if (pointers.size === 2) {
          const [a, b] = [...pointers.values()];
          if (pinch0 > 0) setZoom(zoom0 * Math.hypot(a!.x - b!.x, a!.y - b!.y) / pinch0);
          dragged = true;
          return;
        }
        if (downAt && Math.hypot(p.x - downAt.x, p.y - downAt.y) > 5) dragged = true;
        if (dragged) {
          yaw += (p.x - prev.x) * 0.006;
          pitch = Math.max(-0.9, Math.min(0.9, pitch + (p.y - prev.y) * 0.004));
          autoPausedUntil = performance.now() + 4000;
          canvas.style.cursor = 'grabbing';
          redraw();
          return;
        }
      }
      if (e.pointerType === 'mouse') setHover(hit(p.x, p.y));
    };
    const onUp = (e: PointerEvent) => {
      const p = local(e);
      pointers.delete(e.pointerId);
      if (pointers.size === 0) {
        if (!dragged) {
          const slug = hit(p.x, p.y);
          if (live.current.full) { setSelected(slug); setHover(slug); }
          else if (slug && (e.pointerType === 'mouse' || hover === slug)) openRef.current(slug); // touch: 1st tap = card, 2nd = open
          else setHover(slug);
        }
        canvas.style.cursor = hover ? 'pointer' : 'grab';
        downAt = null;
      }
      if (pointers.size < 2) pinch0 = 0;
    };
    const onLeave = () => { if (!pointers.size) setHover(null); };
    const onWheel = (e: WheelEvent) => {
      if (!live.current.full && !e.ctrlKey) return; // on the page the wheel scrolls; Ctrl+wheel (trackpad pinch) zooms
      e.preventDefault();
      setZoom(zoomTarget * Math.exp(-e.deltaY * 0.0015));
    };
    const onDbl = (e: MouseEvent) => { const p = local(e); const s = hit(p.x, p.y); if (s) openRef.current(s); };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDbl);
    canvas.style.cursor = 'grab';
    return () => {
      setRunning(false); ro.disconnect(); io.disconnect(); cmd.current = null;
      document.removeEventListener('visibilitychange', onVis);
      canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerleave', onLeave); canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('dblclick', onDbl);
    };
  }, [full]);

  const sel = selected ? listed.find((p) => p.slug === selected) : null;
  const selHeat = sel ? heat.get(sel.slug) : undefined;
  const ctl = 'flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-[#0b0a1f]/70 text-[var(--color-muted)] backdrop-blur hover:border-[#5eead4]/50 hover:text-white';

  const body = (
    <div ref={wrapRef}
      className={clsx('w-full overflow-hidden', full ? 'fixed inset-0 z-[80] h-[100dvh]' : `relative ${className}`)}
      style={{ background: 'radial-gradient(120% 90% at 50% 45%, #0f1a3a 0%, #0b0a1f 55%, #05040f 100%)', touchAction: 'pan-y' }}>
      <canvas ref={canvasRef} role="img" aria-label="Brain activity map; the same projects are listed below" className="absolute inset-0 block select-none" style={{ touchAction: full ? 'none' : 'pan-y' }} />
      {children}

      {/* hover card (the animation loop moves it) */}
      <div ref={tipRef} aria-hidden className="pointer-events-none absolute left-0 top-0 z-10 w-60 rounded-2xl border border-white/10 bg-[#0b0a1f]/85 p-3 opacity-0 shadow-xl backdrop-blur transition-opacity duration-150">
        {tip && (
          <>
            <p className="truncate text-sm font-semibold">{tip.name}</p>
            <p className="mt-0.5 text-xs" style={{ color: rgb(heatColor(tip.heat?.glow ?? 0)) }}>
              {heatLabel(tip.heat ?? { glow: 0, live: false })}{tip.heat?.count24h ? ` · ${tip.heat.count24h} events in 24 h` : ''}
            </p>
            <p className="mt-1 text-[11px] text-[var(--color-muted)]">
              {tip.heat?.lastTs ? `last change ${ago(new Date(tip.heat.lastTs).toISOString())}` : `active ${dayAgo(tip.project.last_activity)}`} · {tip.project.open_next_steps} open steps
            </p>
            <p className="mt-1.5 text-[10.5px] text-[var(--color-dim)]">{full ? 'Click for details · double-click to open' : 'Click to open'}</p>
          </>
        )}
      </div>

      {/* controls */}
      <div className={clsx('absolute right-3 z-20 flex gap-2 sm:flex-col', full ? 'bottom-[4.5rem] sm:bottom-6 sm:right-6' : 'bottom-[4.25rem] sm:bottom-4')}>
        <button className={ctl} onClick={() => cmd.current?.zoom(1.25)} aria-label="Zoom in" title="Zoom in"><Plus size={16} /></button>
        <button className={ctl} onClick={() => cmd.current?.zoom(0.8)} aria-label="Zoom out" title="Zoom out"><Minus size={16} /></button>
        <button className={ctl} onClick={() => cmd.current?.reset()} aria-label={`Reset view (${zoomPct}%)`} title={`Reset view (${zoomPct}%)`}><RotateCcw size={15} /></button>
        <button className={ctl} onClick={toggleFull} aria-label={full ? 'Exit full screen' : 'Full screen'} title={full ? 'Exit full screen (F)' : 'Full screen (F)'}>{full ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
      </div>

      {/* legend */}
      <div className={clsx('pointer-events-none absolute z-10 items-center gap-3 font-mono text-[10.5px] text-[var(--color-dim)]', full ? 'bottom-6 left-6 hidden sm:flex' : 'bottom-4 left-4 hidden xl:flex')}>
        {([['Idle', 0.05], ['Warm', 0.35], ['Busy', 0.75], ['Active now', 1]] as const).map(([l, gv]) => (
          <span key={l} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: rgb(heatColor(gv)), boxShadow: `0 0 8px ${rgb(heatColor(gv))}` }} />{l}</span>
        ))}
        {full && <span className="ml-3 hidden lg:inline">Drag to turn · scroll to zoom · F or Esc to exit</span>}
      </div>

      {/* full screen: the selected region */}
      {full && sel && (
        <aside className="absolute right-3 top-24 z-20 w-[min(22rem,calc(100vw-1.5rem))] rounded-3xl border border-white/10 bg-[#0b0a1f]/85 p-5 shadow-2xl backdrop-blur sm:right-6">
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-lg font-semibold leading-tight">{sel.name}</h3>
            <button onClick={() => setSelected(null)} aria-label="Close" className="text-[var(--color-muted)] hover:text-white"><X size={18} /></button>
          </div>
          <p className="mt-1 text-sm" style={{ color: rgb(heatColor(selHeat?.glow ?? 0)) }}>{heatLabel(selHeat ?? { glow: 0, live: false })}</p>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${Math.max(4, Math.round((selHeat?.glow ?? 0) * 100))}%`, background: `linear-gradient(90deg, ${rgb(heatColor(0.2))}, ${rgb(heatColor(selHeat?.glow ?? 0))})` }} />
          </div>
          {sel.status && <p className="mt-3 line-clamp-4 text-sm text-[#d9d7f5]">{sel.status.replace(/^[-*]\s*/gm, '').split('\n').join(' · ')}</p>}
          <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
            {([['24 h', selHeat?.count24h ?? 0], ['Sessions', sel.sessions], ['Open steps', sel.open_next_steps]] as const).map(([k, v]) => (
              <div key={k} className="rounded-xl bg-white/5 py-2"><dd className="text-lg font-semibold">{v}</dd><dt className="text-[10.5px] text-[var(--color-dim)]">{k}</dt></div>
            ))}
          </dl>
          <button onClick={() => onOpen(sel.slug)} className="mt-4 inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-[var(--color-primary)] text-sm font-medium hover:bg-[var(--color-primary-hover)]">Open project <ArrowUpRight size={15} /></button>
        </aside>
      )}
    </div>
  );
  return full && typeof document !== 'undefined' ? createPortal(body, document.body) : body;
}
