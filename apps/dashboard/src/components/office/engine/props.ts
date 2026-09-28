// Procedural furniture art for the isometric office (placeholder art until the 3D pipeline, docs/07 §10).
// Every prop is baked once into a texture; large props people sit around are baked per tile ("slices")
// so painter's-order depth sorting against characters stays correct.
import type Phaser from 'phaser';
import type { Facing, Prop } from '../logic/map';
import { bake, box, floorQuad, plant, poly, shadow, wallX, wallY, type Baked, type G, type Proj } from './art';
import { shade } from './looks';

const OAK = 0xd2a878;
const OAK_S = 0xbb8f60;
const OAK_E = 0xa0754b;
const WALNUT = 0x7b5439;
const METAL = 0x3b3f47;
const WHITE = 0xf2f0ea;

// ---------------------------------------------------------------- desks
/** Map desk-local (a along the long side, b from monitor side (0) to person side (1)) → tile coords. */
function deskMap(face: Facing) {
  // 'up': long axis x, monitor at small y. 'left': long axis y, monitor at small x.
  return face === 'left'
    ? { t: (a: number, b: number) => [b, a] as const }
    : { t: (a: number, b: number) => [a, b] as const };
}

function dBox(g: G, P: Proj, face: Facing, a0: number, b0: number, a1: number, b1: number, z0: number, z1: number, top: number, s?: number, e?: number) {
  const { t } = deskMap(face);
  const [x0, y0] = t(a0, b0);
  const [x1, y1] = t(a1, b1);
  box(g, P, Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1), z0, z1, top, s, e);
}

function monitorFrame(g: G, P: Proj, face: Facing, a0: number, a1: number, wide = false) {
  const mid = (a0 + a1) / 2;
  dBox(g, P, face, mid - 0.05, 0.3, mid + 0.05, 0.4, 26.5, 31, METAL);
  dBox(g, P, face, mid - 0.18, 0.28, mid + 0.18, 0.46, 26.5, 27.3, 0x4a4f58);
  dBox(g, P, face, a0, 0.22, a1, 0.32, 31, wide ? 51 : 51, 0x22252b, 0x2a2d34, 0x1b1d22);
}

export const DESK_TOP = 26.5;

/** Monitors (a-ranges along the desk) per desk kind; screens are separate sprites placed on these. */
export function monitorsFor(kind: string): [number, number][] {
  switch (kind) {
    case 'dual':
    case 'edit_bay':
      return [[0.6, 1.48], [1.52, 2.4]];
    default:
      return [[1.05, 1.95]];
  }
}

