// Pure-logic tests for the virtual office (run: pnpm --filter dashboard test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OFFICE, key, roomAt, wallBetween } from './map';
import { findPath, isWalkable, nearestFree } from './pathfinding';
import { assignSpots, partnerSpot } from './spots';
import { createMotion, setGoal, tick, trigger, isAtGoal, MICRO_MAX, type Goal, type Motion } from './motion';
import { deriveOffice, diffEvents, planningInfo } from './director';
import { applyOverlay, emptyOverlay, simStep } from './demoSim';
import { mulberry32 } from './rng';
import { demoSnapshot } from '../../../lib/mock';
import type { HqSnapshot } from '../../../lib/data/types';

const SEED_AGENTS = [
  'coo', 'ea', 'pipeline', 'prospector', 'inbound', 'job-scout', 'client-success', 'video-editor', 'sound-engineer',
  'shopify-dev', 'webflow-dev', 'wordpress-dev', 'fullstack-dev', 'uiux-1', 'uiux-2', 'graphic-1', 'graphic-2',
  'social-1', 'social-2', 'seo-1', 'seo-2', 'qa-lead',
];
const env = { findPath: (a: { x: number; y: number }, b: { x: number; y: number }) => findPath(OFFICE, a, b) };
const LOBBY = { x: 52, y: 26 };

// ---------------------------------------------------------------- map
test('map: every seeded agent has exactly one desk, inside the right room', () => {
  assert.equal(OFFICE.desks.length, 22);
  for (const id of SEED_AGENTS) {
    const desks = OFFICE.desks.filter((d) => d.agentId === id);
    assert.equal(desks.length, 1, `desk for ${id}`);
    assert.equal(roomAt(OFFICE, desks[0].x, desks[0].y)?.id, desks[0].room, `room of ${id}`);
  }
});

test('map: floor plan matches docs/07 §3 (rooms and neighbours)', () => {
  const at = (x: number, y: number) => roomAt(OFFICE, x, y)?.id;
  assert.equal(at(1, 1), 'boardroom');
  assert.equal(at(20, 2), 'dev');
  assert.equal(at(35, 2), 'qa_lab');
  assert.equal(at(50, 2), 'ceo');
  assert.equal(at(2, 12), 'design');
  assert.equal(at(20, 12), 'growth');
  assert.equal(at(45, 12), 'content');
  assert.equal(at(2, 25), 'ops');
  assert.equal(at(20, 25), 'multimedia');
  assert.equal(at(34, 25), 'coffee');
  assert.equal(at(44, 25), 'game');
  assert.equal(at(52, 25), 'lobby');
  // every tile belongs to exactly one room
  for (let x = 0; x < OFFICE.cols; x++) for (let y = 0; y < OFFICE.rows; y++) {
    assert.equal(OFFICE.rooms.filter((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h).length, 1, `tile ${x},${y}`);
  }
});

test('map: room signs sit on free floor inside their room', () => {
  for (const r of OFFICE.rooms) {
    assert.equal(roomAt(OFFICE, Math.floor(r.label.x), Math.floor(r.label.y))?.id, r.id, r.id);
  }
});

test('map: desks, spots and seats are never on blocked tiles; spots do not share a tile', () => {
  const tiles = new Set<string>();
  for (const d of OFFICE.desks) { assert.ok(!OFFICE.blocked.has(key(d.x, d.y)), `desk ${d.agentId}`); tiles.add(key(d.x, d.y)); }
  for (const s of OFFICE.spots) {
    assert.ok(!OFFICE.blocked.has(key(s.x, s.y)), `spot ${s.id}`);
    assert.ok(!tiles.has(key(s.x, s.y)), `spot ${s.id} overlaps`);
    tiles.add(key(s.x, s.y));
  }
});

test('map: required spot kinds exist (pairs come in twos)', () => {
  for (const k of ['coffee', 'lounge_sofa', 'lobby', 'ping_pong', 'foosball', 'chat', 'boardroom', 'qa_bench', 'ceo'] as const) {
    assert.ok(OFFICE.spots.some((s) => s.kind === k), k);
  }
  const pairs = new Map<string, number>();
  for (const s of OFFICE.spots) if (s.pair) pairs.set(s.pair, (pairs.get(s.pair) ?? 0) + 1);
  for (const [p, n] of pairs) assert.equal(n, 2, `pair ${p}`);
  assert.equal(partnerSpot(OFFICE, 'pp-a')?.id, 'pp-b');
});

test('map: interior walls separate rooms except at doors', () => {
  assert.ok(wallBetween(OFFICE, 10, 9, 10, 10), 'boardroom/design wall');
  assert.ok(!wallBetween(OFFICE, 4, 9, 4, 10), 'boardroom/design door');
  assert.ok(wallBetween(OFFICE, 11, 1, 12, 1), 'boardroom/dev wall');
  assert.ok(!wallBetween(OFFICE, 11, 4, 12, 4), 'boardroom/dev door');
  assert.ok(!wallBetween(OFFICE, 39, 25, 40, 25), 'coffee/game open plan');
});

// ---------------------------------------------------------------- pathfinding
test('pathfinding: every desk and spot is reachable from the lobby', () => {
  for (const d of OFFICE.desks) assert.ok(findPath(OFFICE, LOBBY, d), `desk ${d.agentId}`);
  for (const s of OFFICE.spots) assert.ok(findPath(OFFICE, LOBBY, s), `spot ${s.id}`);
});

test('pathfinding: paths are 4-connected, avoid furniture, seats and walls', () => {
  const desk = OFFICE.desks.find((d) => d.agentId === 'shopify-dev')!;
  const path = findPath(OFFICE, LOBBY, desk)!;
  assert.deepEqual(path[0], LOBBY);
  assert.deepEqual(path.at(-1), { x: desk.x, y: desk.y });
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    assert.equal(Math.abs(a.x - b.x) + Math.abs(a.y - b.y), 1, 'single step');
    assert.ok(!wallBetween(OFFICE, a.x, a.y, b.x, b.y), `wall ${a.x},${a.y}→${b.x},${b.y}`);
    assert.ok(isWalkable(OFFICE, b.x, b.y), 'walkable');
    if (i < path.length - 1) assert.ok(!OFFICE.seats.has(key(b.x, b.y)), `through a seat at ${b.x},${b.y}`);
  }
});

