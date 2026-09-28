// Walking paths on the office's walk graph (corridors, doors and aisles authored in layout.json).
// Seats and spots join the graph at their own node, so people reach a chair from the right side.
import { graphPath } from './layout';
import { key, type OfficeMap } from './map';
import type { Pt } from './iso';

/** Tile path from `from` to `to` (both included), or null when the graph has no route. */
export function findPath(m: OfficeMap, from: Pt, to: Pt): Pt[] | null {
  return graphPath(m.graph, from, to, (p) => m.joins.get(key(p.x, p.y)));
}

/** The walk-graph node closest to a tile point (click-to-walk for the CEO avatar). */
export function nearestNode(m: OfficeMap, p: Pt): { id: string; pos: Pt } {
  let best = 0;
  let bestD = Infinity;
  m.graph.pos.forEach((q, i) => {
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < bestD) { bestD = d; best = i; }
  });
  return { id: m.graph.ids[best], pos: { ...m.graph.pos[best] } };
}
