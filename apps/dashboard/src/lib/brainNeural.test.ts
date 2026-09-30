import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  brainNeurons, globalActivity, heatColor, heatLabel, placeLabels, projectAnchors, projectHeat, regions, shortName, synapses,
} from './brainNeural';
import type { BrainEvent, BrainProject } from './brainView';

const P = (slug: string): BrainProject => ({ slug, name: slug, aliases: [], status: null, listed: true, doc_count: 3, last_activity: null, sessions: 0, open_next_steps: 0 });
const now = Date.parse('2026-09-30T14:00:00Z');
let id = 0;
const E = (slug: string | null, action: string, minAgo: number): BrainEvent =>
  ({ id: ++id, ts: new Date(now - minAgo * 60_000).toISOString(), actor: 'claude:x', action, project_slug: slug, path: null, summary: '' });

test('heat: recent real activity lights a project; bookkeeping does not; live = last 10 minutes', () => {
  const ps = [P('hot'), P('warm'), P('idle')];
  const h = projectHeat(ps, [
    E('hot', 'saved', 2), E('hot', 'tool_call', 1), E('hot', 'doc_changed', 30),
    E('warm', 'saved', 300),
    E('idle', 'pulled', 1), E('idle', 'indexed', 1), E(null, 'saved', 1),
  ], now);
  const hot = h.get('hot')!, warm = h.get('warm')!, idle = h.get('idle')!;
  assert.ok(hot.glow > warm.glow && warm.glow > idle.glow);
  assert.equal(hot.live, true);
  assert.equal(warm.live, false);
  assert.equal(hot.count24h, 3);
  assert.ok(idle.glow < 0.15, 'syncs and index runs warm nothing');
  assert.equal(heatLabel(hot), 'Active now');
  assert.equal(heatLabel(idle), 'Idle');
  // an old save has decayed (3 h half-life)
  const old = projectHeat([P('a')], [E('a', 'saved', 60 * 24)], now).get('a')!;
  assert.ok(old.glow < 0.01 + 0.1);
});

test('global activity: 0 when quiet, near 1 when busy, only recent events count', () => {
  assert.equal(globalActivity([], now), 0);
  const busy = Array.from({ length: 12 }, (_, i) => E('x', 'tool_call', i * 0.5));
  assert.ok(globalActivity(busy, now) > 0.8);
  assert.ok(globalActivity([E('x', 'saved', 180)], now) < 0.01);
});

test('heat colour runs idle violet → teal → white', () => {
  const [r0, , b0] = heatColor(0);
  const [, g1] = heatColor(0.35);
  const hot = heatColor(1);
  assert.ok(b0 > r0, 'idle is violet-blue');
  assert.ok(g1 > 200, 'warm is teal');
  assert.ok(hot.every((c) => c > 230), 'hot is near white');
  assert.deepEqual(heatColor(-1), heatColor(0));
  assert.deepEqual(heatColor(2), heatColor(1));
});

test('brain geometry: deterministic, brain-shaped, every neuron wired', () => {
  const a = brainNeurons(600), b = brainNeurons(600);
  assert.deepEqual(a, b);
  assert.equal(a.length, 600);
  const cortex = a.filter((n) => n.part === 'cortex');
  assert.ok(cortex.length > 400);
  // two hemispheres with a gap down the middle
  assert.ok(cortex.every((n) => Math.abs(n.p[0]) >= 0.049));
  assert.ok(cortex.some((n) => n.p[0] < -0.5) && cortex.some((n) => n.p[0] > 0.5));
  // longer front-to-back than wide, cerebellum behind and below
  const span = (k: 0 | 1 | 2) => Math.max(...a.map((n) => n.p[k])) - Math.min(...a.map((n) => n.p[k]));
  assert.ok(span(2) > span(1));
  const cb = a.filter((n) => n.part === 'cerebellum');
  assert.ok(cb.every((n) => n.p[2] < -0.2 && n.p[1] < -0.1));
  const adj = synapses(a);
  assert.ok(adj.filter((x) => x.length === 0).length < a.length * 0.02, 'almost every neuron has a synapse');
  assert.ok(adj.every((js, i) => js.every((j) => adj[j]!.includes(i))), 'synapses go both ways');
});

test('projects: one distinct visible anchor each, regions around them', () => {
  const ns = brainNeurons(600);
  const anchors = projectAnchors(ns, 20);
  assert.equal(new Set(anchors).size, 20);
  assert.ok(anchors.every((i) => ns[i]!.part === 'cortex' && Math.abs(ns[i]!.p[0]) > 0.25));
  const owner = regions(ns, anchors);
  anchors.forEach((a, k) => assert.equal(owner[a], k));
  assert.ok(owner.some((o) => o === -1), 'not every neuron belongs to a project');
});

test('labels never overlap; long names are shortened', () => {
  const kept = placeLabels([{ x: 0, y: 0, w: 100, h: 20 }, { x: 50, y: 5, w: 100, h: 20 }, { x: 0, y: 40, w: 100, h: 20 }]);
  assert.equal(kept.length, 2);
  assert.equal(shortName('RizeHub HQ (AI employee team + virtual office)', 24).length, 24);
  assert.ok(shortName('RizeHub HQ (AI employee team + virtual office)', 24).endsWith('…'));
  assert.equal(shortName('HQ Brain'), 'HQ Brain');
});