test('pathfinding: unreachable and out-of-bounds give null; nearestFree finds floor', () => {
  assert.equal(findPath(OFFICE, LOBBY, { x: 99, y: 3 }), null);
  const free = nearestFree(OFFICE, 4, 4)!; // meeting table
  assert.ok(isWalkable(OFFICE, free.x, free.y));
  assert.ok(!OFFICE.seats.has(key(free.x, free.y)));
});

// ---------------------------------------------------------------- spots
test('spots: activity maps to its spot kind, pairs fill together, capacity respected', () => {
  const agents = [
    { id: 'a', activity: 'ping_pong' as const }, { id: 'b', activity: 'ping_pong' as const },
    { id: 'c', activity: 'coffee' as const }, { id: 'd', activity: 'lobby' as const }, { id: 'e', activity: null },
  ];
  const out = assignSpots(OFFICE, agents);
  const kind = (id: string) => OFFICE.spots.find((s) => s.id === out.get(id))!.kind;
  assert.equal(kind('a'), 'ping_pong');
  assert.equal(kind('b'), 'ping_pong');
  assert.notEqual(out.get('a'), out.get('b'));
  assert.equal(kind('c'), 'coffee');
  assert.equal(kind('d'), 'lobby');
  assert.equal(kind('e'), 'coffee');
});

test('spots: overflow falls back, nobody shares a tile, previous spots are kept', () => {
  const many = Array.from({ length: 22 }, (_, i) => ({ id: `x${String(i).padStart(2, '0')}`, activity: 'foosball' as const }));
  const out = assignSpots(OFFICE, many);
  const ids = [...out.values()];
  assert.equal(new Set(ids).size, ids.length, 'unique');
  assert.equal(ids.filter((id) => id.startsWith('fb-')).length, 2, 'foosball capacity');
  const prev = new Map([['c', 'coffee-3']]);
  const again = assignSpots(OFFICE, [{ id: 'a', activity: 'coffee' }, { id: 'c', activity: 'coffee' }], prev);
  assert.equal(again.get('c'), 'coffee-3');
});

// ---------------------------------------------------------------- motion
const deskGoalOf = (id: string, loop: Goal['loop'] = 'type'): Goal => {
  const d = OFFICE.desks.find((x) => x.agentId === id)!;
  return { key: `desk:${id}`, x: d.x, y: d.y, face: d.face, seated: true, loop };
};
const coffeeGoal: Goal = { key: 'spot:coffee-1', x: 34, y: 22, face: 'up', seated: false, loop: 'coffee' };
function run(m: Motion, seconds: number, onStep?: (m: Motion) => void) {
  for (let t = 0; t < seconds; t += 1 / 30) { tick(m, 1 / 30, env); onStep?.(m); }
}