function deskDecor(g: G, P: Proj, face: Facing, kind: string, agentId: string) {
  const squeeze = (a: number) => 1.5 + (a - 1.5) * 0.62;
  const at = (a: number, b: number, z = DESK_TOP) => { const { t } = deskMap(face); const [x, y] = t(squeeze(a), b); return P(x, y, z); };
  const dB = (a0: number, b0: number, a1: number, b1: number, z0: number, z1: number, top: number, s2?: number, e2?: number) => { const c = squeeze((a0 + a1) / 2); const hw = (a1 - a0) / 2; dBox(g, P, face, c - hw, b0, c + hw, b1, z0, z1, top, s2, e2); };
  // keyboard + mouse
  if (kind !== 'designer') dB(1.12, 0.54, 1.88, 0.68, DESK_TOP, DESK_TOP + 0.9, 0xe4e5ea);
  const m = at(2.1, 0.62, DESK_TOP + 1);
  g.fillStyle(0xdadbe2, 1); g.fillEllipse(m.x, m.y, 5, 3);
  if (kind === 'designer') {
    dB(1.12, 0.5, 1.9, 0.78, DESK_TOP, DESK_TOP + 0.8, 0x2b2d33); // pen tablet
    dB(1.22, 0.55, 1.8, 0.73, DESK_TOP + 0.8, DESK_TOP + 0.9, 0x40444c);
  }
  // per-role touches
  const mug = (a: number, b: number, c = 0xf5f2ec) => { const p = at(a, b); g.fillStyle(c, 1); g.fillRoundedRect(p.x - 2.5, p.y - 6, 5, 6, 1.2); g.fillStyle(0x5a3a28, 1); g.fillEllipse(p.x, p.y - 6, 4.4, 1.6); };
  const books = (a: number, b: number) => {
    const cols = [0x8e3b46, 0x2f5d8a, 0xd9a441, 0x3f7d4e];
    cols.forEach((c, i) => dB(a, b, a + 0.3, b + 0.22, DESK_TOP + i * 2.4, DESK_TOP + i * 2.4 + 2.2, c));
  };
  const papers = (a: number, b: number) => dB(a, b, a + 0.34, b + 0.26, DESK_TOP, DESK_TOP + 1.6, 0xfafafa, 0xe6e6e6, 0xdcdcdc);
  const smallPlant = (a: number, b: number) => { const p = at(a, b); g.fillStyle(0xe9e3d8, 1); g.fillRect(p.x - 2.5, p.y - 5, 5, 5); g.fillStyle(0x4f9a5c, 1); g.fillCircle(p.x - 1.5, p.y - 8, 3); g.fillCircle(p.x + 1.8, p.y - 9, 2.6); g.fillCircle(p.x, p.y - 11, 2.4); };
  switch (agentId) {
    case 'seo-1': case 'seo-2': books(0.25, 0.3); mug(2.55, 0.62); break;
    case 'video-editor': {
      // clapperboard
      dB(0.22, 0.4, 0.62, 0.62, DESK_TOP, DESK_TOP + 1.4, 0x1c1c1f);
      const c = at(0.24, 0.42, DESK_TOP + 1.4);
      g.fillStyle(0xf2f2f2, 1); for (let i = 0; i < 3; i++) g.fillRect(c.x + 3 + i * 5, c.y - 2, 2.6, 2);
      // jog wheel
      const j = at(2.62, 0.62, DESK_TOP + 1); g.fillStyle(0x2b2d33, 1); g.fillEllipse(j.x, j.y, 9, 5); g.fillStyle(0x6c7380, 1); g.fillEllipse(j.x, j.y - 1, 5, 2.6);
      break;
    }
    case 'prospector': { const p = at(0.4, 0.55); g.fillStyle(0x2d3035, 1); g.fillEllipse(p.x - 3, p.y - 3, 6, 5); g.fillEllipse(p.x + 3, p.y - 3, 6, 5); mug(2.5, 0.6, 0xff7a59); break; }
    case 'job-scout': { papers(0.2, 0.36); const p = at(0.36, 0.48, DESK_TOP + 1.6); [0xe5484d, 0x3ba7ff, 0xf5a524].forEach((c, i) => { g.fillStyle(c, 1); g.fillCircle(p.x - 4 + i * 4, p.y - 1 - i, 1.4); }); break; }
    case 'pipeline': papers(0.22, 0.4); mug(2.55, 0.55); break;
    case 'ea': papers(0.24, 0.34); papers(0.28, 0.4); smallPlant(2.6, 0.35); break;
    case 'client-success': smallPlant(0.3, 0.35); mug(2.5, 0.6, 0x38bdf8); break;
    case 'coo': papers(0.25, 0.35); { const p = at(2.45, 0.45); g.fillStyle(0x222228, 1); g.fillRect(p.x - 4, p.y - 2, 8, 2.5); } break;
    case 'qa-lead': { const p = at(0.4, 0.45); g.fillStyle(0x1d1d22, 1); g.fillRoundedRect(p.x - 3, p.y - 9, 6, 9, 1.2); g.fillStyle(0x8fd3ff, 1); g.fillRect(p.x - 2, p.y - 8, 4, 7); mug(2.5, 0.6, 0x14b8a6); break; }
    case 'inbound': mug(2.5, 0.6, 0xff5fa2); smallPlant(0.3, 0.35); break;
    case 'social-1': case 'social-2': smallPlant(0.3, 0.3); mug(2.55, 0.62, 0xec4899); break;
    case 'uiux-1': case 'uiux-2': case 'graphic-1': case 'graphic-2': {
      const p = at(0.35, 0.55);
      [0xf94144, 0xf9c74f, 0x43aa8b, 0x577590].forEach((c, i) => { g.fillStyle(c, 1); g.fillRect(p.x - 6 + i * 3.2, p.y - 3 - i * 0.6, 2.8, 4); });
      mug(2.55, 0.62);
      break;
    }
    default: mug(2.55, 0.6); smallPlant(0.3, 0.35);
  }
}

function drawDesk(g: G, P: Proj, face: Facing, kind: string, agentId: string) {
  const white = kind === 'qa' || kind === 'designer';
  const top = white ? WHITE : OAK;
  // legs + modesty panel
  for (const [a, b] of [[0.6, 0.14], [2.3, 0.14], [0.6, 0.78], [2.3, 0.78]] as const) dBox(g, P, face, a, b, a + 0.1, b + 0.1, 0, 24, METAL);
  dBox(g, P, face, 0.7, 0.1, 2.3, 0.15, 8, 24, shade(top, 0.6));
  // top
  const { t } = deskMap(face);
  shadow(g, P, ...(t(1.5, 0.5) as [number, number]), 0.8, 0.35, 0.1);
  dBox(g, P, face, 0.52, 0.08, 2.48, 0.92, 24, DESK_TOP, top, white ? 0xdedbd2 : OAK_S, white ? 0xc9c5ba : OAK_E);
  if (kind === 'edit_bay') {
    // extra reference monitor on an arm + speakers
    dBox(g, P, face, 0.56, 0.3, 0.7, 0.46, DESK_TOP, DESK_TOP + 12, 0x2a2c31);
    dBox(g, P, face, 2.3, 0.3, 2.44, 0.46, DESK_TOP, DESK_TOP + 12, 0x2a2c31);
  }
  for (const [a0, a1] of monitorsFor(kind)) monitorFrame(g, P, face, a0, a1);
  deskDecor(g, P, face, kind, agentId);
}

