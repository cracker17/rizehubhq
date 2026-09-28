// The office layout (apps/dashboard/office/layout.json) mapped onto the painted background.
// Positions in the JSON are pixels of the 1x reference picture. The logic works in "tile" units of an
// affine grid laid over the picture (x = down-right, y = down-left), so the motion state machine and the
// figures' four iso facings keep working unchanged. Walking follows a hand-authored graph (corridors,
// doors, aisles) instead of a tile grid, so nobody walks through glass or furniture.
import raw from '../../../../office/layout.json';
import type { Pt } from './iso';

export type Facing = 'up' | 'down' | 'left' | 'right'; // up = up-right, right = down-right, down = down-left, left = up-left
export type XY = [number, number];

export interface LayoutDesk { id: string; room: string; at: XY; face: Facing; kind: string; via: string; screens: XY[][] }
export interface LayoutSpot { id: string; kind: string; at: XY; face: Facing; pose: 'stand' | 'sit'; room: string; via: string; pair?: string }
export interface LayoutRoom { id: string; name: string; label: XY }
export interface OfficeLayout {
  version: number;
  image: { src: string; width: number; height: number; scale: number };
  grid: { u: XY; v: XY; origin: XY };
  assignments: Record<string, string>;
  rooms: LayoutRoom[];
  doormat: { text: string; center: XY; angle: number; skewY: number };
  desks: LayoutDesk[];
  spots: LayoutSpot[];
  visits: Record<string, XY>;
  entrance: XY;
  graph: { nodes: Record<string, XY>; edges: [string, string][] };
  wallScreens: { id: string; room: string; quad: XY[] }[];
}

export const LAYOUT = raw as unknown as OfficeLayout;

// ---------------------------------------------------------------- projection
/** Affine picture ⇄ tile transform for a layout. */
export function projection(l: OfficeLayout = LAYOUT) {
  const [ux, uy] = l.grid.u;
  const [vx, vy] = l.grid.v;
  const [ox, oy] = l.grid.origin;
  const det = ux * vy - uy * vx;
  return {
    /** Picture pixel (1x) → tile coordinates. */
    toTile(px: number, py: number): Pt {
      const dx = px - ox;
      const dy = py - oy;
      return { x: (dx * vy - dy * vx) / det, y: (ux * dy - uy * dx) / det };
    },
    /** Tile coordinates (+ height in picture px) → picture pixel (1x). */
    toImage(tx: number, ty: number, z = 0): Pt {
      return { x: ox + tx * ux + ty * vx, y: oy + tx * uy + ty * vy - z };
    },
  };
}

export const PROJ = projection();

// ---------------------------------------------------------------- graph
export interface WalkGraph {
  ids: string[];
  pos: Pt[]; // tile coords
  adj: number[][];
  index: Map<string, number>;
}

export function buildGraph(l: OfficeLayout = LAYOUT): WalkGraph {
  const p = projection(l);
  const ids = Object.keys(l.graph.nodes);
  const index = new Map(ids.map((id, i) => [id, i]));
  const pos = ids.map((id) => { const [x, y] = l.graph.nodes[id]; return p.toTile(x, y); });
  const adj: number[][] = ids.map(() => []);
  for (const [a, b] of l.graph.edges) {
    const ia = index.get(a);
    const ib = index.get(b);
    if (ia === undefined || ib === undefined) throw new Error(`layout.json: edge ${a}–${b} names an unknown node`);
    adj[ia].push(ib);
    adj[ib].push(ia);
  }
  return { ids, pos, adj, index };
}

export const GRAPH = buildGraph();

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

function nearestNode(g: WalkGraph, p: Pt): number {
  let best = 0;
  let bestD = Infinity;
  g.pos.forEach((q, i) => { const d = dist(p, q); if (d < bestD) { bestD = d; best = i; } });
  return best;
}

/**
 * Where a point joins the walk graph. Seats and spots join at their declared `via` node (registered by
 * the map builder); anything else joins at the nearest node.
 */
export type ViaLookup = (p: Pt) => number | undefined;

/** Dijkstra over the graph (it is small: ~50 nodes). */
function route(g: WalkGraph, from: number, to: number): number[] | null {
  const n = g.ids.length;
  const d = new Array<number>(n).fill(Infinity);
  const prev = new Array<number>(n).fill(-1);
  const done = new Array<boolean>(n).fill(false);
  d[from] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && d[i] < Infinity && (u < 0 || d[i] < d[u])) u = i;
    if (u < 0) break;
    if (u === to) break;
    done[u] = true;
    for (const v of g.adj[u]) {
      const nd = d[u] + dist(g.pos[u], g.pos[v]);
      if (nd < d[v]) { d[v] = nd; prev[v] = u; }
    }
  }
  if (d[to] === Infinity) return null;
  const out: number[] = [];
  for (let c = to; c >= 0; c = prev[c]) out.push(c);
  return out.reverse();
}

/** Walking path in tile coordinates from `a` to `b` (both included). Null when unreachable. */
export function graphPath(g: WalkGraph, a: Pt, b: Pt, via?: ViaLookup): Pt[] | null {
  if (dist(a, b) < 1e-3) return [{ ...b }];
  const ia = via?.(a) ?? nearestNode(g, a);
  const ib = via?.(b) ?? nearestNode(g, b);
  const nodes = route(g, ia, ib);
  if (!nodes) return null;
  const pts: Pt[] = [{ ...a }];
  for (const i of nodes) {
    const q = g.pos[i];
    if (dist(pts[pts.length - 1], q) > 1e-3) pts.push({ ...q });
  }
  if (dist(pts[pts.length - 1], b) > 1e-3) pts.push({ ...b });
  // Short hop between two points near the same node: skip the detour through it.
  if (pts.length === 3 && ia === ib && dist(a, b) < dist(a, pts[1]) + dist(pts[1], b) - 0.8) return [{ ...a }, { ...b }];
  return pts.length >= 2 ? pts : [{ ...a }, { ...b }];
}