test('motion: seated → stand up → walk → arrive (standing loop) with acted-out phases', () => {
  const m = createMotion(deskGoalOf('seo-1'), mulberry32(1));
  assert.equal(m.phase, 'seated');
  setGoal(m, coffeeGoal);
  const phases: string[] = [];
  run(m, 40, (x) => { if (phases.at(-1) !== x.phase) phases.push(x.phase); });
  assert.deepEqual(phases.slice(0, 3), ['standing_up', 'standing', 'walking']);
  assert.ok(isAtGoal(m));
  assert.equal(m.loop, 'coffee');
  assert.deepEqual(m.pos, { x: 34, y: 22 });
  assert.equal(m.facing, 'up');
});

test('motion: walking back to the desk ends with sit down + settle before the main loop', () => {
  const m = createMotion(coffeeGoal, mulberry32(2));
  setGoal(m, deskGoalOf('seo-1', 'write'));
  const phases: string[] = [];
  run(m, 40, (x) => { if (phases.at(-1) !== x.phase) phases.push(x.phase); });
  assert.deepEqual(phases.slice(-3), ['walking', 'sitting_down', 'seated']);
  assert.equal(m.loop, 'write');
  assert.ok(isAtGoal(m));
});

test('motion: micro-actions play every 6–20 s, never frozen', () => {
  const m = createMotion(deskGoalOf('shopify-dev'), mulberry32(3));
  const starts: number[] = [];
  let t = 0;
  let had = false;
  for (; t < 120; t += 1 / 30) {
    tick(m, 1 / 30, env);
    if (m.micro && !had) starts.push(t);
    had = !!m.micro;
  }
  assert.ok(starts.length >= 5, `micro count ${starts.length}`);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] <= MICRO_MAX + 3.5, 'gap');
});

test('motion: same place, new loop swaps without walking; gestures play before leaving', () => {
  const m = createMotion(deskGoalOf('seo-2', 'write'), mulberry32(4));
  setGoal(m, deskGoalOf('seo-2', 'wait_qa'));
  tick(m, 0.1, env);
  assert.equal(m.phase, 'seated');
  assert.equal(m.loop, 'wait_qa');
  trigger(m, 'done');
  setGoal(m, coffeeGoal);
  tick(m, 0.05, env);
  assert.equal(m.gesture?.name, 'done');
  assert.equal(m.phase, 'seated', 'still seated while celebrating');
  run(m, 2.0);
  assert.notEqual(m.phase, 'seated');
});

test('motion: waiting agent stands at the desk (raise hand) without walking away', () => {
  const m = createMotion(deskGoalOf('client-success', 'write'), mulberry32(5));
  setGoal(m, { ...deskGoalOf('client-success', 'raise_hand'), seated: false });
  run(m, 2);
  assert.equal(m.phase, 'standing');
  assert.equal(m.loop, 'raise_hand');
  assert.ok(isAtGoal(m));
});

test('motion: goal change mid-walk re-routes', () => {
  const m = createMotion(deskGoalOf('seo-1'), mulberry32(6));
  setGoal(m, coffeeGoal);
  run(m, 2);
  assert.equal(m.phase, 'walking');
  const lobby: Goal = { key: 'spot:lobby-3', x: 54, y: 25, face: 'up', seated: false, loop: 'lobby_stand' };
  setGoal(m, lobby);
  run(m, 40);
  assert.ok(isAtGoal(m));
  assert.deepEqual(m.pos, { x: 54, y: 25 });
});

// ---------------------------------------------------------------- director
const snap = () => demoSnapshot(new Date('2026-09-28T10:00:00+08:00'));

test('director: status → place (desk, break spot, QA bench, boardroom, offline)', () => {
  const s = snap();
  const model = deriveOffice(s, { nowMs: Date.now() });
  const by = new Map(model.agents.map((a) => [a.id, a]));
  assert.equal(model.agents.length, 22);
  assert.equal(by.get('shopify-dev')!.goal!.key, 'desk:shopify-dev');
  assert.equal(by.get('shopify-dev')!.goal!.loop, 'type');
  assert.equal(by.get('uiux-1')!.goal!.loop, 'draw');
  assert.equal(by.get('video-editor')!.goal!.loop, 'scrub');
  assert.equal(by.get('inbound')!.goal!.key.startsWith('spot:coffee'), true);
  const pp = [by.get('wordpress-dev')!, by.get('social-2')!].map((a) => a.goal!.key);
  assert.deepEqual(pp.sort(), ['spot:pp-a', 'spot:pp-b']);
  assert.equal(by.get('qa-lead')!.goal!.key, 'spot:qa-bench');
  assert.equal(by.get('client-success')!.badge, 'hand');
  assert.equal(by.get('client-success')!.goal!.seated, false);
  assert.equal(by.get('graphic-2')!.badge, 'warning');
  // demo has a request in "planning": the COO runs the meeting
  assert.equal(by.get('coo')!.goal!.key, 'spot:board-head');
  assert.ok(model.meeting?.label.startsWith('Meeting:'));

  const off: HqSnapshot = { ...s, agents: s.agents.map((a) => (a.id === 'seo-2' ? { ...a, enabled: false } : a)) };
  assert.equal(deriveOffice(off, { nowMs: 0 }).agents.find((a) => a.id === 'seo-2')!.goal, null);
});