function drawCeoDesk(g: G, P: Proj) {
  // 3 × 1, person sits on the -y side (facing down), monitor back towards the viewer.
  for (const [x, y] of [[0.15, 0.12], [2.75, 0.12], [0.15, 0.78], [2.75, 0.78]] as const) box(g, P, x, y, x + 0.1, y + 0.1, 0, 24, 0x2a2b30);
  box(g, P, 0.3, 0.8, 2.7, 0.88, 4, 24, shade(WALNUT, 0.85));
  shadow(g, P, 1.5, 0.5, 1.1, 0.35, 0.12);
  box(g, P, 0.08, 0.06, 2.92, 0.94, 24, 27.5, WALNUT, shade(WALNUT, 0.85), shade(WALNUT, 0.72));
  // monitor (back side visible)
  box(g, P, 1.45, 0.55, 1.55, 0.65, 27.5, 32, METAL);
  box(g, P, 1.02, 0.6, 1.98, 0.7, 32, 52, 0x2b2e35, 0x33363e, 0x24262c);
  // laptop, lamp, nameplate
  box(g, P, 0.3, 0.3, 0.8, 0.62, 27.5, 28.4, 0xb8bcc4);
  box(g, P, 2.35, 0.3, 2.45, 0.4, 27.5, 44, 0x2a2b30);
  const l = P(2.4, 0.35, 44);
  g.fillStyle(0xf4d58d, 1); g.fillEllipse(l.x, l.y, 10, 5);
  box(g, P, 1.3, 0.78, 1.7, 0.86, 27.5, 30, 0x1b1b1e);
  const n = P(1.35, 0.86, 29);
  g.fillStyle(0xd4b26a, 1); g.fillRect(n.x + 1, n.y - 1, 9, 1.4);
}

// ---------------------------------------------------------------- chairs
export function drawChair(g: G, P: Proj, face: Facing, color = 0x3d424b) {
  const base = 0x2b2e34;
  // star base + wheels
  const c = P(0.5, 0.5, 2);
  g.lineStyle(2, base, 1);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    const e = P(0.5 + Math.cos(a) * 0.28, 0.5 + Math.sin(a) * 0.28, 1.5);
    g.lineBetween(c.x, c.y, e.x, e.y);
    g.fillStyle(0x1b1c20, 1); g.fillCircle(e.x, e.y + 1, 1.6);
  }
  box(g, P, 0.47, 0.47, 0.53, 0.53, 2, 13, 0x6b7079);
  const back = () => {
    switch (face) {
      case 'up': box(g, P, 0.24, 0.74, 0.76, 0.82, 17, 29, color); box(g, P, 0.47, 0.7, 0.53, 0.76, 13, 18, base); break;
      case 'left': box(g, P, 0.74, 0.24, 0.82, 0.76, 17, 29, color); box(g, P, 0.7, 0.47, 0.76, 0.53, 13, 18, base); break;
      case 'down': box(g, P, 0.3, 0.16, 0.7, 0.24, 17, 32, color); break;
      case 'right': box(g, P, 0.16, 0.3, 0.24, 0.7, 17, 32, color); break;
    }
  };
  if (face === 'down' || face === 'right') back();
  box(g, P, 0.24, 0.24, 0.76, 0.76, 13, 16.5, color, shade(color, 0.8), shade(color, 0.66));
  if (face === 'up' || face === 'left') back();
}

// ---------------------------------------------------------------- seating (sofas, couch, armchair) per tile
export function drawSeatTile(g: G, P: Proj, face: Facing, color: number, armLo: boolean, armHi: boolean) {
  const cush = shade(color, 1.12);
  // Backrest on the side opposite the facing; arms at the ends of the run.
  const along = face === 'up' || face === 'down' ? 'x' : 'y';
  const backAt = { right: 'x0', left: 'x1', down: 'y0', up: 'y1' }[face];
  const drawBack = () => {
    if (backAt === 'x0') box(g, P, 0, 0, 0.28, 1, 0, 32, color);
    if (backAt === 'x1') box(g, P, 0.72, 0, 1, 1, 0, 32, color);
    if (backAt === 'y0') box(g, P, 0, 0, 1, 0.28, 0, 32, color);
    if (backAt === 'y1') box(g, P, 0, 0.72, 1, 1, 0, 32, color);
  };
  const drawArms = () => {
    if (along === 'y') {
      if (armLo) box(g, P, 0, 0, 1, 0.16, 0, 22, shade(color, 0.95));
      if (armHi) box(g, P, 0, 0.84, 1, 1, 0, 22, shade(color, 0.95));
    } else {
      if (armLo) box(g, P, 0, 0, 0.16, 1, 0, 22, shade(color, 0.95));
      if (armHi) box(g, P, 0.84, 0, 1, 1, 0, 22, shade(color, 0.95));
    }
  };
  shadow(g, P, 0.5, 0.5, 0.45, 0.45, 0.12);
  const far = backAt === 'x0' || backAt === 'y0';
  if (far) drawBack();
  if (armLo && far) drawArms();
  box(g, P, 0, 0, 1, 1, 0, 11, color);
  const c0 = backAt === 'x0' ? [0.28, 0.02, 0.98, 0.98] : backAt === 'x1' ? [0.02, 0.02, 0.72, 0.98] : backAt === 'y0' ? [0.02, 0.28, 0.98, 0.98] : [0.02, 0.02, 0.98, 0.72];
  box(g, P, c0[0], c0[1], c0[2], c0[3], 11, 15, cush);
  if (!far) drawBack();
  if (!far || !armLo) drawArms();
}

