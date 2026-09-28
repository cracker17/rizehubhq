// Per-character motion state machine (docs/07 §4b):
//   walk → arrive → settle (sit down) → main loop ⇄ random micro-actions (every 6–20 s, per-agent phase).
// State changes are acted out (stand up, walk with a slightly varied pace, sit down, settle). Gestures
// (done / head-scratch / nod) play in place before any pending walk. Pure TS; the renderer only reads it.
import type { Pt } from './iso';
import type { Facing } from './map';

export type LoopName =
  // working loops (role specific)
  | 'type' | 'write' | 'draw' | 'scrub' | 'sing' | 'whiteboard' | 'call' | 'review' | 'inspect'
  // meetings
  | 'present' | 'meeting'
  // state loops
  | 'wait_qa' | 'raise_hand' | 'head_in_hands' | 'desk_idle'
  // idle activities
  | 'coffee' | 'sofa' | 'lobby_sit' | 'lobby_stand' | 'pingpong' | 'foosball' | 'chat'
  // CEO / generic
  | 'stand' | 'ceo_desk';

export type MicroName =
  | 'lean_in' | 'rub_chin' | 'sip' | 'glance' | 'crack_knuckles' | 'lean_back' | 'stretch' | 'nod' | 'note' | 'scroll'
  | 'tilt_head' | 'swatch' | 'sketch' | 'nod_rhythm' | 'drag' | 'adjust_headphones' | 'listen' | 'check_wave'
  | 'point' | 'tablet' | 'step_back' | 'tick' | 'compare_phone' | 'rub_eyes' | 'thumbs_up'
  | 'blow' | 'turn_chat' | 'phone' | 'cross_legs' | 'laugh' | 'magazine' | 'look_view' | 'pace'
  | 'celebrate' | 'groan' | 'point_phone' | 'sigh' | 'look_ceo';

export type GestureName = 'done' | 'scratch' | 'nod' | 'wave';

export const MICROS: Record<LoopName, MicroName[]> = {
  type: ['lean_in', 'rub_chin', 'sip', 'glance', 'crack_knuckles', 'lean_back'],
  write: ['scroll', 'nod', 'note', 'stretch', 'sip'],
  draw: ['tilt_head', 'swatch', 'sketch', 'sip'],
  scrub: ['nod_rhythm', 'lean_back', 'drag'],
  sing: ['adjust_headphones', 'listen', 'check_wave'],
  whiteboard: ['point', 'tablet', 'step_back'],
  call: ['nod', 'tablet', 'lean_back'],
  review: ['tick', 'compare_phone', 'rub_eyes', 'lean_in'],
  inspect: ['tick', 'compare_phone', 'rub_eyes', 'thumbs_up'],
  present: ['point', 'tablet', 'nod'],
  meeting: ['nod', 'note', 'rub_chin'],
  wait_qa: ['sip', 'lean_back', 'stretch'],
  raise_hand: ['look_ceo'],
  head_in_hands: ['sigh', 'rub_eyes'],
  desk_idle: ['stretch', 'phone', 'sip'],
  coffee: ['blow', 'turn_chat', 'phone', 'sip'],
  sofa: ['cross_legs', 'phone', 'laugh', 'stretch'],
  lobby_sit: ['magazine', 'phone', 'look_view'],
  lobby_stand: ['look_view', 'pace', 'phone'],
  pingpong: ['celebrate', 'groan'],
  foosball: ['celebrate', 'groan'],
  chat: ['laugh', 'nod', 'point_phone'],
  stand: ['look_view', 'stretch'],
  ceo_desk: ['lean_back', 'sip', 'glance'],
};

export const GESTURE_DUR: Record<GestureName, number> = { done: 1.8, scratch: 1.8, nod: 1.2, wave: 1.4 };
export const STAND_UP = 0.6;
export const SIT_DOWN = 0.6;
export const SETTLE = 0.9;
export const MICRO_MIN = 6;
export const MICRO_MAX = 20;

export interface Goal {
  /** Location identity ("desk:coo", "spot:coffee-1"…). Same key = same place. */
  key: string;
  x: number; y: number; face: Facing; seated: boolean; loop: LoopName;
}

export type Phase = 'standing' | 'walking' | 'standing_up' | 'sitting_down' | 'seated';

export interface Motion {
  pos: Pt;
  facing: Facing;
  phase: Phase;
  phaseT: number;
  path: Pt[];
  seg: number;
  /** Tiles per second (base, per character). */
  pace: number;
  /** Current walk's pace (base with a little variation). */
  speed: number;
  goal: Goal | null;
  /** Key of the goal the character has reached (null while travelling). */
  at: string | null;
  loop: LoopName;
  settle: number;
  micro: { name: MicroName; t: number; dur: number } | null;
  nextMicro: number;
  gesture: { name: GestureName; t: number; dur: number } | null;
  queue: GestureName[];
  walkCycle: number;
  /** Seconds since creation (drives the looping animations). */
  clock: number;
  /** Per-character phase offset so nobody moves in sync. */
  seed: number;
  repath: boolean;
  rng: () => number;
}

export interface MotionEnv {
  findPath: (from: Pt, to: Pt) => Pt[] | null;
}

export function createMotion(start: Goal, rng: () => number): Motion {
  const m: Motion = {
    pos: { x: start.x, y: start.y }, facing: start.face, phase: start.seated ? 'seated' : 'standing', phaseT: 0,
    path: [], seg: 0, pace: 2.3 + rng() * 0.6, speed: 2.5, goal: start, at: start.key, loop: start.loop, settle: 0,
    micro: null, nextMicro: MICRO_MIN * rng() + 1 + rng() * (MICRO_MAX - MICRO_MIN), gesture: null, queue: [],
    walkCycle: rng() * Math.PI * 2, clock: rng() * 100, seed: rng(), repath: false, rng,
  };
  return m;
}

