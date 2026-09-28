import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shuffleIdle, CAPACITY, type IdleAgent } from './idle';

function seeded(seed: number) { return () => ((seed = (seed * 16807) % 2147483647) / 2147483647); }

test('agents idle under 60s never move', () => {
  const r = shuffleIdle([{ id: 'a', activity: null, idleForMs: 10_000 }], () => 0);
  assert.equal(r.size, 0);
});

test('capacity is never exceeded across many random ticks', () => {
  for (let s = 1; s < 300; s++) {
    let agents: IdleAgent[] = Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, activity: null, idleForMs: 120_000 }));
    for (let tick = 0; tick < 5; tick++) {
      const ch = shuffleIdle(agents, seeded(s * 7 + tick));
      agents = agents.map((a) => ({ ...a, activity: ch.get(a.id) ?? a.activity }));
      const counts: Record<string, number> = {};
      for (const a of agents) if (a.activity) counts[a.activity] = (counts[a.activity] ?? 0) + 1;
      for (const [act, n] of Object.entries(counts)) assert.ok(n <= CAPACITY[act as keyof typeof CAPACITY], `${act}=${n}`);
    }
  }
});

test('paired activities always come in pairs when newly assigned', () => {
  for (let s = 1; s < 200; s++) {
    const agents: IdleAgent[] = Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, activity: null, idleForMs: 120_000 }));
    const ch = shuffleIdle(agents, seeded(s));
    for (const act of ['ping_pong', 'foosball'] as const) {
      const n = [...ch.values()].filter((v) => v === act).length;
      assert.equal(n % 2, 0, `${act} assigned to ${n}`);
    }
  }
});
