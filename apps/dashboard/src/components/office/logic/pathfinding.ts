// A* on the office grid (4-connected: characters walk along the 4 isometric diagonals).
// Walls block edges, furniture blocks tiles, seats are only allowed as the first/last tile.
import { inBounds, key, wallBetween, type OfficeMap } from './map';
import type { Pt } from './iso';

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

export function isWalkable(m: OfficeMap, x: number, y: number): boolean {
  return inBounds(m, x, y) && !m.blocked.has(key(x, y));
}

/** Min-heap keyed by f-score (small and dependency-free). */
class Heap {
  private a: { k: number; f: number }[] = [];
  get size() { return this.a.length; }
  push(k: number, f: number) {
    const a = this.a;
    a.push({ k, f });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): number {
    const a = this.a;
    const top = a[0].k;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let s = i;
        if (l < a.length && a[l].f < a[s].f) s = l;
        if (r < a.length && a[r].f < a[s].f) s = r;
        if (s === i) break;
        [a[s], a[i]] = [a[i], a[s]];
        i = s;
      }
    }
    return top;
  }
}

/**
 * Shortest tile path from `from` to `to` (both included). Returns null when unreachable.
 * `extraBlocked` lets callers avoid tiles (e.g. other people's seats are already excluded).
 */
export function findPath(m: OfficeMap, from: Pt, to: Pt, extraBlocked?: Set<string>): Pt[] | null {
  const sx = Math.round(from.x);
  const sy = Math.round(from.y);
  const tx = Math.round(to.x);
  const ty = Math.round(to.y);
  if (!inBounds(m, sx, sy) || !inBounds(m, tx, ty)) return null;
  if (sx === tx && sy === ty) return [{ x: tx, y: ty }];
  const W = m.cols;
  const id = (x: number, y: number) => y * W + x;
  const start = id(sx, sy);
  const goal = id(tx, ty);
  const g = new Map<number, number>([[start, 0]]);
  const came = new Map<number, number>();
  const closed = new Set<number>();
  const open = new Heap();
  const h = (x: number, y: number) => Math.abs(x - tx) + Math.abs(y - ty);
  open.push(start, h(sx, sy));
  while (open.size) {
    const cur = open.pop();
    if (cur === goal) break;
    if (closed.has(cur)) continue;
    closed.add(cur);
    const cx = cur % W;
    const cy = (cur - cx) / W;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!inBounds(m, nx, ny)) continue;
      const nid = id(nx, ny);
      const isGoal = nid === goal;
      const k = key(nx, ny);
      if (m.blocked.has(k) && !isGoal) continue;
      if (m.seats.has(k) && !isGoal) continue;
      if (extraBlocked?.has(k) && !isGoal) continue;
      if (wallBetween(m, cx, cy, nx, ny)) continue;
      // Small penalty for turning keeps walks natural (fewer zig-zags).
      const prev = came.get(cur);
      let turn = 0;
      if (prev !== undefined) {
        const px = prev % W;
        const py = (prev - px) / W;
        if (cx - px !== dx || cy - py !== dy) turn = 0.3;
      }
      const ng = g.get(cur)! + 1 + turn;
      if (ng < (g.get(nid) ?? Infinity)) {
        g.set(nid, ng);
        came.set(nid, cur);
        open.push(nid, ng + h(nx, ny));
      }
    }
  }
  if (!came.has(goal)) return null;
  const out: Pt[] = [];
  for (let c: number | undefined = goal; c !== undefined; c = came.get(c)) {
    const x = c % W;
    out.push({ x, y: (c - x) / W });
    if (c === start) break;
  }
  return out.reverse();
}

/** Nearest walkable, non-seat tile to (x, y) (for click-to-walk on furniture). */
export function nearestFree(m: OfficeMap, x: number, y: number, maxR = 6): Pt | null {
  const rx = Math.round(x);
  const ry = Math.round(y);
  for (let r = 0; r <= maxR; r++) {
    let best: Pt | null = null;
    let bestD = Infinity;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const nx = rx + dx;
        const ny = ry + dy;
        if (!isWalkable(m, nx, ny) || m.seats.has(key(nx, ny))) continue;
        const d = Math.hypot(nx - x, ny - y);
        if (d < bestD) { bestD = d; best = { x: nx, y: ny }; }
      }
    }
    if (best) return best;
  }
  return null;
}
