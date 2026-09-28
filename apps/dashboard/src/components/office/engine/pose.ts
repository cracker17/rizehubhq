// Motion state → a body pose (joint targets in the figure's local space). Pure: no Phaser.
// Local space: feet at (0, 0), y up is negative, "forward" is the facing direction projected to screen.
import type { Facing } from '../logic/map';
import { SIT_DOWN, STAND_UP, type Motion } from '../logic/motion';

export interface V { x: number; y: number }
export type Item =
  | 'mug' | 'phone' | 'tablet' | 'stylus' | 'paddle' | 'magnifier' | 'marker' | 'magazine' | 'swatch' | 'clipboard' | 'mouse' | null;

export interface Pose {
  back: boolean;       // seen from behind (facing up / left)
  flip: boolean;       // mirror horizontally (facing left / down)
  F: V;                // forward unit vector in local space
  hip: V;
  chest: V;            // centre between the shoulders
  head: V;             // head centre
  headTilt: number;
  shoulderN: V; shoulderF: V;
  handN: V; handF: V;
  footN: V; footF: V;
  itemN: Item; itemF: Item;
  mouth: 'closed' | 'open' | 'smile' | 'o';
  eyesClosed: boolean;
  seated: number;      // 0 standing … 1 seated
  crossLegs: boolean;
  steam: boolean;
}

export interface PoseCtx {
  /** Direction towards the CEO office (raise-hand look). */
  lookFacing?: Facing;
  /** 0..1 phase of a paired activity (ping-pong rally etc.). */
  pairPhase?: number;
  /** A role prop the character carries around (tablet, phone…). */
  carry?: Item;
  /** Which side of a pair this character is (for alternating rallies/talk). */
  pairSide?: 0 | 1;
}

type MotionLike = Pick<Motion, 'phase' | 'phaseT' | 'loop' | 'micro' | 'gesture' | 'walkCycle' | 'clock' | 'seed' | 'facing' | 'at' | 'goal'>;

export const STAND_HIP = -24;
export const SIT_HIP = -15;
const TORSO = 20;

export function viewOf(f: Facing): { back: boolean; flip: boolean } {
  switch (f) {
    case 'up': return { back: true, flip: false };
    case 'left': return { back: true, flip: true };
    case 'right': return { back: false, flip: false };
    case 'down': return { back: false, flip: true };
  }
}

const smooth = (x: number) => { const c = Math.max(0, Math.min(1, x)); return c * c * (3 - 2 * c); };
const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k });
const v = (x: number, y: number): V => ({ x, y });
const lerpV = (a: V, b: V, k: number): V => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
/** 0..1 pulse that is "on" for `duty` of each `period` seconds. */
const pulse = (t: number, period: number, duty: number, offset = 0) => (((t + offset) % period) / period < duty ? 1 : 0);
const ease = (t: number, period: number, offset = 0) => 0.5 - 0.5 * Math.cos(((t + offset) / period) * Math.PI * 2);