// ---------------------------------------------------------------- slices of big props
export interface SliceSpec { key: string; tx: number; ty: number; draw: (g: G, P: Proj) => void; maxH: number }

function sliceBox(i: number, j: number, w: number, h: number, z0: number, z1: number, top: number, s: number, e: number) {
  return (g: G, P: Proj) => {
    // Only the outer faces of the whole prop are visible.
    if (j === h - 1) poly(g, [P(0, 1, z0), P(1, 1, z0), P(1, 1, z1), P(0, 1, z1)], s);
    if (i === w - 1) poly(g, [P(1, 0, z0), P(1, 1, z0), P(1, 1, z1), P(1, 0, z1)], e);
    floorQuad(g, P, 0, 0, 1, 1, z1, top);
  };
}

function legsAt(g: G, P: Proj, i: number, j: number, w: number, h: number, z: number, color: number, inset = 0.12) {
  const xs = [i === 0 ? inset : -1, i === w - 1 ? 1 - inset - 0.1 : -1].filter((x) => x >= 0);
  const ys = [j === 0 ? inset : -1, j === h - 1 ? 1 - inset - 0.1 : -1].filter((y) => y >= 0);
  for (const x of xs) for (const y of ys) box(g, P, x, y, x + 0.1, y + 0.1, 0, z, color);
}

