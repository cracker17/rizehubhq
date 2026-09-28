// Idle spot assignment: agents.idle_activity → a concrete spot on the map (docs/07 §5).
// Deterministic and stable: an agent keeps its previous spot while its activity is unchanged,
// capacity is respected (one person per tile) and paired games/chats fill a pair before the next.
import type { IdleActivity } from '@rizehubhq/shared';
import type { OfficeMap, Spot, SpotKind } from './map';

export interface IdleAgent { id: string; activity: IdleActivity | null }

const PAIRED: SpotKind[] = ['ping_pong', 'foosball', 'chat'];
/** Where to send someone when their activity's spots are full (solo spots first). */
const FALLBACK: SpotKind[] = ['coffee', 'lounge_sofa', 'lobby', 'chat', 'gym'];

function kindFor(a: IdleActivity | null): SpotKind {
  return (a ?? 'coffee') as SpotKind;
}

/**
 * Returns agentId → spotId. Agents that cannot be placed anywhere are left out
 * (the caller keeps them at their own desk).
 */
export function assignSpots(m: OfficeMap, agents: IdleAgent[], prev?: Map<string, string>): Map<string, string> {
  const byId = new Map(m.spots.map((s) => [s.id, s]));
  const taken = new Set<string>();
  const out = new Map<string, string>();
  const sorted = [...agents].sort((a, b) => a.id.localeCompare(b.id));

  // 1) keep previous spots that still match the activity
  for (const a of sorted) {
    const sid = prev?.get(a.id);
    const s = sid ? byId.get(sid) : undefined;
    if (s && s.kind === kindFor(a.activity) && !taken.has(s.id)) { out.set(a.id, s.id); taken.add(s.id); }
  }

  const free = (kind: SpotKind) => m.spots.filter((s) => s.kind === kind && !taken.has(s.id));
  const pick = (kind: SpotKind): Spot | undefined => {
    const list = free(kind);
    if (!PAIRED.includes(kind)) return list[0];
    // Prefer completing a half-filled pair, then an empty pair.
    const half = list.find((s) => s.pair && m.spots.some((o) => o.pair === s.pair && o.id !== s.id && taken.has(o.id)));
    return half ?? list[0];
  };

  // 2) place the rest in their activity, else a fallback
  for (const a of sorted) {
    if (out.has(a.id)) continue;
    const kinds = [kindFor(a.activity), ...FALLBACK.filter((k) => k !== kindFor(a.activity))];
    for (const k of kinds) {
      const s = pick(k);
      if (s) { out.set(a.id, s.id); taken.add(s.id); break; }
    }
  }
  return out;
}

/** The other half of a paired spot, if any. */
export function partnerSpot(m: OfficeMap, spotId: string): Spot | undefined {
  const s = m.spots.find((x) => x.id === spotId);
  if (!s?.pair) return undefined;
  return m.spots.find((x) => x.pair === s.pair && x.id !== s.id);
}