/** Point the character at a new goal. Same place with a new loop just swaps the loop. */
export function setGoal(m: Motion, goal: Goal | null) {
  if (!goal) { m.goal = null; return; }
  const samePlace = m.goal?.key === goal.key;
  m.goal = goal;
  if (samePlace) {
    if (m.at === goal.key && m.loop !== goal.loop) { m.loop = goal.loop; m.micro = null; m.settle = 0.3; }
    return;
  }
  m.at = null;
  if (m.phase === 'walking') m.repath = true;
}

export function trigger(m: Motion, g: GestureName) {
  if (m.queue.length < 3) m.queue.push(g);
}

export function isAtGoal(m: Motion) {
  return !!m.goal && m.at === m.goal.key;
}

const dirOf = (a: Pt, b: Pt): Facing => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'down' : 'up';
};

function arrive(m: Motion) {
  const g = m.goal!;
  m.pos = { x: g.x, y: g.y };
  m.facing = g.face;
  m.path = [];
  m.seg = 0;
  m.loop = g.loop;
  m.micro = null;
  if (g.seated) { m.phase = 'sitting_down'; m.phaseT = 0; }
  else { m.phase = 'standing'; m.phaseT = 0; m.at = g.key; m.settle = 0.5; }
}

function startWalk(m: Motion, env: MotionEnv): boolean {
  const g = m.goal!;
  const path = env.findPath(m.pos, { x: g.x, y: g.y });
  if (!path || path.length < 2) return false;
  m.path = path;
  m.seg = 0;
  m.phase = 'walking';
  m.phaseT = 0;
  m.speed = m.pace * (0.92 + m.rng() * 0.16);
  m.micro = null;
  return true;
}

function runLoop(m: Motion, dt: number) {
  if (m.settle > 0) { m.settle -= dt; return; }
  if (m.micro) {
    m.micro.t += dt;
    if (m.micro.t >= m.micro.dur) m.micro = null;
    return;
  }
  m.nextMicro -= dt;
  if (m.nextMicro <= 0) {
    const list = MICROS[m.loop];
    if (list.length) {
      m.micro = { name: list[Math.floor(m.rng() * list.length)], t: 0, dur: 1.4 + m.rng() * 1.6 };
    }
    m.nextMicro = MICRO_MIN + m.rng() * (MICRO_MAX - MICRO_MIN);
  }
}

function advanceWalk(m: Motion, dt: number, env: MotionEnv) {
  let remaining = m.speed * dt;
  m.walkCycle += dt * m.speed * Math.PI * 1.25;
  while (remaining > 0 && m.seg < m.path.length - 1) {
    const b = m.path[m.seg + 1];
    const dx = b.x - m.pos.x;
    const dy = b.y - m.pos.y;
    const d = Math.hypot(dx, dy);
    if (d > 1e-6) m.facing = dirOf(m.pos, b);
    if (remaining >= d) {
      m.pos = { x: b.x, y: b.y };
      m.seg++;
      remaining -= d;
      if (m.repath) {
        m.repath = false;
        if (!m.goal) { m.phase = 'standing'; m.path = []; return; }
        if (!startWalk(m, env)) { arrive(m); return; }
      }
    } else {
      m.pos = { x: m.pos.x + (dx / d) * remaining, y: m.pos.y + (dy / d) * remaining };
      remaining = 0;
    }
  }
  if (m.seg >= m.path.length - 1) {
    if (m.goal) arrive(m);
    else { m.phase = 'standing'; m.path = []; }
  }
}

/** Advance the state machine by dt seconds. */
export function tick(m: Motion, dt: number, env: MotionEnv) {
  m.clock += dt;
  m.phaseT += dt;

  if (m.gesture) {
    m.gesture.t += dt;
    if (m.gesture.t >= m.gesture.dur) m.gesture = null;
    else return;
  }
  const busyPhase = m.phase === 'walking' || m.phase === 'standing_up' || m.phase === 'sitting_down';
  if (m.queue.length && !busyPhase) {
    const name = m.queue.shift()!;
    m.gesture = { name, t: 0, dur: GESTURE_DUR[name] };
    m.micro = null;
    return;
  }

  switch (m.phase) {
    case 'seated': {
      const g = m.goal;
      if (!g || m.at !== g.key || !g.seated) { m.phase = 'standing_up'; m.phaseT = 0; m.micro = null; return; }
      runLoop(m, dt);
      return;
    }
    case 'standing_up':
      if (m.phaseT >= STAND_UP) { m.phase = 'standing'; m.phaseT = 0; }
      return;
    case 'sitting_down':
      if (m.phaseT >= SIT_DOWN) {
        m.phase = 'seated'; m.phaseT = 0; m.at = m.goal?.key ?? null; m.settle = SETTLE;
        if (m.goal) m.loop = m.goal.loop;
      }
      return;
    case 'standing': {
      const g = m.goal;
      if (!g) { runLoop(m, dt); return; }
      if (m.at === g.key) {
        if (g.seated) { m.phase = 'sitting_down'; m.phaseT = 0; m.facing = g.face; return; }
        runLoop(m, dt);
        return;
      }
      if (Math.round(m.pos.x) === g.x && Math.round(m.pos.y) === g.y) { arrive(m); return; }
      if (!startWalk(m, env)) arrive(m); // unreachable: never freeze, just settle at the goal
      return;
    }
    case 'walking':
      advanceWalk(m, dt, env);
      return;
  }
}
