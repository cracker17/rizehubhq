// Pure-logic tests for the virtual office (run: pnpm --filter dashboard test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OFFICE, assignmentsFor, buildOfficeMap, deskFor } from './map';
import { findPath, nearestNode } from './pathfinding';
import { ambientAt, manilaMinutes } from './ambient';
import { LAYOUT, PROJ } from './layout';
import { assignSpots, partnerSpot } from './spots';
import { createMotion, setGoal, tick, trigger, isAtGoal, MICRO_MAX, type Goal, type Motion } from './motion';
import { deriveOffice, diffEvents, handoverTarget, planningInfo } from './director';
import { applyOverlay, emptyOverlay, simStep } from './demoSim';
import { mulberry32 } from './rng';
import { gameState, pickPose, RALLY_HIT } from '../engine/characters';
import { demoSnapshot } from '../../../lib/mock';
import type { HqSnapshot } from '../../../lib/data/types';

const AGENTS = ['coo', 'web-dev', 'designer', 'writer', 'sales', 'qa-lead'];
const env = { findPath: (a: { x: number; y: number }, b: { x: number; y: number }) => findPath(OFFICE, a, b) };
const LOBBY = OFFICE.entrance;
const spot = (id: string) => OFFICE.spots.find((s) => s.id === id)!;
const close = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-6;

// ---------------------------------------------------------------- layout + map
test('layout: the picture ⇄ tile projection round-trips', () => {
  for (const [x, y] of [[0, 0], [668, 0], [1337, 749], [420, 330]]) {
    const t = PROJ.toTile(x, y);
    const back = PROJ.toImage(t.x, t.y);
    assert.ok(Math.abs(back.x - x) < 1e-6 && Math.abs(back.y - y) < 1e-6, `${x},${y}`);
  }
});

test('map: the six agents sit where the brief says (seat ids from layout.json)', () => {
  assert.equal(OFFICE.desks.length, 6);
  const seat = (id: string) => deskFor(OFFICE, id)?.id;
  assert.equal(seat('web-dev'), 'dev-1');
  assert.equal(seat('designer'), 'design-1');
  assert.equal(seat('writer'), 'sales-1');
  assert.equal(seat('sales'), 'sales-2');
  assert.equal(seat('qa-lead'), 'qa-1');
  assert.equal(seat('coo'), 'board-head');
  assert.equal(OFFICE.ceoSeat.room, 'ceo');
});

test('map: rooms from the reference, spare desks stay as furniture, a new hire gets a desk by seat id', () => {
  const rooms = OFFICE.rooms.map((r) => r.id).sort();
  assert.deepEqual(rooms, ['boardroom', 'ceo', 'coffee', 'design', 'dev', 'game', 'growth', 'gym', 'lobby', 'lounge', 'qa_lab'].sort());
  const count = (room: string) => OFFICE.seats.filter((s) => s.room === room && s.kind !== 'board' && s.kind !== 'ceo').length;
  assert.equal(count('dev'), 4);
  assert.equal(count('design'), 2);
  assert.equal(count('growth'), 2);
  assert.equal(count('qa_lab'), 2);
  // agents.desk.id overrides the default (and frees the old owner's seat)
  const a = assignmentsFor([{ id: 'seo', desk: { id: 'dev-2' } }, { id: 'web-dev', desk: { id: 'dev-2' } }]);
  assert.equal(a['web-dev'], 'dev-2');
  assert.equal(a.seo, undefined);
  const m = buildOfficeMap(assignmentsFor([{ id: 'new-hire', desk: { id: 'design-2' } }]));
  assert.equal(deskFor(m, 'new-hire')?.id, 'design-2');
  assert.equal(m.desks.length, 7);
});

