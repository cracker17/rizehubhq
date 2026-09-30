// The Brain Core's model (components/brain/BrainCore.tsx): how lit each project's region is (activity heat), the
// brain-shaped neuron cloud and its synapses, where projects sit on it, and label placement. Pure and deterministic;
// covered by lib/brainNeural.test.ts.
import { recency, type BrainEvent, type BrainProject } from './brainView';

// ---------- activity heat ----------
/** How much each kind of event warms its project. Syncs and index runs are bookkeeping: they warm nothing. */
export const HEAT_WEIGHT: Record<string, number> = { saved: 1, doc_added: 0.8, doc_changed: 0.6, connected: 0.5, tool_call: 0.35, revoked: 0.3 };
export const HEAT_HALF_LIFE_MS = 3 * 3600_000;
export const LIVE_WINDOW_MS = 10 * 60_000;

export interface Heat { heat: number; glow: number; live: boolean; lastTs: number | null; count24h: number }

/**
 * Per project: heat = Σ weight · 2^(−age / 3 h); glow = 1 − e^(−heat) (0..1); live = anything in the last 10 minutes.
 * Projects with no events keep a faint floor from their last-activity date.
 */
export function projectHeat(projects: BrainProject[], events: BrainEvent[], now = Date.now()): Map<string, Heat> {
  const out = new Map<string, Heat>();
  for (const p of projects) out.set(p.slug, { heat: 0, glow: 0.04 + 0.06 * recency(p.last_activity, now), live: false, lastTs: null, count24h: 0 });
  for (const e of events) {
    if (!e.project_slug) continue;
    const h = out.get(e.project_slug);
    const w = HEAT_WEIGHT[e.action];
    if (!h || !w) continue;
    const ts = new Date(e.ts).getTime();
    const age = Math.max(0, now - ts);
    h.heat += w * Math.pow(2, -age / HEAT_HALF_LIFE_MS);
    if (age < LIVE_WINDOW_MS) h.live = true;
    if (age < 86400_000) h.count24h++;
    if (h.lastTs === null || ts > h.lastTs) h.lastTs = ts;
  }
  for (const h of out.values()) if (h.heat > 0) h.glow = Math.max(h.glow, 1 - Math.exp(-h.heat));
  return out;
}

/** 0..1: how busy the whole brain is right now (events of the last ~15 minutes, tool calls included). */
export function globalActivity(events: BrainEvent[], now = Date.now()): number {
  let s = 0;
  for (const e of events) {
    const w = HEAT_WEIGHT[e.action] ?? 0;
    if (w) s += w * Math.pow(2, -Math.max(0, now - new Date(e.ts).getTime()) / (5 * 60_000));
  }
  return 1 - Math.exp(-s / 1.5);
}

export type RGB = [number, number, number];

/** Heat colour: idle violet → warm teal → hot cyan → white. */
export function heatColor(glow: number): RGB {
  const stops: Array<[number, RGB]> = [[0, [96, 86, 170]], [0.35, [45, 212, 191]], [0.75, [125, 249, 255]], [1, [240, 254, 255]]];
  const g = Math.max(0, Math.min(1, glow));
  for (let i = 1; i < stops.length; i++) {
    const [b, cb] = stops[i]!;
    const [a, ca] = stops[i - 1]!;
    if (g <= b) {
      const k = (g - a) / (b - a);
      return [0, 1, 2].map((j) => Math.round(ca[j]! + (cb[j]! - ca[j]!) * k)) as RGB;
    }
  }
  return stops[stops.length - 1]![1];
}

export const heatLabel = (h: Pick<Heat, 'glow' | 'live'>) => (h.live ? 'Active now' : h.glow > 0.55 ? 'Busy' : h.glow > 0.2 ? 'Warm' : 'Idle');

// ---------- geometry ----------
export type Vec3 = [number, number, number];
export type Part = 'cortex' | 'cerebellum' | 'stem' | 'inner';
export interface Neuron { p: Vec3; part: Part }

/** mulberry32: the brain looks the same on every load. */
export function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A brain-shaped point cloud, ~2 units front to back (x = left/right, y = up, z = front/back, front = +z): two folded
 * hemispheres with a gap down the middle and a flatter underside, the cerebellum at the back below, the brain stem,
 * and a sparse inner network.
 */
