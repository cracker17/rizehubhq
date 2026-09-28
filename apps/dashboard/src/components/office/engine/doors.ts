// Doors that swing open when someone walks up to them (and close behind them), with a soft whoosh and
// latch sound, plus glass walls the scene draws itself (the gym front). The painted doors stay in the
// picture while closed; an opening door is drawn as a leaf rotating around its hinge in floor space, so it
// keeps the room's perspective. Wooden entrance doors also light up the doorway while open.
import * as Phaser from 'phaser';
import { LAYOUT, PROJ, type LayoutDoor, type LayoutGlassWall } from '../logic/layout';
import type { Pt } from '../logic/iso';
import { officeAudio } from './audio';

const S = LAYOUT.image.scale;
const OPEN_ANGLE = (82 * Math.PI) / 180;
const NEAR = 1.7; // tiles: doors start opening as someone walks up

interface DoorState {
  d: LayoutDoor;
  g: Phaser.GameObjects.Graphics;
  light: Phaser.GameObjects.Graphics | null;
  strips: Phaser.GameObjects.Graphics[];
  hingeT: Pt;
  freeT: Pt;
  centerT: Pt;
  open: number;
  target: number;
  holdUntil: number;
  painted: boolean;
}

const w = (x: number, y: number): Pt => ({ x: x * S, y: y * S });
const toW = (t: Pt, z = 0): Pt => { const p = PROJ.toImage(t.x, t.y, z); return { x: p.x * S, y: p.y * S }; };

export class DoorLayer {
  private doors: DoorState[] = [];
  private walls: Phaser.GameObjects.Graphics[] = [];

  constructor(private scene: Phaser.Scene) {}

  create(doors: LayoutDoor[] = LAYOUT.doors ?? [], walls: LayoutGlassWall[] = LAYOUT.glassWalls ?? []) {
    for (const d of doors) {
      const hingeT = PROJ.toTile(d.hinge[0], d.hinge[1]);
      const freeT = PROJ.toTile(d.free[0], d.free[1]);
      const g = this.scene.add.graphics();
      const light = d.opening ? this.scene.add.graphics() : null;
      const painted = d.painted ?? d.kind === 'wood';
      const strips = Array.from({ length: 8 }, () => this.scene.add.graphics());
      this.doors.push({ d, g, light, strips, hingeT, freeT, centerT: { x: (hingeT.x + freeT.x) / 2, y: (hingeT.y + freeT.y) / 2 }, open: 0, target: 0, holdUntil: 0, painted });
    }
    for (const wall of walls) this.buildWall(wall);
  }