test('map: required spot kinds exist (pairs come in twos)', () => {
  for (const k of ['coffee', 'lounge_sofa', 'lobby', 'ping_pong', 'foosball', 'chat', 'gym', 'boardroom', 'boardroom_head', 'ceo'] as const) {
    assert.ok(OFFICE.spots.some((s) => s.kind === k), k);
  }
  const pairs = new Map<string, number>();
  for (const s of OFFICE.spots) if (s.pair) pairs.set(s.pair, (pairs.get(s.pair) ?? 0) + 1);
  for (const [p, n] of pairs) assert.equal(n, 2, `pair ${p}`);
  assert.equal(partnerSpot(OFFICE, 'pp-a')?.id, 'pp-b');
});

test('layout: every point sits inside the picture and every seat has a visit spot', () => {
  const inside = ([x, y]: [number, number]) => x > 0 && y > 0 && x < LAYOUT.image.width && y < LAYOUT.image.height;
  for (const d of LAYOUT.desks) { assert.ok(inside(d.at), d.id); if (d.kind !== 'board' && d.kind !== 'ceo') assert.ok(LAYOUT.visits[d.id], `visit ${d.id}`); }
  for (const s of LAYOUT.spots) assert.ok(inside(s.at), s.id);
  for (const [id, xy] of Object.entries(LAYOUT.graph.nodes)) assert.ok(inside(xy), id);
  for (const r of LAYOUT.rooms) assert.ok(inside(r.label), r.id);
});

// ---------------------------------------------------------------- pathfinding
test('pathfinding: every seat and spot is reachable from every other one and from the lobby', () => {
  const all = [...OFFICE.seats, ...OFFICE.spots];
  for (const a of all) {
    assert.ok(findPath(OFFICE, LOBBY, a), `lobby → ${a.id}`);
    for (const b of all) assert.ok(findPath(OFFICE, a, b), `${a.id} → ${b.id}`);
  }
});

