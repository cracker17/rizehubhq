// Furniture sprites (desks, gym equipment) and animated office chairs.
// Desks are drawn as thin vertical slices, each sorted by the floor line in front of it, so people pass in
// front of and behind the same desk correctly (a single sprite can only be all-in-front or all-behind).
// Chairs slide out and swivel when someone walks up, sit down or gets up, and fidget a little while in use.
import * as Phaser from 'phaser';
import { LAYOUT, PROJ, type LayoutFurniture } from '../logic/layout';
import { FACING_STEP, type Facing, type OfficeMap, type Seat } from '../logic/map';
import type { Motion } from '../logic/motion';
import { SIT_DOWN, STAND_UP } from '../logic/motion';
import type { Pt } from '../logic/iso';

export interface FurnItem { src: string; w: number; h: number; ax: number; ay: number; W: number; D: number; screens?: [number, number][][] }
export interface FurnManifest { version: number; items: Record<string, FurnItem> }

const S = LAYOUT.image.scale;
const SLICE = 8; // world px per desk slice
export const furnKey = (name: string) => `furn:${name}`;

export function loadFurniture(scene: Phaser.Scene, base: string) {
  scene.load.json('office-furniture', `${base}/furniture/manifest.json`);
  scene.load.once('filecomplete-json-office-furniture', (_k: string, _t: string, data: FurnManifest) => {
    for (const [name, e] of Object.entries(data?.items ?? {})) scene.load.image(furnKey(name), e.src.replace(/^\/office/, base));
  });
}

const toWorld = (tx: number, ty: number): Pt => { const p = PROJ.toImage(tx, ty); return { x: p.x * S, y: p.y * S }; };

/** A placed sprite and the floor line in front of it (for depth). */
export interface Placed {
  id: string;
  item: FurnItem;
  /** Floor anchor in world px. */
  anchor: Pt;
  /** Front floor line (left corner → front corner → right corner), world px. */
  front: Pt[];
  images: Phaser.GameObjects.Image[];
  /** Top-left of the sprite in world px, and its slices (texture x, width, depth). */
  origin: Pt;
  slices: { cx: number; w: number; depth: number }[];
  depthAt(x: number): number;
}

function frontLine(f: LayoutFurniture, it: FurnItem): Pt[] {
  const t = PROJ.toTile(f.at[0], f.at[1]);
  const [wx, wy] = f.flip ? [it.D, it.W] : [it.W, it.D];
  return [toWorld(t.x - wx, t.y), toWorld(t.x, t.y), toWorld(t.x, t.y - wy)];
}

function lineY(line: Pt[], x: number) {
  if (x <= line[0].x) return line[0].y;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i]; const b = line[i + 1];
    if (x <= b.x) return a.y + ((b.y - a.y) * (x - a.x)) / Math.max(1e-6, b.x - a.x);
  }
  return line[line.length - 1].y;
}

type ChairView = 'up' | 'right' | 'down' | 'left';
const CHAIR_TEX: Record<ChairView, { name: string; flip: boolean }> = {
  up: { name: 'chair_ur', flip: false },
  left: { name: 'chair_ur', flip: true },
  down: { name: 'chair_dl', flip: false },
  right: { name: 'chair_dr', flip: false },
};
const CW: ChairView[] = ['up', 'right', 'down', 'left'];
const opposite = (f: Facing): ChairView => ({ up: 'down', down: 'up', left: 'right', right: 'left' } as const)[f];

interface Chair {
  seat: Seat;
  img: Phaser.GameObjects.Image;
  /** 0 = tucked in at the desk, 1 = pulled out into the aisle. */
  out: number;
  /** Continuous heading in quarter turns (0 = up, 1 = right, 2 = down, 3 = left). */
  turn: number;
  wobble: number;
}

export interface SeatUser { id: string; motion: Motion; hidden: boolean }

const PULL = 0.42; // tiles

export class FurnitureLayer {
  readonly placed = new Map<string, Placed>();
  private chairs = new Map<string, Chair>();
  private manifest: FurnManifest | null = null;

  constructor(private scene: Phaser.Scene) {}

  create(map: OfficeMap) {
    this.manifest = (this.scene.cache.json.get('office-furniture') as FurnManifest | undefined) ?? null;
    if (!this.manifest) return;
    for (const f of LAYOUT.furniture ?? []) this.place(f);
    this.setMap(map);
  }

  get ready() { return !!this.manifest; }

  item(name: string) { return this.manifest?.items[name]; }

  private place(f: LayoutFurniture) {
    const it = this.manifest?.items[f.sprite];
    if (!it || !this.scene.textures.exists(furnKey(f.sprite))) return;
    const anchor = { x: f.at[0] * S, y: f.at[1] * S };
    const front = frontLine(f, it);
    const left = anchor.x - (f.flip ? it.w - it.ax : it.ax);
    const images: Phaser.GameObjects.Image[] = [];
    const slices: Placed['slices'] = [];
    for (let cx = 0; cx < it.w; cx += SLICE) {
      const w = Math.min(SLICE, it.w - cx);
      const img = this.scene.add.image(left, anchor.y - it.ay - (f.z ?? 0) * S, furnKey(f.sprite)).setOrigin(0, 0);
      img.setCrop(cx, 0, w, it.h);
      const depth = lineY(front, left + cx + w / 2);
      img.setDepth(depth);
      if (f.hidden) img.setVisible(false);
      images.push(img);
      slices.push({ cx, w, depth });
    }
    this.placed.set(f.id, { id: f.id, item: it, anchor, front, images, origin: { x: left, y: anchor.y - it.ay - (f.z ?? 0) * S }, slices, depthAt: (x) => lineY(front, x) });
  }