export function slicesFor(p: Prop): SliceSpec[] | null {
  const out: SliceSpec[] = [];
  const each = (maxH: number, fn: (i: number, j: number) => (g: G, P: Proj) => void, keyOf: (i: number, j: number) => string) => {
    for (let i = 0; i < p.w; i++) for (let j = 0; j < p.h; j++) out.push({ key: keyOf(i, j), tx: p.x + i, ty: p.y + j, draw: fn(i, j), maxH });
  };
  switch (p.kind) {
    case 'meeting_table':
      each(40, (i, j) => (g, P) => {
        legsAt(g, P, i, j, p.w, p.h, 24, 0x2a2b30, 0.2);
        shadow(g, P, 0.5, 0.5, 0.4, 0.4, 0.08);
        sliceBox(i, j, p.w, p.h, 24, 27, 0x6f4a33, 0x5c3c29, 0x4b3021)(g, P);
        // table setting: notepads + glasses on the edge tiles
        if ((j === 0 || j === p.h - 1) && i % 2 === 1) {
          floorQuad(g, P, 0.3, j === 0 ? 0.15 : 0.55, 0.7, j === 0 ? 0.45 : 0.85, 27.2, 0xf6f4ee);
          const c = P(0.8, j === 0 ? 0.3 : 0.7, 27);
          g.fillStyle(0xbfe3f2, 0.8); g.fillRect(c.x - 1.5, c.y - 5, 3, 5);
        }
        if (i === 2 && j === 1) { box(g, P, 0.3, 0.3, 0.7, 0.7, 27, 28, 0x2b2d33); const c = P(0.5, 0.5, 28); g.fillStyle(0x6d4aff, 1); g.fillCircle(c.x, c.y, 2); }
      }, (i, j) => `mt-${i}-${j}-${p.w}-${p.h}`);
      return out;
    case 'bar':
      each(56, (i, j) => (g, P) => {
        sliceBox(i, j, p.w, p.h, 0, 32, 0x2e2f33, 0xc49a6c, 0xa77e52)(g, P);
        // slatted front
        for (let k = 1; k < 6; k++) { const a = P(k / 6, 1, 2); const b = P(k / 6, 1, 30); g.lineStyle(0.8, 0x9c7449, 0.9); g.lineBetween(a.x, a.y, b.x, b.y); }
        floorQuad(g, P, 0, 0, 1, 1, 32, 0x3a3b40);
        floorQuad(g, P, 0, 0.9, 1, 1, 32.2, 0x55565c);
        if (i === 1) {
          // espresso machine
          box(g, P, 0.15, 0.1, 0.85, 0.6, 32, 50, 0xc9ced6, 0xaeb4bd, 0x949aa4);
          box(g, P, 0.2, 0.55, 0.8, 0.62, 38, 44, 0x2b2d33);
          const r = P(0.3, 0.6, 47); g.fillStyle(0xe5484d, 1); g.fillCircle(r.x, r.y, 1.2);
          box(g, P, 0.35, 0.5, 0.45, 0.6, 33, 36, 0xf5f2ec); box(g, P, 0.6, 0.5, 0.7, 0.6, 33, 36, 0xf5f2ec);
        }
        if (i === 2) { box(g, P, 0.25, 0.2, 0.55, 0.5, 32, 46, 0x2b2d33); box(g, P, 0.3, 0.25, 0.5, 0.45, 46, 52, 0x6b4430); }
        if (i === 0) { for (let k = 0; k < 3; k++) box(g, P, 0.2 + k * 0.2, 0.3, 0.35 + k * 0.2, 0.45, 32, 36 + k * 0.5, 0xf5f2ec); }
        if (i === 3) { const c = P(0.5, 0.4, 32); g.fillStyle(0xe8e0d0, 1); g.fillEllipse(c.x, c.y, 18, 8); g.fillStyle(0xc88a4a, 1); g.fillCircle(c.x - 3, c.y - 2, 3); g.fillCircle(c.x + 3, c.y - 1, 3); g.fillStyle(0x8a4a2a, 1); g.fillCircle(c.x, c.y - 3, 2.6); }
      }, (i, j) => `bar-${i}-${j}`);
      return out;
    case 'pingpong':
      each(32, (i, j) => (g, P) => {
        if ((i === 0 || i === p.w - 1) && (j === 0 || j === p.h - 1)) legsAt(g, P, i, j, p.w, p.h, 23, 0x2a2b30, 0.15);
        shadow(g, P, 0.5, 0.5, 0.4, 0.4, 0.07);
        sliceBox(i, j, p.w, p.h, 23, 25, 0x1d6f8e, 0x175a73, 0x124a5f)(g, P);
        // white lines
        if (j === 0) floorQuad(g, P, 0, 0, 1, 0.04, 25.1, 0xffffff);
        if (j === p.h - 1) floorQuad(g, P, 0, 0.96, 1, 1, 25.1, 0xffffff);
        if (i === 0) floorQuad(g, P, 0, 0, 0.04, 1, 25.1, 0xffffff);
        if (i === p.w - 1) floorQuad(g, P, 0.96, 0, 1, 1, 25.1, 0xffffff);
        floorQuad(g, P, 0, j === 0 ? 0.98 : 0, 1, j === 0 ? 1 : 0.02, 25.1, 0xffffff, 0.8);
        if (i === 1) {
          // net across the middle
          wallX(g, P, 0.5, j === 0 ? -0.05 : 0, j === p.h - 1 ? 1.05 : 1, 25, 31, 0xf2f2f2, 0.55);
          const a = P(0.5, 0, 31); const b = P(0.5, 1, 31); g.lineStyle(1, 0xffffff, 1); g.lineBetween(a.x, a.y, b.x, b.y);
        }
      }, (i, j) => `pp-${i}-${j}`);
      return out;
    case 'reception':
      each(48, (i, j) => (g, P) => {
        sliceBox(i, j, p.w, p.h, 0, 30, WHITE, 0xe9e6de, 0xd5d1c6)(g, P);
        floorQuad(g, P, 0, 0.35, 1, 1, 30.5, OAK);
        if (i === 1) { const c = P(0.5, 1, 18); g.fillStyle(0x6d4aff, 1); g.fillRoundedRect(c.x - 7, c.y - 7, 14, 12, 3); g.fillStyle(0xffffff, 1); g.fillRect(c.x - 2.5, c.y - 4, 2, 7); g.fillRect(c.x - 2.5, c.y - 4, 5, 2); }
        if (i === 2) { box(g, P, 0.3, 0.1, 0.7, 0.2, 30, 46, 0x2b2e35); }
        if (i === 0) plantTop(g, P);
      }, (i, j) => `rc-${i}-${j}`);
      return out;
    case 'qa_bench':
      each(70, (i, j) => (g, P) => {
        legsAt(g, P, i, j, p.w, p.h, 24, METAL, 0.12);
        sliceBox(i, j, p.w, p.h, 24, 26.5, WHITE, 0xdedbd2, 0xc9c5ba)(g, P);
        if (i === 1) {
          box(g, P, 0.45, 0.2, 0.55, 0.3, 26.5, 34, METAL);
          box(g, P, -0.25, 0.1, 1.25, 0.2, 34, 64, 0x1f2227);
        }
        // phones + tablet on stands
        if (i === 0) { box(g, P, 0.3, 0.5, 0.45, 0.6, 26.5, 36, 0x1d1d22); box(g, P, 0.6, 0.45, 0.85, 0.6, 26.5, 40, 0x1d1d22); }
        if (i === 2) { box(g, P, 0.2, 0.45, 0.45, 0.6, 26.5, 38, 0x1d1d22); floorQuad(g, P, 0.55, 0.45, 0.9, 0.8, 26.7, 0xf6f4ee); }
      }, (i, j) => `qb-${i}-${j}`);
      return out;
    case 'sofa':
    case 'couch': {
      const color = p.variant ? parseInt(p.variant.replace('#', ''), 16) : 0x6f8f7a;
      const along = p.w > 1 ? 'x' : 'y';
      each(34, (i, j) => (g, P) => {
        const idx = along === 'x' ? i : j;
        const n = along === 'x' ? p.w : p.h;
        drawSeatTile(g, P, p.face ?? 'right', color, idx === 0, idx === n - 1);
      }, (i, j) => `seat-${p.face}-${color}-${along === 'x' ? i : j}-${along === 'x' ? p.w : p.h}`);
      return out;
    }
    default:
      return null;
  }
}