test('pathfinding: paths start and end exactly on the points and follow graph edges', () => {
  const desk = deskFor(OFFICE, 'sales')!;
  const path = findPath(OFFICE, spot('coffee-1'), desk)!;
  assert.ok(close(path[0], spot('coffee-1')));
  assert.ok(close(path.at(-1)!, desk));
  const nodes = OFFICE.graph.pos;
  const isNode = (p: { x: number; y: number }) => nodes.findIndex((q) => close(p, q));
  const inner = path.slice(1, -1).map(isNode);
  assert.ok(inner.every((i) => i >= 0), 'inner points are graph nodes');
  for (let i = 1; i < inner.length; i++) assert.ok(OFFICE.graph.adj[inner[i - 1]].includes(inner[i]), 'consecutive nodes are connected');
  assert.ok(['gs-1', 'gs-2'].includes(nearestNode(OFFICE, desk).id));
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
const cs = spot('coffee-1');
const coffeeGoal: Goal = { key: 'spot:coffee-1', x: cs.x, y: cs.y, face: cs.face, seated: false, loop: 'coffee' };
function run(m: Motion, seconds: number, onStep?: (m: Motion) => void) {
  for (let t = 0; t < seconds; t += 1 / 30) { tick(m, 1 / 30, env); onStep?.(m); }
}

test('motion: seated → stand up → walk → arrive (standing loop) with acted-out phases', () => {
  const m = createMotion(deskGoalOf('writer'), mulberry32(1));
  assert.equal(m.phase, 'seated');
  setGoal(m, coffeeGoal);
  const phases: string[] = [];
  run(m, 40, (x) => { if (phases.at(-1) !== x.phase) phases.push(x.phase); });
  assert.deepEqual(phases.slice(0, 3), ['standing_up', 'standing', 'walking']);
  assert.ok(isAtGoal(m));
  assert.equal(m.loop, 'coffee');
  assert.ok(close(m.pos, cs));
  assert.equal(m.facing, cs.face);
});

test('motion: walking back to the desk ends with sit down + settle before the main loop', () => {
  const m = createMotion(coffeeGoal, mulberry32(2));
  setGoal(m, deskGoalOf('writer', 'write'));
  const phases: string[] = [];
  run(m, 40, (x) => { if (phases.at(-1) !== x.phase) phases.push(x.phase); });
  assert.deepEqual(phases.slice(-3), ['walking', 'sitting_down', 'seated']);
  assert.equal(m.loop, 'write');
  assert.ok(isAtGoal(m));
});

test('motion: micro-actions play every 6–20 s, never frozen', () => {
  const m = createMotion(deskGoalOf('web-dev'), mulberry32(3));
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
  const m = createMotion(deskGoalOf('designer', 'draw'), mulberry32(4));
  setGoal(m, deskGoalOf('designer', 'wait_qa'));
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
  const m = createMotion(deskGoalOf('sales', 'write'), mulberry32(5));
  setGoal(m, { ...deskGoalOf('sales', 'raise_hand'), seated: false });
  run(m, 2);
  assert.equal(m.phase, 'standing');
  assert.equal(m.loop, 'raise_hand');
  assert.ok(isAtGoal(m));
});

test('motion: goal change mid-walk re-routes', () => {
  const m = createMotion(deskGoalOf('writer'), mulberry32(6));
  setGoal(m, coffeeGoal);
  run(m, 2);
  assert.equal(m.phase, 'walking');
  const l = spot('lobby-1');
  const lobby: Goal = { key: 'spot:lobby-1', x: l.x, y: l.y, face: l.face, seated: false, loop: 'lobby_stand' };
  setGoal(m, lobby);
  run(m, 40);
  assert.ok(isAtGoal(m));
  assert.ok(close(m.pos, l));
});

// ---------------------------------------------------------------- director
const snap = () => demoSnapshot(new Date('2026-09-28T10:00:00+08:00'));

test('director: status → place (desk, break spot, boardroom, offline)', () => {
  const s = snap();
  const model = deriveOffice(s, { nowMs: Date.parse(s.loadedAt) });
  const by = new Map(model.agents.map((a) => [a.id, a]));
  assert.deepEqual(model.agents.map((a) => a.id).sort(), [...AGENTS].sort());
  assert.equal(by.get('web-dev')!.goal!.key, 'desk:web-dev');
  assert.equal(by.get('web-dev')!.goal!.loop, 'type');
  assert.equal(by.get('designer')!.goal!.loop, 'draw');
  assert.equal(by.get('writer')!.goal!.key, 'desk:writer');
  assert.ok(by.get('sales')!.goal!.key.startsWith('spot:coffee'), 'idle sales agent on a coffee break');
  assert.equal(by.get('qa-lead')!.goal!.key, 'desk:qa-lead');
  assert.equal(by.get('qa-lead')!.screen, 'review');
  // demo has a request in "planning": the COO runs the meeting from the Boardroom head seat
  assert.equal(by.get('coo')!.goal!.key, 'spot:board-head');
  assert.ok(model.meeting?.label.startsWith('Meeting:'));
  const off: HqSnapshot = { ...s, agents: s.agents.map((a) => (a.id === 'writer' ? { ...a, enabled: false } : a)) };
  assert.equal(deriveOffice(off, { nowMs: 0 }).agents.find((a) => a.id === 'writer')!.goal, null);
});

test('director: waiting and blocked agents get badges at their desk', () => {
  const s = snap();
  const next: HqSnapshot = { ...s, agents: s.agents.map((a) => (a.id === 'writer' ? { ...a, status: 'waiting' } : a.id === 'designer' ? { ...a, status: 'blocked' } : a)) };
  const by = new Map(deriveOffice(next, { nowMs: 0 }).agents.map((a) => [a.id, a]));
  assert.equal(by.get('writer')!.badge, 'hand');
  assert.equal(by.get('writer')!.goal!.seated, false);
  assert.equal(by.get('designer')!.badge, 'warning');
});

test('director: the COO walks over to brief whoever just got a task, then goes back', () => {
  const s = snap();
  const now = Date.parse(s.loadedAt);
  const noPlan: HqSnapshot = { ...s, requests: s.requests.map((r) => (r.status === 'planning' ? { ...r, status: 'plan_review' } : r)) };
  assert.equal(planningInfo(noPlan), null);
  const fresh: HqSnapshot = {
    ...noPlan,
    tasks: [...noPlan.tasks, { ...noPlan.tasks[0], id: 't-new', agent_id: 'designer', status: 'queued', title: 'Hero banner', created_at: new Date(now - 5_000).toISOString() }],
  };
  assert.equal(handoverTarget(fresh, now), 'designer');
  const coo = deriveOffice(fresh, { nowMs: now }).agents.find((a) => a.id === 'coo')!;
  assert.equal(coo.goal!.key, 'visit:designer');
  assert.ok(coo.tag.startsWith('Briefing Graphic Designer'));
  // old queued tasks don't pull the COO away from the Boardroom
  assert.equal(handoverTarget(noPlan, now + 10 * 60_000), null);
  const later = deriveOffice(noPlan, { nowMs: now + 10 * 60_000 }).agents.find((a) => a.id === 'coo')!;
  assert.equal(later.goal!.key, 'desk:coo');
});

test('director: a task in QA shows the author waiting at the desk', () => {
  const s = snap();
  const next: HqSnapshot = { ...s, tasks: s.tasks.map((x) => (x.id === 't-lvlup' ? { ...x, status: 'qa_pending' } : x)) };
  const dev = deriveOffice(next, { nowMs: 0 }).agents.find((a) => a.id === 'web-dev')!;
  assert.equal(dev.goal!.loop, 'wait_qa');
  assert.equal(dev.badge, 'hourglass');
});

test('director: diffEvents → done / QA fail head-scratch / QA pass nod', () => {
  const a = snap();
  const set = (s: HqSnapshot, id: string, status: HqSnapshot['tasks'][number]['status']): HqSnapshot =>
    ({ ...s, tasks: s.tasks.map((t) => (t.id === id ? { ...t, status } : t)) });
  assert.deepEqual(diffEvents(a, set(a, 't-lvlup', 'qa_pending')), [{ agentId: 'web-dev', gesture: 'done' }]);
  const r = set(a, 't-lvlup', 'qa_reviewing');
  assert.deepEqual(diffEvents(r, set(r, 't-lvlup', 'revision')), [{ agentId: 'web-dev', gesture: 'scratch' }, { agentId: 'qa-lead', gesture: 'nod' }]);
  assert.deepEqual(diffEvents(r, set(r, 't-lvlup', 'awaiting_ceo'))[0], { agentId: 'web-dev', gesture: 'nod' });
});

// ---------------------------------------------------------------- sprites
test('sprites: pose follows the motion (walk frames, back views, seated, coffee) and never freezes', () => {
  const has = () => true;
  const m = createMotion(deskGoalOf('web-dev'), mulberry32(9));
  assert.deepEqual(pickPose(m, has), { pose: 'sit_type', flip: false }); // seated, back to us, facing up-right
  m.phase = 'walking'; m.facing = 'down';
  const frames = new Set<string>();
  for (let i = 0; i < 20; i++) { m.walkCycle = i * 0.4; frames.add(pickPose(m, has).pose); }
  assert.deepEqual([...frames].sort(), ['stand', 'walk']);
  m.facing = 'left';
  assert.ok(['walk_back', 'stand_back'].includes(pickPose(m, has).pose));
  assert.equal(pickPose(m, has).flip, true);
  m.phase = 'standing'; m.loop = 'coffee'; m.facing = 'left';
  assert.equal(pickPose(m, has).pose, 'coffee');
  // sofa facing away from us: the back view (if the character has it), else the front sofa pose mirrored
  m.loop = 'sofa'; m.phase = 'seated'; m.facing = 'up';
  assert.deepEqual(pickPose(m, has), { pose: 'sofa_back', flip: false });
  assert.deepEqual(pickPose(m, (p) => p !== 'sofa_back'), { pose: 'sofa', flip: true });
  // far side of the game tables and the gym
  m.phase = 'standing'; m.loop = 'pingpong'; m.facing = 'up';
  assert.equal(pickPose(m, has).pose, 'pingpong');
  m.facing = 'down';
  assert.equal(pickPose(m, has).pose, 'action');
  m.loop = 'curl';
  assert.equal(pickPose(m, has).pose, 'curl');
  m.loop = 'treadmill'; m.facing = 'up'; m.at = 'spot:gym-tread';
  const run = new Set<string>();
  for (let i = 0; i < 12; i++) { m.clock = i * 0.07; run.add(pickPose(m, has).pose); }
  assert.deepEqual([...run].sort(), ['stand_back', 'walk_back']);
});

test('ambient: the office light follows the Manila clock', () => {
  const noon = ambientAt(12 * 60); const midnight = ambientAt(0); const sunset = ambientAt(17 * 60 + 40);
  assert.equal(noon.phase, 'day'); assert.equal(midnight.phase, 'night'); assert.equal(sunset.phase, 'golden');
  assert.ok(noon.alpha < 0.05 && noon.lamps === 0);
  assert.ok(midnight.alpha > 0.4 && midnight.lamps > 0.5);
  assert.ok(sunset.alpha > noon.alpha && sunset.alpha < midnight.alpha);
  // continuous: no jumps between neighbouring minutes
  for (let t = 0; t < 1440; t++) assert.ok(Math.abs(ambientAt(t + 1).alpha - ambientAt(t).alpha) < 0.02);
  assert.equal(manilaMinutes(new Date('2026-09-28T04:30:00Z')), 12 * 60 + 30);
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

test('gym: reachable from the lobby, equipment spots have their loops', () => {
  const tread = OFFICE.spots.find((s) => s.id === 'gym-tread')!;
  const curl = OFFICE.spots.find((s) => s.id === 'gym-curl')!;
  assert.equal(tread.loop, 'treadmill');
  assert.equal(curl.loop, 'curl');
  const from = OFFICE.entrance;
  assert.ok(findPath(OFFICE, from, tread), 'gym is reachable from the entrance');
  assert.ok(findPath(OFFICE, deskFor(OFFICE, 'web-dev')!, curl), 'gym is reachable from the Dev Team');
  const out = assignSpots(OFFICE, [{ id: 'a', activity: 'gym' }, { id: 'b', activity: 'gym' }, { id: 'c', activity: 'gym' }, { id: 'd', activity: 'gym' }]);
  for (const id of ['a', 'b', 'c']) assert.equal(OFFICE.spots.find((s) => s.id === out.get(id))!.kind, 'gym');
  assert.notEqual(OFFICE.spots.find((s) => s.id === out.get('d'))!.kind, 'gym'); // three stations: the fourth falls back
});

test('games: players swing when the ball reaches them, then one celebrates and one groans', () => {
  // side 0 hits at the start of a crossing, side 1 half a back-and-forth later
  const a0 = gameState(0.01, 0); const b0 = gameState(0.01, 1);
  assert.equal(a0.state, 'play'); assert.ok(a0.swing > 0.9 && b0.swing < 0.1);
  const a1 = gameState(RALLY_HIT, 0); const b1 = gameState(RALLY_HIT, 1);
  assert.ok(b1.swing > 0.9 && a1.swing < 0.1);
  // the point: exactly one winner, both sides agree
  const end = 7 * RALLY_HIT + 0.5;
  const w = gameState(end, 0); const l = gameState(end, 1);
  assert.deepEqual([w.state, l.state].sort(), ['lose', 'win']);
});
