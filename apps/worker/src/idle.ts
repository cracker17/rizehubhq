import type { IdleActivity } from '@rizehubhq/shared';

/** Spot capacity per idle activity (docs/07 §5). */
export const CAPACITY: Record<IdleActivity, number> = { coffee: 3, lounge_sofa: 3, lobby: 8, ping_pong: 2, foosball: 2, chat: 4, gym: 2 };
const WEIGHTS: [IdleActivity, number][] = [['coffee', 28], ['lounge_sofa', 18], ['lobby', 12], ['ping_pong', 10], ['foosball', 10], ['chat', 14], ['gym', 8]];
const PAIRED: IdleActivity[] = ['ping_pong', 'foosball', 'chat'];

export interface IdleAgent { id: string; activity: IdleActivity | null; idleForMs: number }

/**
 * Decides new idle activities for agents idle > 60 s (30% chance each tick).
 * Paired activities only happen with two agents moving together; capacity is respected.
 * Returns only the agents whose activity changes. `rand` is injectable for tests.
 */
export function shuffleIdle(agents: IdleAgent[], rand: () => number = Math.random): Map<string, IdleActivity> {
  const used = new Map<IdleActivity, number>();
  for (const a of agents) if (a.activity) used.set(a.activity, (used.get(a.activity) ?? 0) + 1);
  const movers = agents.filter((a) => a.idleForMs > 60_000 && rand() < 0.3);
  const changes = new Map<string, IdleActivity>();
  const pick = (): IdleActivity => {
    const total = WEIGHTS.reduce((s, [, w]) => s + w, 0);
    let r = rand() * total;
    for (const [act, w] of WEIGHTS) { if ((r -= w) < 0) return act; }
    return 'coffee';
  };
  const queue = [...movers];
  while (queue.length) {
    const a = queue.shift()!;
    const prev = a.activity;
    if (prev) used.set(prev, (used.get(prev) ?? 1) - 1);
    let act = pick();
    const free = CAPACITY[act] - (used.get(act) ?? 0);
    if (PAIRED.includes(act)) {
      const partner = queue.find(() => true);
      if (partner && free >= 2) {
        queue.shift();
        if (partner.activity) used.set(partner.activity, (used.get(partner.activity) ?? 1) - 1);
        changes.set(a.id, act); changes.set(partner.id, act);
        used.set(act, (used.get(act) ?? 0) + 2);
        continue;
      }
      act = 'coffee';
    }
    if (CAPACITY[act] - (used.get(act) ?? 0) <= 0) {
      const fallback = (['lounge_sofa', 'lobby', 'coffee'] as IdleActivity[]).find((x) => CAPACITY[x] - (used.get(x) ?? 0) > 0);
      if (!fallback) { if (prev) used.set(prev, (used.get(prev) ?? 0) + 1); continue; } // everywhere full: stay put
      act = fallback;
    }
    used.set(act, (used.get(act) ?? 0) + 1);
    if (act !== prev) changes.set(a.id, act);
  }
  return changes;
}

/** Minimal DB surface the shuffler needs (HqDb satisfies it). */
export interface IdleDb {
  listAgents(): Promise<{ id: string; status: string; enabled: boolean; idle_activity: string | null; idle_since: string | null }[]>;
  setIdleActivity(agentId: string, activity: string | null): Promise<boolean>;
}

/** One shuffler tick: reads idle agents, decides moves, writes agents.idle_activity. Returns how many moved. */
export async function runIdleShuffle(db: IdleDb, now = Date.now(), rand: () => number = Math.random): Promise<number> {
  const idle = (await db.listAgents()).filter((a) => a.enabled && a.status === 'idle');
  const known = new Set<string>(Object.keys(CAPACITY));
  const changes = shuffleIdle(idle.map((a) => ({
    id: a.id,
    activity: a.idle_activity && known.has(a.idle_activity) ? (a.idle_activity as IdleActivity) : null,
    idleForMs: a.idle_since ? now - Date.parse(a.idle_since) : 0,
  })), rand);
  let moved = 0;
  for (const [id, act] of changes) if (await db.setIdleActivity(id, act)) moved++;
  return moved;
}
