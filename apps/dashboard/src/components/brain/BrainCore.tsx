'use client';
// The Brain Core (docs/16-BRAIN.md "UI" §1): a slowly turning neural sphere with the projects orbiting it. Node size =
// memory volume, brightness = recent activity, colour = platform. Each save fires a light pulse from where it came
// from (Claude, the PC, an agent, you) to its project, which then flashes. Plain 2D canvas with a 3D projection: no
// WebGL library, cheap on phones. Reduced motion → one still frame. Paused while off screen or the tab is hidden.
import { useEffect, useMemo, useRef } from 'react';
import { coreNodes, sourceOf, spherePoints, pulses as isPulse, type BrainEvent, type BrainProject, type CoreNode, type Source } from '@/lib/brainView';

const TEAL = [94, 234, 212] as const;
const VIOLET = [167, 139, 250] as const;
const POINTS = 360;
const FOCAL = 4.2;

type Vec = [number, number, number];
interface Pulse { slug: string; source: Source; start: number }
interface Flash { slug: string; start: number }

const rotY = ([x, y, z]: Vec, a: number): Vec => [x * Math.cos(a) + z * Math.sin(a), y, -x * Math.sin(a) + z * Math.cos(a)];
const rotX = ([x, y, z]: Vec, a: number): Vec => [x, y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)];
const rgba = (c: readonly number[], a: number) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
const hexRgb = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)] as const;

/** Where a pulse enters the frame, per source (fractions of width/height). */
const ORIGIN: Record<Source, [number, number]> = { claude: [0.02, 0.18], pc: [0.98, 0.3], agent: [0.5, 0.02], julev: [0.5, 0.98], service: [0.98, 0.9] };
const PULSE_MS = 1500;
const FLASH_MS = 1100;