test('director: COO returns to work when planning is done', () => {
  const s = snap();
  const done: HqSnapshot = { ...s, requests: s.requests.map((r) => (r.status === 'planning' ? { ...r, status: 'plan_review' } : r)) };
  assert.equal(planningInfo(done), null);
  const coo = deriveOffice(done, { nowMs: 0 }).agents.find((a) => a.id === 'coo')!;
  assert.ok(['desk:coo', 'spot:coo-board'].includes(coo.goal!.key));
});

test('director: a task in QA shows the author waiting at the desk', () => {
  const s = snap();
  const t = s.tasks.find((x) => x.id === 't-blog')!;
  const next: HqSnapshot = { ...s, tasks: s.tasks.map((x) => (x.id === t.id ? { ...x, status: 'qa_pending' } : x)) };
  const seo2 = deriveOffice(next, { nowMs: 0 }).agents.find((a) => a.id === 'seo-2')!;
  assert.equal(seo2.goal!.loop, 'wait_qa');
  assert.equal(seo2.badge, 'hourglass');
});

test('director: diffEvents → done / QA fail head-scratch / QA pass nod', () => {
  const a = snap();
  const set = (s: HqSnapshot, id: string, status: HqSnapshot['tasks'][number]['status']): HqSnapshot =>
    ({ ...s, tasks: s.tasks.map((t) => (t.id === id ? { ...t, status } : t)) });
  assert.deepEqual(diffEvents(a, set(a, 't-blog', 'qa_pending')), [{ agentId: 'seo-2', gesture: 'done' }]);
  const r = set(a, 't-blog', 'qa_reviewing');
  assert.deepEqual(diffEvents(r, set(r, 't-blog', 'revision')), [{ agentId: 'seo-2', gesture: 'scratch' }, { agentId: 'qa-lead', gesture: 'nod' }]);
  assert.deepEqual(diffEvents(r, set(r, 't-blog', 'awaiting_ceo'))[0], { agentId: 'seo-2', gesture: 'nod' });
});

// ---------------------------------------------------------------- demo simulator
test('demo simulator: changes some agents every step and keeps the snapshot valid', () => {
  const base = snap();
  const rng = mulberry32(42);
  let overlay = emptyOverlay();
  let now = new Date(base.loadedAt).getTime();
  let changes = 0;
  let prev = applyOverlay(base, overlay);
  for (let i = 0; i < 30; i++) {
    now += 30_000;
    overlay = simStep(prev, overlay, rng, now);
    const view = applyOverlay(base, overlay);
    changes += view.agents.filter((a, j) => a.status !== prev.agents[j].status || a.idle_activity !== prev.agents[j].idle_activity).length;
    for (const a of view.agents) {
      if (a.status === 'idle') assert.ok(a.idle_activity, `${a.id} idle without activity`);
      if (a.status === 'working' && a.id !== 'coo' && a.current_task_id) assert.ok(view.tasks.some((t) => t.id === a.current_task_id), `${a.id} task exists`);
    }
    assert.equal(view.agents.length, base.agents.length);
    // the office model can always be derived
    const model = deriveOffice(view, { nowMs: now });
    const spots = model.agents.filter((a) => a.goal?.key.startsWith('spot:') && !a.goal.key.startsWith('spot:board')).map((a) => a.goal!.key);
    assert.equal(new Set(spots).size, spots.length, 'no shared spots');
    prev = view;
  }
  assert.ok(changes >= 15, `changes ${changes}`);
  // the planning meeting ends (→ plan_review) after a while
  assert.ok(!prev.requests.some((r) => r.id === 'r-sb-plan' && r.status === 'planning'));
});

test('demo simulator: overlay survives a new base snapshot (CEO actions still apply)', () => {
  const base = snap();
  let overlay = emptyOverlay();
  const rng = mulberry32(7);
  const t0 = new Date(base.loadedAt).getTime();
  for (let i = 0; i < 5; i++) overlay = simStep(applyOverlay(base, overlay), overlay, rng, t0 + i * 30_000);
  const base2: HqSnapshot = { ...base, approvals: base.approvals.map((a) => ({ ...a, status: 'approved' as const })) };
  const view = applyOverlay(base2, overlay);
  assert.ok(view.approvals.every((a) => a.status === 'approved'));
});