  /** Glass wall in short segments (each sorted by its own floor y), with frame lines and posts. */
  private buildWall(wall: LayoutGlassWall) {
    const pts = wall.base.map(([x, y]) => w(x, y));
    const h = wall.h * S;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]; const b = pts[i + 1];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const n = Math.max(1, Math.round(len / 18));
      for (let k = 0; k < n; k++) {
        const p = { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n };
        const q = { x: a.x + ((b.x - a.x) * (k + 1)) / n, y: a.y + ((b.y - a.y) * (k + 1)) / n };
        const g = this.scene.add.graphics();
        g.fillStyle(0xcfe8f2, 0.2);
        g.fillPoints([p, q, { x: q.x, y: q.y - h }, { x: p.x, y: p.y - h }], true);
        // soft reflection streak
        if (k % 3 === 1) { g.lineStyle(3 * S, 0xffffff, 0.12); g.lineBetween(p.x + 2, p.y - h * 0.15, q.x - 2, q.y - h * 0.75); }
        g.lineStyle(2.6 * S, 0x24272b, 0.95);
        g.lineBetween(p.x, p.y - h, q.x, q.y - h); // top rail
        g.lineStyle(2 * S, 0x24272b, 0.9);
        g.lineBetween(p.x, p.y, q.x, q.y); // floor track
        if (k === 0 || k === n - 1) { g.lineStyle(3.2 * S, 0x24272b, 1); const e = k === 0 ? p : q; g.lineBetween(e.x, e.y, e.x, e.y - h); }
        g.setDepth(Math.max(p.y, q.y));
        this.walls.push(g);
      }
    }
  }

  /** Open the doors people are walking through. `people` are tile positions of everyone moving. */
  update(dt: number, people: { pos: Pt; walking: boolean }[], now: number) {
    for (const s of this.doors) {
      const near = people.some((p) => p.walking && Math.hypot(p.pos.x - s.centerT.x, p.pos.y - s.centerT.y) < NEAR)
        || people.some((p) => Math.hypot(p.pos.x - s.centerT.x, p.pos.y - s.centerT.y) < 0.55);
      if (near) s.holdUntil = now + 1100;
      const target = now < s.holdUntil ? 1 : 0;
      if (target !== s.target) {
        s.target = target;
        officeAudio.door(s.d.kind, target === 1);
      }
      const speed = s.target ? 3.2 : 2.2;
      s.open += Math.sign(s.target - s.open) * Math.min(Math.abs(s.target - s.open), dt * speed);
      this.draw(s);
    }
  }

  private draw(s: DoorState) {
    const { g, d } = s;
    g.clear();
    const e = s.open < 0.5 ? 2 * s.open * s.open : 1 - Math.pow(-2 * s.open + 2, 2) / 2; // ease in-out
    if (s.light) {
      s.light.clear();
      if (e > 0.01 && d.opening) {
        const q = d.opening.map(([x, y]) => w(x, y));
        s.light.fillStyle(0xfff1d6, 0.92 * e);
        s.light.fillPoints(q, true);
        s.light.fillStyle(0xffffff, 0.35 * e);
        s.light.fillPoints([q[0], q[1], { x: q[1].x, y: q[1].y - 16 * S }, { x: q[0].x, y: q[0].y - 16 * S }], true);
        s.light.setDepth(Math.max(...q.map((p) => p.y)) - 6);
      }
    }
    for (const sg of s.strips) sg.clear();
    if (s.painted && e < 0.01) return; // the picture shows the closed door
    const vx = s.freeT.x - s.hingeT.x;
    const vy = s.freeT.y - s.hingeT.y;
    const at = (k: number, off = 0) => ({ x: s.hingeT.x + vx * (k + off), y: s.hingeT.y + vy * (k + off) });
    const mode = d.mode ?? (d.kind === 'glass' ? 'slide' : 'swing');
    const H = d.h * S;
    // leaves as floor edges (tile points): [start, end]
    let leaves: [Pt, Pt][];
    if (mode === 'slide') {
      const k = e * 0.9; // glide along the wall over the fixed panel on the hinge side
      leaves = [[at(0, -k), at(1, -k)]];
    } else if (mode === 'slide2') {
      const k = e * 0.48; // two leaves part from the middle into the wall pockets
      leaves = [[at(0, -k), at(0.5, -k)], [at(0.5, k), at(1, k)]];
    } else {
      const ang = e * OPEN_ANGLE * d.swing;
      leaves = [[s.hingeT, { x: s.hingeT.x + vx * Math.cos(ang) - vy * Math.sin(ang), y: s.hingeT.y + vx * Math.sin(ang) + vy * Math.cos(ang) }]];
    }
    if (mode === 'slide2') {
      // header track over the opening
      const r0 = toW(at(mode === 'slide2' ? -0.12 : -0.9)); const r1 = toW(at(mode === 'slide2' ? 1.12 : 1));
      g.lineStyle(2.6 * S, 0x1f2226, 0.95);
      g.lineBetween(r0.x, r0.y - H - 2 * S, r1.x, r1.y - H - 2 * S);
      g.setDepth(Math.max(r0.y, r1.y) + 2);
    }
    let si = 0;
    for (const [a, b] of leaves) {
      // each leaf in vertical strips, each strip sorted by its own floor point (people pass behind / in front)
      const n = 4;
      for (let i = 0; i < n && si < s.strips.length; i++, si++) {
        const p0 = toW({ x: a.x + (b.x - a.x) * (i / n), y: a.y + (b.y - a.y) * (i / n) });
        const p1 = toW({ x: a.x + (b.x - a.x) * ((i + 1) / n), y: a.y + (b.y - a.y) * ((i + 1) / n) });
        this.drawStrip(s.strips[si], d, p0, p1, H, i === 0, i === n - 1, i === Math.floor(n / 2));
      }
    }
  }

  /** One vertical strip of a door leaf (frame edges only at the leaf's ends). */
  private drawStrip(g: Phaser.GameObjects.Graphics, d: LayoutDoor, p0: Pt, p1: Pt, H: number, first: boolean, last: boolean, mid: boolean) {
    const quad = [p0, p1, { x: p1.x, y: p1.y - H }, { x: p0.x, y: p0.y - H }];
    if (d.kind === 'glass') {
      g.fillStyle(d.frosted ? 0xe9f1f4 : 0xd7eef6, d.frosted ? 0.62 : 0.16);
      g.fillPoints(quad, true);
      if (d.frosted) { // a clear band at eye level, like office manifestation film
        const b = (t: number) => [{ x: p0.x, y: p0.y - H * t }, { x: p1.x, y: p1.y - H * t }];
        const [a0, a1] = b(0.52); const [c0, c1] = b(0.6);
        g.fillStyle(0xbfd9e3, 0.35); g.fillPoints([a0, a1, c1, c0], true);
      }
      g.lineStyle(2.6 * S, 0x2a2d31, 1);
      g.lineBetween(p0.x, p0.y, p1.x, p1.y);
      g.lineBetween(p0.x, p0.y - H, p1.x, p1.y - H);
      if (first) g.lineBetween(p0.x, p0.y, p0.x, p0.y - H);
      if (last) g.lineBetween(p1.x, p1.y, p1.x, p1.y - H);
      if (last) { g.lineStyle(2.2 * S, 0xc9ccd1, 1); g.lineBetween(p1.x - 3 * S, p1.y - H * 0.42, p1.x - 3 * S, p1.y - H * 0.6); }
      if (mid) { g.lineStyle(2 * S, 0xffffff, 0.2); g.lineBetween(p0.x, p0.y - H * 0.25, p1.x, p1.y - H * 0.75); }
    } else {
      g.fillStyle(0x6a3f22, 1);
      g.fillPoints(quad, true);
      g.lineStyle(1.6 * S, 0x3b2413, 1);
      g.lineBetween(p0.x, p0.y, p1.x, p1.y); g.lineBetween(p0.x, p0.y - H, p1.x, p1.y - H);
      if (first) g.lineBetween(p0.x, p0.y, p0.x, p0.y - H);
      if (last) g.lineBetween(p1.x, p1.y, p1.x, p1.y - H);
      if (!first && !last) { // window
        g.fillStyle(0xf3e6c8, 0.9);
        g.fillPoints([{ x: p0.x, y: p0.y - H * 0.52 }, { x: p1.x, y: p1.y - H * 0.52 }, { x: p1.x, y: p1.y - H * 0.9 }, { x: p0.x, y: p0.y - H * 0.9 }], true);
      }
      if (last) { g.lineStyle(2.4 * S, 0x2a2a2a, 1); g.lineBetween(p1.x - 3 * S, p1.y - H * 0.38, p1.x - 3 * S, p1.y - H * 0.55); }
    }
    g.setDepth(Math.max(p0.y, p1.y) + 0.5);
  }

  destroy() {
    this.doors.forEach((s) => { s.g.destroy(); s.light?.destroy(); s.strips.forEach((x) => x.destroy()); });
    this.walls.forEach((g) => g.destroy());
    this.doors = []; this.walls = [];
  }
}