function plantTop(g: G, P: Proj) {
  const c = P(0.3, 0.2, 30);
  g.fillStyle(0xe9e3d8, 1); g.fillRect(c.x - 3, c.y - 6, 6, 6);
  g.fillStyle(0x4f9a5c, 1); g.fillCircle(c.x - 2, c.y - 10, 3.4); g.fillCircle(c.x + 2, c.y - 11, 3); g.fillCircle(c.x, c.y - 13.5, 2.8);
}

// ---------------------------------------------------------------- single-image props
export function propMaxH(p: Prop): number {
  switch (p.kind) {
    case 'plant': return 70;
    case 'bookshelf': case 'server': return 84;
    case 'tv_wall': return 96;
    case 'kanban': case 'foam': return 92;
    case 'whiteboard': case 'sales_board': return 72;
    case 'ring_light': case 'softbox': return 74;
    case 'arcade': return 70;
    case 'desk': case 'desk_ceo': return 58;
    case 'mic': return 56;
    case 'water_cooler': return 50;
    case 'easel': return 62;
    case 'tripod': return 52;
    default: return 40;
  }
}

export function drawProp(g: G, P: Proj, p: Prop) {
  const w = p.w;
  const h = p.h;
  switch (p.kind) {
    case 'desk': drawDesk(g, P, p.face ?? 'up', p.variant ?? 'standard', p.id.replace(/^desk-/, '')); break;
    case 'desk_ceo': drawCeoDesk(g, P); break;
    case 'plant': plant(g, P, w / 2, h / 2, 58, 0xe9e3d8, p.x * 31 + p.y * 7 + 3); break;
    case 'plant_small': plant(g, P, 0.5, 0.5, 34, 0xc97b53, p.x * 13 + p.y * 5 + 1); break;
    case 'bookshelf': {
      box(g, P, 0.05, 0.1, w - 0.05, 0.55, 0, 78, OAK, OAK_S, OAK_E);
      const books = [0x8e3b46, 0x2f5d8a, 0xd9a441, 0x3f7d4e, 0x6d4aff, 0xe0913a, 0x3a3d44];
      for (let s = 0; s < 4; s++) {
        const z = 6 + s * 18;
        wallY(g, P, 0.55, 0.12, w - 0.12, z, z + 15, shade(OAK, 0.55));
        let x = 0.15;
        let k = s * 3;
        while (x < w - 0.2) {
          const bw = 0.07 + ((k * 37) % 5) * 0.015;
          const bh = 10 + ((k * 13) % 5);
          const c = p.variant === 'swatches' ? [0xf94144, 0xf3722c, 0xf9c74f, 0x90be6d, 0x43aa8b, 0x577590][k % 6]
            : p.variant === 'devices' ? [0x1d1d22, 0x2b2e35, 0xdadbe2][k % 3]
              : p.variant === 'gear' ? [0x1d1d22, 0x3b3f47, 0x9aa0a8][k % 3] : books[k % books.length];
          wallY(g, P, 0.55, x, x + bw, z, z + bh, c);
          x += bw + 0.012;
          k++;
        }
      }
      break;
    }
    case 'whiteboard':
    case 'sales_board': {
      for (const x of [0.1, w - 0.16]) box(g, P, x, 0.45, x + 0.06, 0.55, 0, 60, 0x9aa0a8);
      const board = p.kind === 'whiteboard' ? 0xfbfbf8 : 0x1f2227;
      box(g, P, 0.05, 0.47, w - 0.05, 0.53, 22, 64, board, board, shade(board, 0.8));
      if (p.kind === 'whiteboard') {
        const notes = [0xf9c74f, 0x90be6d, 0xf28482, 0x84a59d, 0xf9c74f, 0x8ecae6];
        notes.forEach((c, i) => wallY(g, P, 0.535, 0.2 + (i % 3) * 0.55, 0.45 + (i % 3) * 0.55, 30 + Math.floor(i / 3) * 14, 40 + Math.floor(i / 3) * 14, c));
        const a = P(0.3, 0.535, 56); const b = P(1.6, 0.535, 58);
        g.lineStyle(1.2, 0x2a6fdb, 1); g.lineBetween(a.x, a.y, b.x, b.y);
      } else {
        // KPI screen: bars + line
        for (let i = 0; i < 8; i++) wallY(g, P, 0.535, 0.3 + i * 0.3, 0.45 + i * 0.3, 26, 30 + ((i * 7) % 5) * 5 + i * 1.5, i % 2 ? 0x1f9d6b : 0x6d4aff);
        wallY(g, P, 0.535, 0.25, 1.4, 56, 59, 0xf3f2ff);
      }
      break;
    }
    case 'tv_wall': {
      // big screen on the outer wall (x = 0 plane), facing +x
      wallX(g, P, 0.06, 0.1, h - 0.1, 36, 90, 0x17181c);
      wallX(g, P, 0.08, 0.18, h - 0.18, 39, 87, 0x1b2340);
      const cols = [0x6d4aff, 0x3ba7ff, 0x1f9d6b];
      for (let c = 0; c < 3; c++) {
        const y0 = 0.35 + c * 0.8;
        wallX(g, P, 0.09, y0, y0 + 0.6, 80, 84, cols[c]);
        for (let r = 0; r < 3; r++) wallX(g, P, 0.09, y0, y0 + 0.6, 70 - r * 10, 76 - r * 10, 0xe8e6ff, 0.85);
      }
      break;
    }
    case 'kanban': {
      wallY(g, P, 0.06, 0.1, w - 0.1, 44, 88, 0xfbfbf8);
      const cols = [0xf28482, 0xf9c74f, 0x90be6d, 0x8ecae6];
      for (let c = 0; c < 4; c++) {
        wallY(g, P, 0.07, 0.2 + c * 0.95, 0.9 + c * 0.95, 82, 85, 0x2f2b55);
        for (let r = 0; r < 3 - (c % 2); r++) wallY(g, P, 0.07, 0.25 + c * 0.95, 0.75 + c * 0.95, 70 - r * 11, 78 - r * 11, cols[(c + r) % 4]);
      }
      break;
    }
    case 'foam': {
      for (let i = 0; i < w * 3; i++) for (let r = 0; r < 4; r++) {
        const x0 = 0.05 + i * 0.32;
        if (x0 + 0.28 > w) continue;
        wallY(g, P, 0.05, x0, x0 + 0.28, 20 + r * 17, 35 + r * 17, (i + r) % 2 ? 0x3a3450 : 0x4a4266);
      }
      break;
    }
    case 'server': {
      box(g, P, 0.1, 0.15, w - 0.1, 0.8, 0, 80, 0x24262b, 0x2d3036, 0x1c1e22);
      for (let r = 0; r < 9; r++) for (let k = 0; k < 4; k++) {
        const c = P(0.3 + k * 0.4, 0.8, 8 + r * 8);
        g.fillStyle([0x1f9d6b, 0x3ba7ff, 0x1f9d6b, 0xf5a524][(r + k) % 4], 0.9);
        g.fillRect(c.x - 1, c.y - 1, 2, 1.5);
      }
      break;
    }
    case 'beanbag': {
      const c = p.variant ? parseInt(p.variant.replace('#', ''), 16) : 0xe0913a;
      shadow(g, P, 0.5, 0.5, 0.4, 0.4, 0.18);
      const o = P(0.5, 0.5, 0);
      g.fillStyle(shade(c, 0.8), 1); g.fillEllipse(o.x, o.y - 7, 38, 20);
      g.fillStyle(c, 1); g.fillEllipse(o.x - 2, o.y - 11, 32, 16);
      g.fillStyle(shade(c, 1.15), 1); g.fillEllipse(o.x - 5, o.y - 14, 14, 6);
      break;
    }
    case 'water_cooler':
      shadow(g, P, 0.5, 0.5, 0.3, 0.3, 0.18);
      box(g, P, 0.3, 0.3, 0.7, 0.7, 0, 30, 0xf0f0f0, 0xdedede, 0xcccccc);
      box(g, P, 0.36, 0.36, 0.64, 0.64, 30, 46, 0x9fd4f5, 0x8cc6ea, 0x7ab5dc);
      break;
    case 'coffee_table':
      shadow(g, P, 0.5, 0.5, 0.4, 0.4, 0.14);
      for (const [x, y] of [[0.22, 0.22], [0.7, 0.22], [0.22, 0.7], [0.7, 0.7]] as const) box(g, P, x, y, x + 0.07, y + 0.07, 0, 11, 0x2a2b30);
      box(g, P, 0.15, 0.15, 0.85, 0.85, 11, 13.5, OAK, OAK_S, OAK_E);
      floorQuad(g, P, 0.3, 0.3, 0.6, 0.55, 13.7, 0xe8553d);
      break;
    case 'armchair': {
      const c = p.variant ? parseInt(p.variant.replace('#', ''), 16) : 0x8a5a3b;
      drawSeatTile(g, P, p.face ?? 'left', c, true, true);
      break;
    }
    case 'mic': {
      // stand + mic + pop filter, in front of the singer
      const b = P(0.5, 0.25, 0);
      g.fillStyle(0x1b1c20, 1); g.fillEllipse(b.x, b.y, 14, 6);
      const top = P(0.5, 0.25, 44);
      g.lineStyle(1.6, 0x2b2d33, 1); g.lineBetween(b.x, b.y, top.x, top.y);
      g.fillStyle(0x3a3d44, 1); g.fillRoundedRect(top.x - 2.2, top.y - 7, 4.4, 8, 2);
      g.lineStyle(1, 0x6b7079, 1); g.strokeEllipse(top.x - 3, top.y + 1, 9, 10);
      g.fillStyle(0x2b2d33, 0.35); g.fillEllipse(top.x - 3, top.y + 1, 9, 10);
      break;
    }
    case 'ring_light': {
      const b = P(0.5, 0.5, 0);
      g.lineStyle(1.2, 0x2b2d33, 1);
      g.lineBetween(b.x - 7, b.y + 2, b.x, b.y - 4); g.lineBetween(b.x + 7, b.y + 2, b.x, b.y - 4);
      const t = P(0.5, 0.5, 60);
      g.lineBetween(b.x, b.y - 4, t.x, t.y);
      g.lineStyle(3, 0xfff8e8, 1); g.strokeCircle(t.x, t.y - 4, 8);
      g.lineStyle(1, 0xd8d0c0, 1); g.strokeCircle(t.x, t.y - 4, 9.5);
      break;
    }
    case 'softbox': {
      const b = P(0.5, 0.5, 0);
      g.lineStyle(1.2, 0x2b2d33, 1);
      g.lineBetween(b.x - 7, b.y + 2, b.x, b.y - 5); g.lineBetween(b.x + 7, b.y + 2, b.x, b.y - 5);
      const t = P(0.5, 0.5, 50);
      g.lineBetween(b.x, b.y - 5, t.x, t.y);
      g.fillStyle(0x1f2126, 1); g.fillRect(t.x - 11, t.y - 20, 22, 16);
      g.fillStyle(0xfffaf0, 1); g.fillRect(t.x - 9, t.y - 18, 18, 12);
      break;
    }
    case 'tripod': {
      const b = P(0.5, 0.5, 0);
      g.lineStyle(1.2, 0x2b2d33, 1);
      const t = P(0.5, 0.5, 38);
      g.lineBetween(b.x - 8, b.y + 3, t.x, t.y); g.lineBetween(b.x + 8, b.y + 3, t.x, t.y); g.lineBetween(b.x, b.y - 4, t.x, t.y);
      g.fillStyle(0x1d1d22, 1); g.fillRoundedRect(t.x - 7, t.y - 9, 14, 9, 2);
      g.fillStyle(0x3a3d44, 1); g.fillCircle(t.x + 7, t.y - 4.5, 3.4);
      g.fillStyle(0xe5484d, 1); g.fillCircle(t.x - 4, t.y - 7, 1);
      break;
    }
    case 'easel': {
      const b = P(0.5, 0.5, 0);
      const t = P(0.5, 0.5, 58);
      g.lineStyle(1.6, 0x8a5a36, 1);
      g.lineBetween(b.x - 8, b.y + 2, t.x, t.y); g.lineBetween(b.x + 8, b.y + 2, t.x, t.y);
      g.fillStyle(0xfdfcf8, 1); g.fillRect(t.x - 11, t.y + 6, 22, 18);
      g.fillStyle(0x8ecae6, 1); g.fillRect(t.x - 9, t.y + 8, 18, 8);
      g.fillStyle(0xf9c74f, 1); g.fillCircle(t.x + 4, t.y + 11, 2.6);
      g.fillStyle(0x90be6d, 1); g.fillTriangle(t.x - 9, t.y + 22, t.x - 1, t.y + 14, t.x + 7, t.y + 22);
      break;
    }
    case 'arcade':
      shadow(g, P, 0.5, 0.5, 0.35, 0.35, 0.18);
      box(g, P, 0.2, 0.2, 0.8, 0.8, 0, 64, 0x2b2350, 0x3a2f6b, 0x221c40);
      poly(g, [P(0.25, 0.8, 38), P(0.75, 0.8, 38), P(0.75, 0.8, 54), P(0.25, 0.8, 54)], 0x3ba7ff);
      poly(g, [P(0.25, 0.8, 57), P(0.75, 0.8, 57), P(0.75, 0.8, 62), P(0.25, 0.8, 62)], 0xf5a524);
      box(g, P, 0.2, 0.8, 0.8, 0.95, 28, 32, 0x1b1c20);
      break;
    case 'rug': {
      const colors: Record<string, [number, number]> = {
        grey: [0x9a9790, 0xb5b1a8], navy: [0x3b4a6b, 0x4d5d80], warm: [0xb0754e, 0xc88e64],
        sage: [0x8fa58a, 0xa6b9a0], cream: [0xe3d8c2, 0xd4c6ab],
      };
      const [a, b] = colors[p.variant ?? 'grey'] ?? colors.grey;
      floorQuad(g, P, 0, 0, w, h, 0, a, 0.9);
      floorQuad(g, P, 0.25, 0.25, w - 0.25, h - 0.25, 0, b, 0.9);
      floorQuad(g, P, 0.45, 0.45, w - 0.45, h - 0.45, 0, a, 0.5);
      break;
    }
    default:
      box(g, P, 0.2, 0.2, w - 0.2, h - 0.2, 0, 20, 0x999999);
  }
}

export function bakeProp(scene: Phaser.Scene, p: Prop): Baked {
  const key = p.kind === 'desk' ? `prop-desk-${p.id}` : `prop-${p.kind}-${p.w}x${p.h}-${p.face ?? ''}-${p.variant ?? ''}-${p.kind.startsWith('plant') ? `${p.x}-${p.y}` : ''}`;
  return bake(scene, key, p.w, p.h, propMaxH(p), (g, P) => drawProp(g, P, p));
}

export function bakeChair(scene: Phaser.Scene, face: Facing, color = 0x3d424b): Baked {
  return bake(scene, `chair-${face}-${color}`, 1, 1, 36, (g, P) => drawChair(g, P, face, color));
}