export function brainNeurons(n: number, seed = 7): Neuron[] {
  const rnd = prng(seed);
  const out: Neuron[] = [];
  const cortexN = Math.round(n * 0.72), cerebN = Math.round(n * 0.14), stemN = Math.round(n * 0.04);
  const innerN = Math.max(0, n - cortexN - cerebN - stemN);
  const half = Math.ceil(cortexN / 2);
  for (let i = 0; i < cortexN; i++) {
    const side = i % 2 ? 1 : -1;
    const k = Math.floor(i / 2);
    const dy = 1 - ((k + 0.5) / half) * 2;
    const r0 = Math.sqrt(Math.max(0, 1 - dy * dy));
    const th = k * Math.PI * (3 - Math.sqrt(5)) + (side > 0 ? 0.9 : 0);
    const dx = Math.cos(th) * r0, dz = Math.sin(th) * r0;
    // gyri: a folded surface, not a smooth egg
    const fold = 1 + 0.06 * Math.sin(11 * dz + 4 * Math.sin(7 * dy)) * Math.cos(9 * dy - 3 * dx) + 0.025 * (rnd() - 0.5);
    let x = side * 0.34 + dx * 0.56 * fold;
    let y = dy * 0.64 * fold + 0.12;
    const z = dz * 0.98 * fold;
    if (side * x < 0.05) x = side * (0.05 + (0.05 - side * x) * 0.12); // flat inner wall → the gap down the middle
    if (y < -0.3) y = -0.3 + (y + 0.3) * 0.45;                        // flatter underside
    if (z > 0.55 && y < -0.1) y += (z - 0.55) * 0.25;                  // the frontal lobe tucks up
    out.push({ p: [x, y, z], part: 'cortex' });
  }
  for (let i = 0; i < cerebN; i++) {
    const u = rnd() * Math.PI * 2, v = Math.acos(2 * rnd() - 1);
    const folia = 1 + 0.07 * Math.sin(38 * Math.cos(v));
    out.push({ p: [Math.cos(u) * Math.sin(v) * 0.5 * folia, -0.42 + Math.cos(v) * 0.22 * folia, -0.6 + Math.sin(u) * Math.sin(v) * 0.3 * folia], part: 'cerebellum' });
  }
  for (let i = 0; i < stemN; i++) {
    const t = rnd(), a = rnd() * Math.PI * 2;
    out.push({ p: [Math.cos(a) * 0.1, -0.36 - t * 0.58, -0.26 - t * 0.14 + Math.sin(a) * 0.09], part: 'stem' });
  }
  for (let i = 0; i < innerN; i++) {
    const side = rnd() < 0.5 ? -1 : 1;
    const u = rnd() * Math.PI * 2, v = Math.acos(2 * rnd() - 1), r = Math.cbrt(rnd()) * 0.8;
    out.push({ p: [side * 0.32 + Math.cos(u) * Math.sin(v) * 0.42 * r, 0.1 + Math.cos(v) * 0.5 * r, Math.sin(u) * Math.sin(v) * 0.8 * r], part: 'inner' });
  }
  return out;
}

/** Each neuron's k nearest neighbours closer than maxDist (both ways): the synapses signals travel along. */
export function synapses(ns: Neuron[], k = 3, maxDist = 0.26): number[][] {
  const adj: number[][] = ns.map(() => []);
  const max2 = maxDist * maxDist;
  for (let i = 0; i < ns.length; i++) {
    const a = ns[i]!.p;
    const best: Array<[number, number]> = [];
    for (let j = 0; j < ns.length; j++) {
      if (j === i) continue;
      const b = ns[j]!.p;
      const d = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
      if (d > max2) continue;
      if (best.length < k) best.push([j, d]);
      else if (d < best[k - 1]![1]) best[k - 1] = [j, d];
      else continue;
      best.sort((x, y) => x[1] - y[1]);
    }
    for (const [j] of best) {
      if (!adj[i]!.includes(j)) adj[i]!.push(j);
      if (!adj[j]!.includes(i)) adj[j]!.push(i);
    }
  }
  return adj;
}

/** One visible cortex neuron per project, spread over both hemispheres' upper, outer surface. Neuron indexes. */
export function projectAnchors(ns: Neuron[], count: number): number[] {
  const cortex = ns.map((n, i) => ({ n, i })).filter((x) => x.n.part === 'cortex' && x.n.p[1] > -0.15 && Math.abs(x.n.p[0]) > 0.25);
  const used = new Set<number>();
  const out: number[] = [];
  for (let k = 0; k < count; k++) {
    const side = k % 2 ? 1 : -1;
    const t = (k + 0.5) / Math.max(1, count);
    const a = k * 2.399963;
    const target: Vec3 = [side * (0.55 + 0.25 * Math.abs(Math.cos(a))), 0.7 - t * 0.8, Math.sin(a) * 0.8];
    let best = -1, bd = Infinity;
    for (const { n, i } of cortex) {
      if (used.has(i)) continue;
      const d = (n.p[0] - target[0]) ** 2 + (n.p[1] - target[1]) ** 2 + (n.p[2] - target[2]) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0) best = cortex[k % Math.max(1, cortex.length)]?.i ?? 0;
    used.add(best);
    out.push(best);
  }
  return out;
}

/** Neurons within `radius` of each anchor: the project's region (lights up with its heat). */
export function regions(ns: Neuron[], anchors: number[], radius = 0.24): number[] {
  const owner = ns.map(() => -1);
  const r2 = radius * radius;
  ns.forEach((n, i) => {
    let best = -1, bd = r2;
    anchors.forEach((a, k) => {
      const p = ns[a]!.p;
      const d = (n.p[0] - p[0]) ** 2 + (n.p[1] - p[1]) ** 2 + (n.p[2] - p[2]) ** 2;
      if (d < bd) { bd = d; best = k; }
    });
    owner[i] = best;
  });
  return owner;
}

/** Greedy label placement: a label is kept only if its box does not overlap one already placed (input = priority order). */
export function placeLabels<T extends { x: number; y: number; w: number; h: number }>(items: T[], pad = 4): T[] {
  const kept: T[] = [];
  for (const it of items) {
    if (!kept.some((k) => it.x < k.x + k.w + pad && it.x + it.w + pad > k.x && it.y < k.y + k.h + pad && it.y + it.h + pad > k.y)) kept.push(it);
  }
  return kept;
}

export const shortName = (s: string, max = 24) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