export function computePose(m: MotionLike, ctx: PoseCtx = {}): Pose {
  const t = m.clock + m.seed * 17;
  const at = !!m.goal && m.at === m.goal.key;
  let facing = m.facing;
  const raising = at && m.loop === 'raise_hand' && !m.gesture;
  // Raised hand alternates with looking towards the CEO office.
  const lookingAtCeo = raising && ctx.lookFacing && Math.sin(t * 0.8) < -0.25;
  if (lookingAtCeo && ctx.lookFacing) facing = ctx.lookFacing;
  if (m.micro?.name === 'look_ceo' && ctx.lookFacing) facing = ctx.lookFacing;
  const { back, flip } = viewOf(facing);
  const F: V = back ? v(0.89, -0.45) : v(0.89, 0.45);
  const fw = (d: number, up = 0): V => v(F.x * d, F.y * d - up);

  // ---- seated amount (acted-out sit down / stand up)
  let seated = 0;
  if (m.phase === 'seated') seated = 1;
  else if (m.phase === 'sitting_down') seated = smooth(m.phaseT / SIT_DOWN);
  else if (m.phase === 'standing_up') seated = 1 - smooth(m.phaseT / STAND_UP);

  const p: Pose = {
    back, flip, F, hip: v(0, 0), chest: v(0, 0), head: v(0, 0), headTilt: 0,
    shoulderN: v(0, 0), shoulderF: v(0, 0), handN: v(0, 0), handF: v(0, 0), footN: v(0, 0), footF: v(0, 0),
    itemN: null, itemF: null, mouth: 'closed', eyesClosed: false, seated, crossLegs: false, steam: false,
  };

  // ---- body frame
  let lean = 0;       // forward lean in px (negative = lean back)
  let bob = Math.sin(t * 1.7) * 0.35; // breathing
  let nod = 0;
  let turnBack = 0;   // head turned away (look aside)
  const walking = m.phase === 'walking';
  if (walking) {
    const c = m.walkCycle;
    bob = -Math.abs(Math.sin(c)) * 1.5;
    lean = 1;
  }
  const hipY = STAND_HIP + (SIT_HIP - STAND_HIP) * seated + bob;
  // Seated hips move a little back into the chair.
  // Seated hips move back into the chair (more when seen from behind, so the backrest lines up).
  p.hip = add(v(0, hipY), fw((back ? -3.5 : -1.5) * seated));

  // Feet: standing stance vs seated (feet forward on the floor).
  const standN = v(-1.2, 0.6);
  const standF = v(1.6, -0.6);
  const sitN = add(fw(8.5), v(-1.8, 0.9));
  const sitF = add(fw(8.5), v(1.8, -0.9));
  p.footN = lerpV(standN, sitN, seated);
  p.footF = lerpV(standF, sitF, seated);
  if (walking) {
    const c = m.walkCycle;
    p.footN = add(standN, add(fw(Math.sin(c) * 5.5), v(0, -Math.max(0, Math.cos(c)) * 2.8)));
    p.footF = add(standF, add(fw(Math.sin(c + Math.PI) * 5.5), v(0, -Math.max(0, Math.cos(c + Math.PI)) * 2.8)));
  }

  // Default hands: hanging (or swinging when walking).
  const frame = () => {
    p.chest = add(add(p.hip, v(0, -TORSO)), fw(lean));
    const near = back ? v(3.6, 0.6) : v(-3.6, 0.6);
    const far = back ? v(-3.6, -0.6) : v(3.6, -0.6);
    p.shoulderN = add(p.chest, near);
    p.shoulderF = add(p.chest, far);
    p.head = add(add(p.chest, v(0, -10 + nod)), fw(lean * 0.3 - turnBack));
  };
  frame();
  const hang = () => {
    p.handN = add(p.shoulderN, v(0.6, 18.5));
    p.handF = add(p.shoulderF, v(0.6, 18.5));
  };
  hang();
  if (walking) {
    const c = m.walkCycle;
    p.handN = add(p.handN, fw(-Math.sin(c) * 4.5));
    p.handF = add(p.handF, fw(Math.sin(c) * 4.5));
    if (ctx.carry && ctx.carry !== 'mouse') { p.handF = add(p.chest, add(fw(5), v(0, 8))); p.itemF = ctx.carry; }
    return p;
  }

  // Helpers relative to the body.
  const desk = (d = 11, down = 9): V => add(p.chest, add(fw(d), v(0, down)));
  const mouthPt = (): V => add(p.head, add(fw(4.5), v(0, 3.5)));
  const earPt = (): V => add(p.head, add(fw(0.5), v(0, 1)));
  const aboveHead = (side: number): V => add(p.head, v(side, -14));
  const typing = (speed: number, amp: number) => {
    p.handN = add(desk(), v(0, Math.sin(t * speed) * amp));
    p.handF = add(desk(12.5, 8), v(0, Math.sin(t * speed + 2.1) * amp));
  };

  // ---- main loops (only once the character has arrived and is not mid-transition)
  const settled = at && (m.phase === 'seated' || m.phase === 'standing');
  if (settled) {
    switch (m.loop) {
      case 'type':
      case 'ceo_desk':
        lean = 1.5; frame();
        typing(19, 1.1);
        nod = Math.sin(t * 2.3) * 0.4; frame(); typing(19, 1.1);
        break;
      case 'write': {
        const burst = Math.sin(t * 0.55) > -0.2;
        lean = burst ? 1.5 : 0.5; frame();
        if (burst) typing(15, 1);
        else { p.handN = add(desk(10, 10), v(Math.sin(t * 1.3) * 1.5, 0)); p.itemN = 'mouse'; p.handF = desk(9, 11); }
        break;
      }
      case 'draw':
        lean = 2; frame();
        p.handN = add(desk(10, 8), v(Math.cos(t * 3.1) * 2.2, Math.sin(t * 4.3) * 1.4)); p.itemN = 'stylus';
        p.handF = desk(9, 10);
        p.headTilt = Math.sin(t * 0.6) * 0.08;
        break;
      case 'scrub':
        lean = 0.5; frame();
        p.handN = add(desk(10, 10), v(Math.sin(t * 0.9) * 3, 0)); p.itemN = 'mouse';
        p.handF = add(desk(11, 9), v(0, Math.sin(t * 7) * 0.5));
        nod = Math.max(0, Math.sin(t * 5.2)) * 0.9; frame();
        break;
      case 'sing': {
        // speaking into the mic with hand gestures
        const g = ease(t, 2.6);
        p.handN = add(p.chest, add(fw(7 + g * 4), v(0, 4 - g * 6)));
        p.handF = pulse(t, 9, 0.35) ? earPt() : add(p.shoulderF, v(1, 17));
        p.mouth = Math.sin(t * 9) > 0 ? 'open' : 'o';
        nod = Math.sin(t * 2.6) * 0.6; frame();
        break;
      }
      case 'whiteboard': {
        const writing = Math.sin(t * 0.4) > -0.5;
        p.handN = writing
          ? add(p.chest, add(fw(12), v(Math.cos(t * 5) * 2.5, -8 + Math.sin(t * 3.7) * 2)))
          : add(p.chest, add(fw(15), v(0, -12)));
        p.itemN = 'marker';
        p.handF = add(p.shoulderF, v(1, 17));
        break;
      }
      case 'call':
        lean = -1; frame();
        p.handF = earPt(); p.itemF = 'phone';
        p.handN = add(p.chest, add(fw(6 + ease(t, 3) * 5), v(0, 6)));
        p.mouth = Math.sin(t * 7) > 0.3 ? 'open' : 'closed';
        nod = Math.sin(t * 1.5) * 0.5; frame();
        break;
      case 'review':
        lean = 3.5; frame();
        p.handN = add(p.head, add(fw(8), v(0, 5))); p.itemN = 'magnifier';
        p.handF = add(desk(11, 10), v(pulse(t, 1.6, 0.2) ? 0.8 : 0, 0)); p.itemF = 'mouse';
        break;
      case 'inspect':
        lean = 3; frame();
        p.handN = add(p.head, add(fw(9), v(Math.sin(t * 0.7) * 3, 3))); p.itemN = 'magnifier';
        p.handF = add(p.chest, add(fw(10), v(0, 6 + (pulse(t, 1.3, 0.2) ? -1 : 0))));
        break;
      case 'present': {
        const g = ease(t, 3.2);
        p.handN = add(p.chest, add(fw(8 + g * 6), v(0, 2 - g * 10)));
        p.handF = pulse(t, 10, 0.5) ? add(p.chest, add(fw(6), v(0, 8))) : add(p.shoulderF, v(1, 17));
        if (pulse(t, 10, 0.5)) p.itemF = 'tablet';
        p.mouth = Math.sin(t * 6) > 0 ? 'open' : 'closed';
        break;
      }
      case 'meeting':
        p.handN = desk(9, 12); p.handF = desk(10, 12);
        nod = pulse(t, 5, 0.25) ? Math.sin(t * 9) * 0.8 : 0; frame();
        break;
      case 'wait_qa': {
        lean = -2.5; frame();
        const sip = pulse(t, 6, 0.3);
        p.handN = sip ? mouthPt() : add(p.chest, add(fw(5), v(0, 9)));
        p.itemN = 'mug'; p.steam = !sip;
        p.handF = add(p.hip, add(fw(5), v(0, -1)));
        break;
      }
      case 'raise_hand':
        if (lookingAtCeo) { p.handN = add(p.shoulderN, v(0.5, 18)); p.handF = add(p.shoulderF, v(0.5, 18)); }
        else {
          p.handN = add(aboveHead(back ? 5 : -4), v(Math.sin(t * 5) * 1.6, 0));
          p.handF = add(p.shoulderF, v(0.6, 18));
        }
        break;
      case 'head_in_hands':
        lean = 4; nod = 2.5; frame();
        p.handN = add(p.head, add(fw(3), v(-1, 4)));
        p.handF = add(p.head, add(fw(3), v(1, 3)));
        break;
      case 'desk_idle':
        lean = -2; frame();
        p.handN = add(p.chest, add(fw(6), v(0, 7))); p.itemN = 'phone';
        p.handF = add(p.hip, add(fw(5), v(0, -1)));
        nod = 1; frame();
        break;
      case 'coffee': {
        const sip = pulse(t, 5.5, 0.28, m.seed * 5);
        p.handN = sip ? mouthPt() : add(p.chest, add(fw(5), v(0, 6)));
        p.itemN = 'mug'; p.steam = !sip;
        p.handF = add(p.shoulderF, v(0.8, 18));
        break;
      }
      case 'sofa':
        lean = -3; frame();
        p.handN = add(p.hip, add(fw(5), v(0, -2)));
        p.handF = add(p.hip, add(fw(4), v(0, -3)));
        p.crossLegs = m.seed > 0.5;
        break;
      case 'lobby_sit':
        lean = -1; frame();
        p.handN = add(p.chest, add(fw(7), v(0, 6))); p.itemN = 'magazine';
        p.handF = add(p.chest, add(fw(7), v(0, 8)));
        break;
      case 'lobby_stand':
        p.handF = earPt(); p.itemF = 'phone';
        p.mouth = Math.sin(t * 6) > 0.4 ? 'open' : 'closed';
        p.hip = add(p.hip, v(Math.sin(t * 0.8) * 0.8, 0)); frame(); p.handF = earPt();
        break;
      case 'pingpong': {
        // Rally: hit when the ball arrives on this side.
        const ph = ((ctx.pairPhase ?? t / 1.6) + (ctx.pairSide ? 0.5 : 0)) % 1;
        const swing = Math.exp(-Math.pow((ph - 0.02) * 9, 2)) + Math.exp(-Math.pow((ph - 1.02) * 9, 2));
        lean = 2; frame();
        p.handN = add(p.chest, add(fw(7 + swing * 6), v(-2 + swing * 3, 7 - swing * 8))); p.itemN = 'paddle';
        p.handF = add(p.chest, add(fw(4), v(0, 9)));
        p.hip = add(p.hip, v(Math.sin(ph * Math.PI * 2) * 1.2, 0)); frame();
        break;
      }
      case 'foosball': {
        lean = 3; frame();
        p.handN = add(desk(10, 11), v(Math.sin(t * 11) * 1.5, 0));
        p.handF = add(desk(11, 11), v(Math.sin(t * 9 + 1) * 1.5, 0));
        break;
      }
      case 'chat': {
        const talking = ((ctx.pairPhase ?? t / 6) + (ctx.pairSide ? 0.5 : 0)) % 1 < 0.5;
        if (talking) {
          const g = ease(t, 1.7);
          p.handN = add(p.chest, add(fw(6 + g * 5), v(0, 7 - g * 5)));
          p.mouth = Math.sin(t * 8) > 0 ? 'open' : 'closed';
        } else {
          nod = Math.max(0, Math.sin(t * 4)) * 0.8; frame();
          p.handN = add(p.shoulderN, v(0.6, 18));
        }
        p.handF = add(p.shoulderF, v(0.6, 18));
        if (ctx.carry === 'phone' || ctx.carry === 'tablet') { p.handF = add(p.chest, add(fw(5), v(0, 8))); p.itemF = ctx.carry; }
        break;
      }
      case 'stand':
      default:
        p.hip = add(p.hip, v(Math.sin(t * 0.7) * 0.6, 0)); frame(); hang();
        break;
    }
  } else if (ctx.carry && ctx.carry !== 'mouse') {
    p.handF = add(p.chest, add(fw(5), v(0, 8))); p.itemF = ctx.carry;
  }

  // ---- micro-actions (short overlays on the main loop)
  const mic = m.micro;
  if (settled && mic) {
    const k = Math.sin(Math.min(1, mic.t / mic.dur) * Math.PI); // 0 → 1 → 0
    switch (mic.name) {
      case 'lean_in': case 'check_wave': lean += 3 * k; frame(); break;
      case 'lean_back': case 'step_back': lean -= 3.5 * k; frame(); if (k > 0.3) { p.handN = add(p.head, v(-3, 1)); p.handF = add(p.head, v(3, 0)); } break;
      case 'rub_chin': p.handF = add(p.head, add(fw(4), v(0, 6 + Math.sin(t * 8)))); break;
      case 'sip': case 'blow': p.handN = mouthPt(); p.itemN = 'mug'; p.mouth = mic.name === 'blow' ? 'o' : 'closed'; break;
      case 'glance': case 'look_view': case 'turn_chat': turnBack = 2.5 * k; frame(); p.headTilt = -0.06 * k; break;
      case 'crack_knuckles': p.handN = add(p.chest, add(fw(7), v(-1, 5))); p.handF = add(p.chest, add(fw(7), v(1, 5))); break;
      case 'stretch': case 'celebrate': p.handN = aboveHead(-3); p.handF = aboveHead(4); p.mouth = 'smile'; break;
      case 'nod': case 'nod_rhythm': nod = Math.sin(mic.t * 10) * 1.2; frame(); break;
      case 'note': case 'sketch': case 'tick': p.handN = add(desk(9, 11), v(Math.sin(t * 12) * 1.2, 0)); p.itemN = 'stylus'; break;
      case 'scroll': case 'drag': p.handN = add(desk(10, 10), v(Math.sin(t * 2) * 2.5, 0)); p.itemN = 'mouse'; break;
      case 'tilt_head': p.headTilt = 0.18 * k; break;
      case 'swatch': p.handF = add(p.head, add(fw(7), v(0, 2))); p.itemF = 'swatch'; break;
      case 'adjust_headphones': case 'listen': p.handF = earPt(); if (mic.name === 'adjust_headphones') p.handN = add(p.head, v(-3, 0)); break;
      case 'point': p.handN = add(p.chest, add(fw(16), v(0, -10))); break;
      case 'tablet': case 'compare_phone': p.handF = add(p.chest, add(fw(7), v(0, 3))); p.itemF = mic.name === 'tablet' ? 'tablet' : 'phone'; break;
      case 'rub_eyes': p.handN = add(p.head, add(fw(4), v(0, 0))); p.eyesClosed = true; break;
      case 'thumbs_up': p.handN = add(p.chest, add(fw(9), v(0, -6))); p.mouth = 'smile'; break;
      case 'phone': case 'point_phone': p.handN = add(p.chest, add(fw(mic.name === 'point_phone' ? 10 : 6), v(0, 4))); p.itemN = 'phone'; break;
      case 'cross_legs': p.crossLegs = !p.crossLegs; break;
      case 'laugh': nod = -1.5 * k; frame(); p.mouth = 'open'; p.eyesClosed = true; break;
      case 'magazine': p.handN = add(p.chest, add(fw(7), v(0, 4))); p.itemN = 'magazine'; break;
      case 'pace': p.hip = add(p.hip, fw(Math.sin(mic.t * 3) * 2)); frame(); break;
      case 'groan': nod = 2 * k; frame(); p.handN = add(p.head, v(-2, -5)); break;
      case 'sigh': nod = -1.5 * k; frame(); p.eyesClosed = true; break;
      case 'look_ceo': break;
    }
  }

  // ---- gestures (override arms)
  const g = m.gesture;
  if (g) {
    const k = g.t / g.dur;
    switch (g.name) {
      case 'done': {
        const up = Math.sin(Math.min(1, k * 1.4) * Math.PI);
        p.handN = lerpV(add(p.shoulderN, v(0, 17)), aboveHead(-4), up);
        p.handF = lerpV(add(p.shoulderF, v(0, 17)), add(aboveHead(4), v(0, Math.sin(k * 18) * 2)), up);
        p.mouth = 'smile';
        break;
      }
      case 'scratch':
        p.handN = add(p.head, v(Math.sin(k * 30) * 1.5, -7));
        p.headTilt = 0.12;
        break;
      case 'nod':
        nod = Math.sin(k * Math.PI * 4) * 1.6; frame();
        p.mouth = 'smile';
        break;
      case 'wave':
        p.handN = add(aboveHead(-3), v(Math.sin(k * 25) * 2.5, 3));
        p.mouth = 'smile';
        break;
    }
  }
  return p;
}

/** Two-bone IK: elbow/knee position for a limb from `a` to target `b`. `bend` chooses the side. */
export function ik(a: V, b: V, l1: number, l2: number, bend: V): V {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let d = Math.hypot(dx, dy);
  const max = l1 + l2 - 0.01;
  if (d > max) d = max;
  if (d < 0.01) return add(a, v(0, l1));
  const ux = dx / Math.hypot(dx, dy);
  const uy = dy / Math.hypot(dx, dy);
  const x = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  const m1 = { x: a.x + ux * x - uy * h, y: a.y + uy * x + ux * h };
  const m2 = { x: a.x + ux * x + uy * h, y: a.y + uy * x - ux * h };
  const s1 = (m1.x - a.x) * bend.x + (m1.y - a.y) * bend.y;
  const s2 = (m2.x - a.x) * bend.x + (m2.y - a.y) * bend.y;
  return s1 >= s2 ? m1 : m2;
}

export { mul };