export function BrainCore({ projects, events, onOpen, className = 'h-[420px]' }: {
  projects: BrainProject[]; events: BrainEvent[]; onOpen: (slug: string) => void; className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const nodes = useMemo(() => coreNodes(projects), [projects]);
  const nodesRef = useRef<CoreNode[]>(nodes);
  nodesRef.current = nodes;
  const pulseRef = useRef<Pulse[]>([]);
  const flashRef = useRef<Flash[]>([]);
  const seenRef = useRef<Set<number> | null>(null);
  const hoverRef = useRef<string | null>(null);
  const screenRef = useRef<Map<string, { x: number; y: number; r: number }>>(new Map());
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  // New events (not the ones present on first render) become pulses.
  useEffect(() => {
    if (!seenRef.current) { seenRef.current = new Set(events.map((e) => e.id)); return; }
    const now = performance.now();
    for (const e of events) {
      if (seenRef.current.has(e.id)) continue;
      seenRef.current.add(e.id);
      if (isPulse(e) && nodesRef.current.some((n) => n.slug === e.project_slug)) pulseRef.current.push({ slug: e.project_slug!, source: sourceOf(e.actor), start: now });
    }
  }, [events]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const pts = spherePoints(POINTS);
    // Each point's two nearest neighbours: the faint "synapse" mesh (computed once).
    const edges: Array<[number, number]> = [];
    for (let i = 0; i < pts.length; i++) {
      const d = pts.map((p, j) => [j, (p[0] - pts[i]![0]) ** 2 + (p[1] - pts[i]![1]) ** 2 + (p[2] - pts[i]![2]) ** 2] as const).filter(([j]) => j > i).sort((a, b) => a[1] - b[1]);
      for (const [j] of d.slice(0, 2)) edges.push([i, j]);
    }
    let w = 0, h = 0, dpr = 1, raf = 0, visible = true, running = false;
    const t0 = performance.now();
    let spark = { edge: 0, start: -1e9 };

    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = wrap.clientWidth; h = wrap.clientHeight;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
      if (!running) draw(performance.now());
    };

    function draw(now: number) {
      const t = reduced ? 8000 : now - t0;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.clearRect(0, 0, w, h);
      // Phones: smaller orbits so the outer ring stays on screen, and the core sits lower (the HUD stats are on top).
      const narrow = w < 640;
      const cx = w / 2, cy = h / 2 + (narrow ? 26 : 0);
      const R = narrow ? Math.min(w * 0.165, h * 0.17) : Math.min(w, h) * 0.2;
      const stretch = narrow ? 1 : Math.min(1.9, Math.max(1, (w * 0.46) / (2.2 * R)));   // wide screens: flatter, wider orbits
      const spin = t * 0.00011;
      const tilt = 0.38;
      const project = (v: Vec, sx = 1): [number, number, number] => {
        const s = FOCAL / (FOCAL - v[2]);
        return [cx + v[0] * R * s * sx, cy + v[1] * R * s, s];
      };

      // core glow (breathing)
      const breath = reduced ? 0.6 : 0.55 + 0.08 * Math.sin(t / 1300);
      let g = ctx!.createRadialGradient(cx, cy, 0, cx, cy, R * 1.9);
      g.addColorStop(0, rgba(TEAL, 0.22 * breath)); g.addColorStop(0.45, rgba(VIOLET, 0.09 * breath)); g.addColorStop(1, rgba(VIOLET, 0));
      ctx!.fillStyle = g; ctx!.fillRect(0, 0, w, h);
      g = ctx!.createRadialGradient(cx, cy, 0, cx, cy, R * 0.42);
      g.addColorStop(0, rgba([230, 255, 250], 0.55 * breath)); g.addColorStop(1, rgba(TEAL, 0));
      ctx!.fillStyle = g; ctx!.beginPath(); ctx!.arc(cx, cy, R * 0.42, 0, Math.PI * 2); ctx!.fill();

      // sphere
      const sp = pts.map((p) => rotX(rotY(p, spin), tilt));
      const pr = sp.map((v) => project(v));
      ctx!.lineWidth = 0.6;
      for (const [a, b] of edges) {
        const depth = (sp[a]![2] + sp[b]![2]) / 2;
        ctx!.strokeStyle = rgba(TEAL, 0.03 + 0.09 * (depth + 1) / 2);
        ctx!.beginPath(); ctx!.moveTo(pr[a]![0], pr[a]![1]); ctx!.lineTo(pr[b]![0], pr[b]![1]); ctx!.stroke();
      }
      if (!reduced && t - spark.start > 260) spark = { edge: Math.floor(Math.random() * edges.length), start: t };
      const sa = Math.max(0, 1 - (t - spark.start) / 700);
      if (sa > 0) {
        const [a, b] = edges[spark.edge]!;
        ctx!.strokeStyle = rgba([220, 255, 250], 0.8 * sa); ctx!.lineWidth = 1.2;
        ctx!.beginPath(); ctx!.moveTo(pr[a]![0], pr[a]![1]); ctx!.lineTo(pr[b]![0], pr[b]![1]); ctx!.stroke();
      }
      for (let i = 0; i < sp.length; i++) {
        const depth = (sp[i]![2] + 1) / 2;
        ctx!.fillStyle = rgba(i % 7 === 0 ? VIOLET : TEAL, 0.18 + 0.72 * depth);
        ctx!.beginPath(); ctx!.arc(pr[i]![0], pr[i]![1], 0.5 + 1.3 * depth * pr[i]![2], 0, Math.PI * 2); ctx!.fill();
      }

      // orbit rings
      ctx!.lineWidth = 1;
      for (const orbit of [1.5, 1.78, 2.05]) {
        ctx!.strokeStyle = rgba(VIOLET, 0.07);
        ctx!.beginPath();
        for (let k = 0; k <= 72; k++) {
          const a = (k / 72) * Math.PI * 2;
          const [x, y] = project(rotX([Math.cos(a) * orbit, 0, Math.sin(a) * orbit], tilt), stretch);
          if (k) ctx!.lineTo(x, y); else ctx!.moveTo(x, y);
        }
        ctx!.stroke();
      }

      // project nodes (back to front)
      const placed = nodesRef.current.map((n) => {
        const a = n.phase + (t / 1000) * n.speed;
        const v = rotX(rotX([Math.cos(a) * n.orbit, 0, Math.sin(a) * n.orbit], n.tilt * 0.35), tilt);
        const [x, y, s] = project(v, stretch);
        return { n, x, y, s, z: v[2] };
      }).sort((a, b) => a.z - b.z);
      const screen = new Map<string, { x: number; y: number; r: number }>();
      ctx!.font = '500 11px Inter, system-ui, sans-serif';
      for (const { n, x, y, s, z } of placed) {
        const c = hexRgb(n.color);
        const behind = z < 0 && Math.hypot(x - cx, y - cy) < R * 1.05;
        const hover = hoverRef.current === n.slug;
        const flash = flashRef.current.find((f) => f.slug === n.slug);
        const fa = flash ? 1 - (now - flash.start) / FLASH_MS : 0;
        const base = (behind ? 0.35 : 1) * (0.35 + 0.65 * n.glow);
        const r = n.size * s * (hover ? 1.25 : 1);
        g = ctx!.createRadialGradient(x, y, 0, x, y, r * 4.2);
        g.addColorStop(0, rgba(c, 0.55 * base + 0.4 * Math.max(0, fa))); g.addColorStop(1, rgba(c, 0));
        ctx!.fillStyle = g; ctx!.beginPath(); ctx!.arc(x, y, r * 4.2, 0, Math.PI * 2); ctx!.fill();
        ctx!.fillStyle = rgba(c, Math.min(1, 0.4 + base)); ctx!.beginPath(); ctx!.arc(x, y, r, 0, Math.PI * 2); ctx!.fill();
        if (fa > 0) {
          ctx!.strokeStyle = rgba(c, fa); ctx!.lineWidth = 1.5;
          ctx!.beginPath(); ctx!.arc(x, y, r + (1 - fa) * 26, 0, Math.PI * 2); ctx!.stroke();
        }
        if (hover || (!behind && n.glow > 0.62) || fa > 0) {
          ctx!.fillStyle = rgba([243, 242, 255], hover ? 0.95 : 0.7 * (behind ? 0.5 : 1));
          const left = x > cx + R * 1.6;
          ctx!.textAlign = left ? 'right' : 'left';
          ctx!.fillText(n.name, x + (left ? -(r + 6) : r + 6), y + 4);
        }
        screen.set(n.slug, { x, y, r: Math.max(r, 7) });
      }
      screenRef.current = screen;

      // pulses: source → node along a curve, then a flash
      if (!reduced) {
        pulseRef.current = pulseRef.current.filter((p) => {
          const target = screen.get(p.slug);
          const k = (now - p.start) / PULSE_MS;
          if (!target || k >= 1) {
            if (target) { flashRef.current = flashRef.current.filter((f) => f.slug !== p.slug); flashRef.current.push({ slug: p.slug, start: now }); }
            return false;
          }
          const [ox, oy] = [ORIGIN[p.source][0] * w, ORIGIN[p.source][1] * h];
          const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
          const qx = cx + (ox - cx) * 0.15, qy = cy + (oy - cy) * 0.15 - R * 0.6;
          const at = (u: number): [number, number] => [(1 - u) ** 2 * ox + 2 * (1 - u) * u * qx + u * u * target.x, (1 - u) ** 2 * oy + 2 * (1 - u) * u * qy + u * u * target.y];
          for (let i = 8; i >= 0; i--) {
            const u = Math.max(0, e - i * 0.018);
            const [px, py] = at(u);
            ctx!.fillStyle = rgba([220, 255, 250], (1 - i / 9) * 0.9);
            ctx!.beginPath(); ctx!.arc(px, py, 3.2 - i * 0.3, 0, Math.PI * 2); ctx!.fill();
          }
          return true;
        });
        flashRef.current = flashRef.current.filter((f) => now - f.start < FLASH_MS);
      }
    }

    const loop = (now: number) => {
      draw(now);
      raf = running ? requestAnimationFrame(loop) : 0;
    };
    const setRunning = (on: boolean) => {
      if (reduced) { draw(performance.now()); return; }
      if (on && !running) { running = true; raf = requestAnimationFrame(loop); }
      if (!on && running) { running = false; cancelAnimationFrame(raf); }
    };

    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();
    const io = new IntersectionObserver(([e]) => { visible = !!e?.isIntersecting; setRunning(visible && document.visibilityState === 'visible'); });
    io.observe(wrap);
    const onVis = () => setRunning(visible && document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    setRunning(true);

    const hit = (ev: PointerEvent | MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
      let best: string | null = null, bd = Infinity;
      for (const [slug, p] of screenRef.current) {
        const d = Math.hypot(p.x - mx, p.y - my);
        if (d < p.r + 10 && d < bd) { best = slug; bd = d; }
      }
      return best;
    };
    const onMove = (ev: PointerEvent) => {
      const s = hit(ev);
      if (s !== hoverRef.current) { hoverRef.current = s; canvas.style.cursor = s ? 'pointer' : 'default'; if (reduced) draw(performance.now()); }
    };
    const onClick = (ev: MouseEvent) => { const s = hit(ev); if (s) openRef.current(s); };
    const onLeave = () => { hoverRef.current = null; canvas.style.cursor = 'default'; };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('click', onClick);
    canvas.addEventListener('pointerleave', onLeave);
    return () => {
      setRunning(false); ro.disconnect(); io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      canvas.removeEventListener('pointermove', onMove); canvas.removeEventListener('click', onClick); canvas.removeEventListener('pointerleave', onLeave);
    };
  }, []);

  return (
    <div ref={wrapRef} className={`relative w-full ${className}`}>
      {/* Decorative: the same projects are listed (and keyboard reachable) below the core. */}
      <canvas ref={canvasRef} aria-hidden className="absolute inset-0 block" />
    </div>
  );
}