  /** Show or hide a placed sprite (e.g. swap the made bed for the bed with the CEO asleep in it). */
  setShown(id: string, on: boolean) {
    const p = this.placed.get(id);
    if (p && p.images[0]?.visible !== on) p.images.forEach((i) => i.setVisible(on));
  }

  /** (Re)build chairs for the seats of a map. */
  setMap(map: OfficeMap) {
    for (const c of this.chairs.values()) c.img.destroy();
    this.chairs.clear();
    if (!this.manifest) return;
    for (const seat of map.seats) {
      if (!seat.chair) continue;
      const tex = CHAIR_TEX[seat.face];
      if (!this.scene.textures.exists(furnKey(tex.name))) continue;
      const img = this.scene.add.image(0, 0, furnKey(tex.name));
      const c: Chair = { seat, img, out: 0, turn: CW.indexOf(seat.face), wobble: Math.random() * 10 };
      this.chairs.set(seat.id, c);
      this.drawChair(c, 0, false);
    }
  }

  /** Where a seated / sitting person is drawn (the chair may be pulled out), in tile coordinates. */
  seatPos(seatId: string, pos: Pt): Pt {
    const c = this.chairs.get(seatId);
    if (!c || c.out <= 0.001) return pos;
    const st = FACING_STEP[c.seat.face];
    return { x: pos.x - st.dx * PULL * c.out, y: pos.y - st.dy * PULL * c.out };
  }

  /**
   * Animate chairs from who is using them. `users` maps seat id → the person whose goal (or last goal)
   * is that seat.
   */
  update(dt: number, users: Map<string, SeatUser>, t: number) {
    for (const c of this.chairs.values()) {
      const u = users.get(c.seat.id);
      const m = u && !u.hidden ? u.motion : null;
      const deskTurn = CW.indexOf(c.seat.face);
      const aisleTurn = CW.indexOf(opposite(c.seat.face));
      let targetOut = 0;
      let targetTurn = deskTurn;
      let seated = false;
      if (m) {
        const d = Math.hypot(m.pos.x - c.seat.x, m.pos.y - c.seat.y);
        const goingHere = m.goal && Math.abs(m.goal.x - c.seat.x) < 1e-3 && Math.abs(m.goal.y - c.seat.y) < 1e-3 && m.goal.seated;
        if (m.phase === 'seated' && d < 0.05) { seated = true; }
        else if (m.phase === 'sitting_down' && d < 0.05) {
          const k = Math.min(1, m.phaseT / SIT_DOWN);
          targetOut = 1 - k; targetTurn = aisleTurn + (deskTurn - aisleTurn) * k; seated = k > 0.5;
        } else if (m.phase === 'standing_up' && d < 0.05) {
          const k = Math.min(1, m.phaseT / STAND_UP);
          targetOut = k; targetTurn = deskTurn + (aisleTurn - deskTurn) * k;
        } else if (goingHere && d < 1.4) { targetOut = 1; targetTurn = aisleTurn; }
        else if (d < 0.9 && m.phase !== 'walking') { targetOut = 1; targetTurn = aisleTurn; }
      }
      // Ease (the sit/stand phases already follow the motion clock closely).
      const k = Math.min(1, dt * (seated ? 10 : 5));
      c.out += (targetOut - c.out) * k;
      let dTurn = targetTurn - c.turn;
      if (dTurn > 2) dTurn -= 4; if (dTurn < -2) dTurn += 4;
      c.turn += dTurn * k;
      // Idle fidget while working: tiny swivel back and forth, bigger on a lean-back / glance.
      let wob = 0;
      if (seated && m) {
        const micro = m.micro?.name;
        const amp = micro === 'lean_back' || micro === 'glance' || micro === 'stretch' ? 0.22 : 0.05;
        wob = Math.sin(t * (micro ? 2.2 : 0.9) + c.wobble) * amp;
      }
      this.drawChair(c, wob, seated);
    }
  }

  private drawChair(c: Chair, wobble: number, occupied: boolean) {
    const turn = ((c.turn + wobble) % 4 + 4) % 4;
    const view = CW[Math.round(turn) % 4];
    const tex = CHAIR_TEX[view];
    const it = this.manifest?.items[tex.name];
    if (!it) return;
    const key = furnKey(tex.name);
    if (c.img.texture.key !== key) c.img.setTexture(key);
    const st = FACING_STEP[c.seat.face];
    const p = toWorld(c.seat.x - st.dx * PULL * c.out, c.seat.y - st.dy * PULL * c.out);
    c.img.setFlipX(tex.flip);
    c.img.setOrigin(tex.flip ? 1 - it.ax / it.w : it.ax / it.w, it.ay / it.h);
    c.img.setPosition(p.x, p.y);
    // A swivel between two views: squash a little around the turn so the change reads as a rotation.
    const frac = Math.abs(turn - Math.round(turn));
    c.img.setScale(1 - frac * 0.35, 1);
    // Someone sitting with their back to us is behind the backrest; facing us, the chair is behind them.
    // The seated person is always drawn over the chair (their back covers the backrest seen from behind).
    c.img.setDepth(p.y + (occupied ? 1 : 0.5));
  }

  destroy() {
    for (const p of this.placed.values()) p.images.forEach((i) => i.destroy());
    for (const c of this.chairs.values()) c.img.destroy();
    this.placed.clear();
    this.chairs.clear();
  }
}
