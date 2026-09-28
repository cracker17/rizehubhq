// The office scene: the painted background (public/office/office-bg.webp, the reference picture without
// people or text), characters driven by the motion state machine and walking the layout's graph, live
// monitor glows, camera (pan / pinch / wheel zoom / follow), CEO avatar (click-to-walk + WASD), day/night.
// World units are pixels of the 2x background; layout.json is in 1x picture pixels.
import * as Phaser from 'phaser';
import { LAYOUT, PROJ } from '../logic/layout';
import { OFFICE, type Facing, type OfficeMap } from '../logic/map';
import { findPath, nearestNode } from '../logic/pathfinding';
import type { Pt } from '../logic/iso';
import { createMotion, setGoal, tick, trigger, type Goal, type Motion } from '../logic/motion';
import { deskGoal, type AgentView, type OfficeEvent, type OfficeModel, type ScreenApp } from '../logic/director';
import { hashString, mulberry32 } from '../logic/rng';
import { CEO_LOOK, lookFor } from './looks';
import { loadManifestSheets, manifestFactory, type CharacterFactory, type CharacterView, type OfficeManifest } from './characters';
import type { Item } from './pose';
import { FurnitureLayer, loadFurniture, type SeatUser } from './furniture';
import { OccluderLayer } from './occluders';
import { DoorLayer } from './doors';
import { ScreenLayer } from './screens';
import { officeAudio } from './audio';

/** Ambient light for the time of day (Asia/Manila): a tint over the picture and how bright the lamps are. */
export interface Ambient { color: number; alpha: number; lamps: number }

/** Background texture scale relative to the 1x layout coordinates. */
export const S = LAYOUT.image.scale;
export const WORLD_W = LAYOUT.image.width * S;
export const WORLD_H = LAYOUT.image.height * S;
/** Figures are drawn ~60 px tall; the people in the reference picture are ~105 px (1x). */
export const FIGURE_SCALE = 1.72 * S;
const CEO_ID = '__ceo__';
const FX_DEPTH = 40_000;
const NIGHT_DEPTH = 50_000;

/** Tile coords (+ height in 1x px) → world px. */
export const world = (tx: number, ty: number, z = 0): Pt => {
  const p = PROJ.toImage(tx, ty, z);
  return { x: p.x * S, y: p.y * S };
};
/** 1x picture px → world px. */
const W = (x: number, y: number): Pt => ({ x: x * S, y: y * S });

export interface TagFrame { id: string; x: number; y: number; visible: boolean }
export interface FrameInfo {
  zoom: number;
  width: number; height: number;
  /** screen = world * view.scale + (view.tx, view.ty), in CSS px (for overlays laid out in world px). */
  view: { scale: number; tx: number; ty: number };
  tags: TagFrame[];
  ceo: TagFrame | null;
  near: string | null;
}
export interface SceneHooks {
  onSelect: (id: string) => void;
  onFrame: (f: FrameInfo) => void;
  onReady: () => void;
  onUserCamera: () => void;
}
export interface SceneOptions {
  avatar: boolean;
  wheel: 'always' | 'modifier';
  dpr: number;
  startZoom?: 'fit' | 'close';
}

interface Char {
  id: string;
  view: CharacterView;
  motion: Motion;
  agent: AgentView | null;
  hidden: boolean;
  carry: Item;
  /** Seat the person last sat at (chairs stay pulled out until they have walked off). */
  seat: string | null;
}

// Night: warm lamps and the fireplace (1x picture px, radius).
const LAMPS: [number, number, number][] = [
  [252, 118, 70], [320, 420, 60], [640, 405, 60], [165, 573, 55], [312, 662, 55], [996, 143, 70],
  [1262, 455, 70], [1100, 480, 55], [458, 210, 45], [800, 505, 110],
];

export class OfficeScene extends Phaser.Scene {
  private hooks!: SceneHooks;
  private opts!: SceneOptions;
  private map: OfficeMap = OFFICE;
  private factory!: CharacterFactory;
  private chars = new Map<string, Char>();
  private furniture!: FurnitureLayer;
  private occluders!: OccluderLayer;
  private doors!: DoorLayer;
  private screenLayer!: ScreenLayer;
  private ambient: Ambient = { color: 0x0b1030, alpha: 0, lamps: 0 };
  private pending: { model: OfficeModel; events: OfficeEvent[] } | null = null;
  private camX = WORLD_W / 2;
  private camY = WORLD_H / 2;
  private zoomLevel = 0.5; // CSS zoom (device zoom = zoomLevel * dpr)
  private userCamera = false;
  private followId: string | null = null;
  private nightRect!: Phaser.GameObjects.Rectangle;
  private glows: Phaser.GameObjects.Image[] = [];
  private fire!: Phaser.GameObjects.Image;
  private fx!: Phaser.GameObjects.Graphics;
  private keys = new Set<string>();
  private drag: { x: number; y: number; moved: boolean; camX: number; camY: number } | null = null;
  private pinch: { d: number; zoom: number } | null = null;
  private near: string | null = null;
  private readyFired = false;
  private cleanup: (() => void)[] = [];

  constructor() { super('office'); }

  init(data: { hooks: SceneHooks; opts: SceneOptions }) {
    this.hooks = data.hooks;
    this.opts = data.opts;
  }

  preload() {
    // Standalone previews serve the assets from a relative folder (NEXT_PUBLIC_OFFICE_ASSETS=./office).
    const base = process.env.NEXT_PUBLIC_OFFICE_ASSETS || '/office';
    this.load.image('office-bg', LAYOUT.image.src.replace(/^\/office/, base));
    this.load.json('office-manifest', `${base}/manifest.json`);
    loadFurniture(this, base);
    this.load.once('filecomplete-json-office-manifest', (_k: string, _t: string, data: OfficeManifest) => {
      if (data && Object.keys(data.characters ?? {}).length) loadManifestSheets(this, data, (src) => src.replace(/^\/office/, base));
    });
  }

  create() {
    const manifest = (this.cache.json.get('office-manifest') as OfficeManifest | undefined) ?? null;
    this.factory = manifestFactory(manifest, FIGURE_SCALE, S);
    this.cameras.main.setBackgroundColor('#15131f');
    const bg = this.add.image(0, 0, 'office-bg').setOrigin(0, 0).setDepth(-100_000);
    bg.setDisplaySize(WORLD_W, WORLD_H);
    this.makeGlowTexture();
    this.furniture = new FurnitureLayer(this);
    this.furniture.create(this.map);
    this.occluders = new OccluderLayer(this);
    this.occluders.create('office-bg');
    this.doors = new DoorLayer(this);
    this.doors.create();
    this.screenLayer = new ScreenLayer(this, this.furniture);
    this.screenLayer.setMap(this.map);
    officeAudio.arm();
    this.fx = this.add.graphics().setDepth(FX_DEPTH);
    this.nightRect = this.add.rectangle(WORLD_W / 2, WORLD_H / 2, WORLD_W * 3, WORLD_H * 3, 0x0b1030, 0).setDepth(NIGHT_DEPTH);
    for (const [x, y, r] of LAMPS) {
      const p = W(x, y);
      this.glows.push(this.add.image(p.x, p.y, 'glow').setScale((r * S) / 64).setTint(0xffc98a).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0).setDepth(NIGHT_DEPTH + 1));
    }
    const f = W(800, 505);
    this.fire = this.add.image(f.x, f.y, 'glow').setScale((90 * S) / 64).setTint(0xff9a3c).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0.18).setDepth(FX_DEPTH - 1);
    this.setupInput();
    this.fitView();
    const ceo = this.map.ceoSeat;
    this.addChar(CEO_ID, CEO_LOOK, { key: 'spot:ceo-chair', x: ceo.x, y: ceo.y, face: ceo.face, seated: true, loop: 'ceo_desk' }, null);
    if (this.pending) { this.applyModel(this.pending.model, this.pending.events); this.pending = null; }
    this.scale.on('resize', () => { if (!this.userCamera) this.fitView(); });
  }

  private makeGlowTexture() {
    if (this.textures.exists('glow')) return;
    const c = this.textures.createCanvas('glow', 128, 128);
    if (!c) return;
    const ctx = c.getContext();
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.45)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    c.refresh();
  }

  // ---------------------------------------------------------------- model binding
  setModel(model: OfficeModel, events: OfficeEvent[]) {
    if (!this.sys.isActive() || !this.chars.has(CEO_ID)) {
      this.pending = { model, events: [...(this.pending?.events ?? []), ...events] };
      return;
    }
    this.applyModel(model, events);
  }

  private addChar(id: string, look: ReturnType<typeof lookFor>, start: Goal, agent: AgentView | null): Char {
    const rng = mulberry32(hashString(id) || 1);
    const motion = createMotion(start, rng);
    const view = this.factory.create(this, id, look);
    const c: Char = { id, view, motion, agent, hidden: false, carry: (look.prop as Item) ?? null, seat: null };
    this.chars.set(id, c);
    return c;
  }

  private applyModel(model: OfficeModel, events: OfficeEvent[]) {
    if (model.map !== this.map) { this.map = model.map; this.furniture.setMap(this.map); this.screenLayer.setMap(this.map); }
    const seen = new Set<string>([CEO_ID]);
    for (const a of model.agents) {
      seen.add(a.id);
      let c = this.chars.get(a.id);
      if (!c) {
        const e = this.map.entrance;
        const start = a.goal ?? deskGoal(this.map, a.id, 'desk_idle') ?? { key: 'spot:entrance', x: e.x, y: e.y, face: 'up' as Facing, seated: false, loop: 'stand' as const };
        c = this.addChar(a.id, lookFor(a.id, a.color), start, a);
      }
      c.agent = a;
      for (const e of events) if (e.agentId === a.id) trigger(c.motion, e.gesture);
      if (!a.goal) {
        c.hidden = true;
        c.view.setVisible(false);
      } else {
        if (c.hidden) {
          // Coming back online: walk in through the lobby doors.
          c.hidden = false;
          c.view.setVisible(true);
          const e = this.map.entrance;
          c.motion = createMotion({ key: 'spot:entrance', x: e.x, y: e.y, face: 'up', seated: false, loop: 'stand' }, mulberry32(hashString(a.id)));
        }
        setGoal(c.motion, a.goal);
      }
      const busy = a.status === 'working' || a.status === 'waiting' || a.status === 'blocked';
      const app: ScreenApp = a.status === 'offline' ? 'off' : busy ? a.screen : 'screensaver';
      this.screenLayer.setInfo(a.id, { app, title: a.tag.replace(/^[^·]*·\s*/, '').replace(/\s*·\s*\d+%$/, ''), progress: a.progress, color: a.color, name: a.name, content: busy ? a.work?.content : null, note: busy ? a.work?.note : null, image: busy ? a.work?.image : null });
    }
    for (const [id, c] of this.chars) if (!seen.has(id)) { c.view.destroy(); this.chars.delete(id); }
  }

  // ---------------------------------------------------------------- controls from React
  setAmbient(a: Ambient) {
    this.ambient = a;
    if (!this.nightRect) return;
    this.nightRect.fillColor = a.color;
    this.tweens.add({ targets: this.nightRect, fillAlpha: a.alpha, duration: 1200 });
    for (const g of this.glows) this.tweens.add({ targets: g, alpha: a.lamps, duration: 1200 });
  }

  zoomBy(f: number) {
    this.zoomAt(this.scale.width / 2, this.scale.height / 2, this.zoomLevel * f);
    this.userCamera = true;
  }

  resetView() { this.userCamera = false; this.followId = null; this.fitView(); }

  follow(id: string | null) {
    this.followId = id === 'ceo' ? CEO_ID : id;
    if (this.followId && this.zoomLevel < 0.8) this.zoomLevel = Math.min(this.maxZoom(), 1);
    this.userCamera = true;
  }

  setAvatar(on: boolean) { this.opts.avatar = on; }

  // ---------------------------------------------------------------- camera
  /** Cover: the picture fills the viewport (no bars) at the smallest zoom. */
  private coverZoom() {
    const w = this.scale.width / this.opts.dpr;
    const h = this.scale.height / this.opts.dpr;
    return Math.max(w / WORLD_W, h / WORLD_H);
  }
  /** Never zoom out past "cover": the office always fills the whole viewport, no bars at any aspect ratio. */
  private minZoom() { return this.coverZoom(); }
  private maxZoom() { return 1.6; }

  private fitView() {
    const w = this.scale.width / this.opts.dpr;
    if (this.opts.startZoom === 'close' || w < 640) {
      // Phones: start closer on the Dev Team / Design Studio side (drag to look around).
      this.zoomLevel = Math.max(this.coverZoom(), 0.36);
      const c = W(420, 330);
      this.camX = c.x; this.camY = c.y;
    } else {
      this.zoomLevel = this.coverZoom();
      this.camX = WORLD_W / 2;
      this.camY = WORLD_H / 2;
    }
    this.applyCamera();
  }

  private clampCamera() {
    const w = this.scale.width / (this.zoomLevel * this.opts.dpr);
    const h = this.scale.height / (this.zoomLevel * this.opts.dpr);
    this.camX = w >= WORLD_W ? WORLD_W / 2 : Math.min(WORLD_W - w / 2, Math.max(w / 2, this.camX));
    this.camY = h >= WORLD_H ? WORLD_H / 2 : Math.min(WORLD_H - h / 2, Math.max(h / 2, this.camY));
  }

  private applyCamera() {
    this.zoomLevel = Math.min(this.maxZoom(), Math.max(this.minZoom(), this.zoomLevel));
    this.clampCamera();
    const cam = this.cameras.main;
    cam.setZoom(this.zoomLevel * this.opts.dpr);
    cam.centerOn(this.camX, this.camY);
  }

  private toWorld(px: number, py: number): Pt {
    const z = this.zoomLevel * this.opts.dpr;
    return { x: (px - this.scale.width / 2) / z + this.camX, y: (py - this.scale.height / 2) / z + this.camY };
  }

  private zoomAt(px: number, py: number, zoom: number) {
    const before = this.toWorld(px, py);
    this.zoomLevel = Math.min(this.maxZoom(), Math.max(this.minZoom(), zoom));
    const after = this.toWorld(px, py);
    this.camX += before.x - after.x;
    this.camY += before.y - after.y;
    this.applyCamera();
  }

  // ---------------------------------------------------------------- input
  private setupInput() {
    this.input.addPointer(1);
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      const touches = [this.input.pointer1, this.input.pointer2].filter((x) => x?.isDown);
      if (touches.length >= 2) {
        const [a, b] = touches;
        this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.zoomLevel };
        this.drag = null;
        return;
      }
      this.drag = { x: p.x, y: p.y, moved: false, camX: this.camX, camY: this.camY };
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (this.pinch) {
        const [a, b] = [this.input.pointer1, this.input.pointer2];
        if (a?.isDown && b?.isDown) {
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          this.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, this.pinch.zoom * (d / this.pinch.d));
          this.markUserCamera();
        }
        return;
      }
      if (!this.drag || !p.isDown) return;
      const dx = p.x - this.drag.x;
      const dy = p.y - this.drag.y;
      if (!this.drag.moved && Math.hypot(dx, dy) < 6 * this.opts.dpr) return;
      this.drag.moved = true;
      const z = this.zoomLevel * this.opts.dpr;
      this.camX = this.drag.camX - dx / z;
      this.camY = this.drag.camY - dy / z;
      this.markUserCamera();
      this.applyCamera();
    });
    this.input.on('pointerup', (p: Phaser.Input.Pointer) => {
      const wasPinch = !!this.pinch;
      if (![this.input.pointer1, this.input.pointer2].some((x) => x?.isDown)) this.pinch = null;
      if (wasPinch) { this.drag = null; return; }
      const d = this.drag;
      this.drag = null;
      if (!d || d.moved) return;
      this.onTap(p.x, p.y);
    });
    this.input.on('wheel', (p: Phaser.Input.Pointer, _o: unknown, _dx: number, dy: number) => {
      const ev = p.event as WheelEvent;
      if (this.opts.wheel === 'modifier' && !(ev.ctrlKey || ev.metaKey)) return;
      ev.preventDefault?.();
      this.zoomAt(p.x, p.y, this.zoomLevel * Math.pow(1.0018, -dy));
      this.markUserCamera();
    });
    const isTyping = () => {
      const el = document.activeElement as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if (!this.opts.avatar || isTyping() || document.querySelector('[role="dialog"]')) return;
      const k = e.key.toLowerCase();
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
        this.keys.add(k);
        if (k.startsWith('arrow')) e.preventDefault();
        this.followId = CEO_ID;
      } else if (k === 'e' && this.near) this.hooks.onSelect(this.near);
    };
    const up = (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase());
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    const blur = () => this.keys.clear();
    window.addEventListener('blur', blur);
    this.cleanup.push(() => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); });
    this.events.once('shutdown', () => this.cleanup.forEach((f) => f()));
    this.events.once('destroy', () => this.cleanup.forEach((f) => f()));
  }

  private markUserCamera() {
    this.userCamera = true;
    if (this.followId) { this.followId = null; this.hooks.onUserCamera(); }
  }

  private charBox(c: Char) {
    const o = c.view.object;
    const seated = c.motion.phase === 'seated';
    const h = (seated ? 46 : 62) * FIGURE_SCALE;
    const w = 12 * FIGURE_SCALE;
    return { x0: o.x - w, x1: o.x + w, y0: o.y - h, y1: o.y + 4 * S };
  }

  private onTap(px: number, py: number) {
    const w = this.toWorld(px, py);
    const hits = [...this.chars.values()]
      .filter((c) => !c.hidden && c.view.object.visible)
      .filter((c) => { const b = this.charBox(c); return w.x > b.x0 && w.x < b.x1 && w.y > b.y0 && w.y < b.y1; })
      .sort((a, b) => b.view.object.depth - a.view.object.depth);
    const hit = hits[0];
    if (hit && hit.id !== CEO_ID) { this.hooks.onSelect(hit.id); return; }
    if (!this.opts.avatar) return;
    // Click-to-walk for the CEO avatar: to the closest walkable point (graph node) or back to the chair.
    const t = PROJ.toTile(w.x / S, w.y / S);
    const ceo = this.chars.get(CEO_ID)!;
    const seat = this.map.ceoSeat;
    if (Math.hypot(t.x - seat.x, t.y - seat.y) < 0.8) {
      setGoal(ceo.motion, { key: 'spot:ceo-chair', x: seat.x, y: seat.y, face: seat.face, seated: true, loop: 'ceo_desk' });
      return;
    }
    const n = nearestNode(this.map, t);
    const face = this.facingOnScreen(ceo.motion.pos, n.pos);
    setGoal(ceo.motion, { key: `node:${n.id}`, x: n.pos.x, y: n.pos.y, face, seated: false, loop: 'stand' });
    this.followId = CEO_ID;
  }

  private stepKeys() {
    if (!this.keys.size) return;
    const ceo = this.chars.get(CEO_ID);
    if (!ceo) return;
    const m = ceo.motion;
    if (m.phase === 'walking' || m.phase === 'standing_up' || m.phase === 'sitting_down') return;
    const k = this.keys;
    const dir = k.has('w') || k.has('arrowup') ? { x: 0, y: -1 } : k.has('s') || k.has('arrowdown') ? { x: 0, y: 1 }
      : k.has('a') || k.has('arrowleft') ? { x: -1, y: 0 } : k.has('d') || k.has('arrowright') ? { x: 1, y: 0 } : null;
    if (!dir) return;
    // Pick the neighbouring graph node whose on-screen direction best matches the key.
    const g = this.map.graph;
    const here = nearestNode(this.map, m.pos);
    const hi = g.index.get(here.id)!;
    const from = world(m.pos.x, m.pos.y);
    const onNode = Math.hypot(m.pos.x - here.pos.x, m.pos.y - here.pos.y) < 0.3;
    const cands = onNode ? g.adj[hi] : [hi];
    let best = -1;
    let bestDot = 0.45;
    for (const i of cands) {
      const to = world(g.pos[i].x, g.pos[i].y);
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const len = Math.hypot(dx, dy) || 1;
      const dot = (dx * dir.x + dy * dir.y) / len;
      if (dot > bestDot) { bestDot = dot; best = i; }
    }
    if (best < 0) return;
    const p = g.pos[best];
    setGoal(m, { key: `node:${g.ids[best]}`, x: p.x, y: p.y, face: this.facingOnScreen(m.pos, p), seated: false, loop: 'stand' });
  }

  /** Which of the 4 iso diagonals points most towards the target, judged on screen. */
  private facingOnScreen(from: Pt, to: Pt): Facing {
    const a = world(from.x, from.y);
    const b = world(to.x, to.y);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (dy < 0) return dx >= 0 ? 'up' : 'left';
    return dx >= 0 ? 'right' : 'down';
  }

  // ---------------------------------------------------------------- frame
  update(time: number, deltaMs: number) {
    const dt = Math.min(0.1, deltaMs / 1000);
    const env = { findPath: (a: Pt, b: Pt) => findPath(this.map, a, b) };
    this.stepKeys();

    const z = this.zoomLevel * this.opts.dpr;
    const Wd = this.scale.width;
    const Hd = this.scale.height;
    const vx0 = this.camX - Wd / (2 * z) - 120;
    const vx1 = this.camX + Wd / (2 * z) + 120;
    const vy0 = this.camY - Hd / (2 * z) - 40;
    const vy1 = this.camY + Hd / (2 * z) + 260;

    const t = time / 1000;
    const rally = (t / 1.6) % 1;
    let near: string | null = null;
    let nearD = 1.6;
    const ceo = this.chars.get(CEO_ID);

    const users = new Map<string, SeatUser>();
    const people: { pos: Pt; walking: boolean }[] = [];
    for (const c of this.chars.values()) {
      if (c.hidden) continue;
      tick(c.motion, dt, env);
      const m = c.motion;
      const goalSeat = m.goal?.key.startsWith('desk:') ? this.map.desks.find((d) => d.agentId === m.goal!.key.slice(5))?.id ?? null : null;
      if (goalSeat) c.seat = goalSeat;
      else if (c.seat) {
        const s = this.map.seats.find((x) => x.id === c.seat);
        if (!s || Math.hypot(m.pos.x - s.x, m.pos.y - s.y) > 1.6) c.seat = null;
      }
      if (c.seat) users.set(c.seat, { id: c.id, motion: m, hidden: c.hidden });
      people.push({ pos: m.pos, walking: m.phase === 'walking' });
      const onChair = c.seat && (m.phase === 'seated' || m.phase === 'sitting_down' || m.phase === 'standing_up');
      const rp = onChair ? this.furniture.seatPos(c.seat!, m.pos) : m.pos;
      const wp = world(rp.x, rp.y);
      // Painter's order by the feet on screen; seated people sit just in front of their chair; someone on
      // the treadmill stands on its belt (in front of the machine).
      c.view.place(wp.x, wp.y, wp.y + (m.phase === 'seated' ? 2 : 0) + (m.loop === 'treadmill' && m.at ? 90 : 0));
      const onScreen = wp.x > vx0 && wp.x < vx1 && wp.y > vy0 && wp.y < vy1;
      c.view.object.setVisible(onScreen);
      if (!onScreen) continue;
      const spot = m.goal?.key.startsWith('spot:') ? m.goal.key.slice(5) : '';
      const side: 0 | 1 = spot.endsWith('-b') ? 1 : 0;
      const pairPhase = m.loop === 'pingpong' ? rally : m.loop === 'chat' ? ((t / 7 + (hashString(spot.slice(0, -2)) % 100) / 100) % 1) : undefined;
      const lf = m.loop === 'raise_hand' || m.micro?.name === 'look_ceo' ? this.facingOnScreen(m.pos, this.map.ceoSeat) : undefined;
      c.view.render(m, { pairPhase, pairSide: side, lookFacing: lf, carry: c.carry }, t);
      if (ceo && c.id !== CEO_ID && this.opts.avatar) {
        const d = Math.hypot(m.pos.x - ceo.motion.pos.x, m.pos.y - ceo.motion.pos.y);
        if (d < nearD) { nearD = d; near = c.id; }
      }
    }
    this.near = near;

    this.furniture.update(dt, users, t);
    this.doors.update(dt, people, time);
    this.screenLayer.update(t);
    this.drawFx(t, rally);

    if (this.followId) {
      const f = this.chars.get(this.followId);
      if (f && !f.hidden) {
        const wp = world(f.motion.pos.x, f.motion.pos.y, 40);
        const k = Math.min(1, dt * 4);
        this.camX += (wp.x - this.camX) * k;
        this.camY += (wp.y - this.camY) * k;
      }
    }
    this.applyCamera();
    this.emitFrame();
    if (!this.readyFired) { this.readyFired = true; this.hooks.onReady(); }
  }

  private drawFx(t: number, rally: number) {
    const g = this.fx;
    g.clear();
    // espresso machine steam
    const m = W(551, 436);
    for (let i = 0; i < 3; i++) {
      const k = (t * 0.45 + i / 3) % 1;
      g.fillStyle(0xffffff, 0.3 * (1 - k));
      g.fillCircle(m.x + Math.sin(t * 2 + i * 2) * 3 * S, m.y - k * 22 * S, (2 + k * 4) * S);
    }
    // fireplace flicker
    this.fire.setAlpha(0.16 + this.ambient.lamps * 0.5 + Math.sin(t * 7.3) * 0.03 + Math.sin(t * 13.1) * 0.02);
    // ping-pong ball when both players are at the table
    const at = (key: string) => [...this.chars.values()].find((c) => !c.hidden && c.motion.goal?.key === key && c.motion.at === key);
    if (at('spot:pp-a') && at('spot:pp-b')) {
      const s = rally < 0.5 ? rally * 2 : 2 - rally * 2;
      const A = W(988, 612);
      const B = W(866, 700);
      const x = A.x + (B.x - A.x) * s;
      const y = A.y + (B.y - A.y) * s;
      const h = (8 + Math.abs(Math.sin(s * Math.PI * 2)) * 18) * S;
      g.fillStyle(0x000000, 0.22); g.fillEllipse(x, y + 2 * S, 5 * S, 2.4 * S);
      g.fillStyle(0xfff6e0, 1); g.fillCircle(x, y - h, 2.4 * S);
    }
  }

  private emitFrame() {
    const dpr = this.opts.dpr;
    const z = this.zoomLevel * dpr;
    const Wd = this.scale.width;
    const Hd = this.scale.height;
    const scale = z / dpr;
    const tx = (-this.camX * z + Wd / 2) / dpr;
    const ty = (-this.camY * z + Hd / 2) / dpr;
    const cw = Wd / dpr;
    const ch = Hd / dpr;
    const inside = (p: Pt) => p.x > -60 && p.x < cw + 60 && p.y > -40 && p.y < ch + 40;
    const tags: TagFrame[] = [];
    let ceoTag: TagFrame | null = null;
    for (const c of this.chars.values()) {
      const m = c.motion;
      const seated = m.phase === 'seated' || m.phase === 'sitting_down';
      const wp = world(m.pos.x, m.pos.y);
      const p = { x: wp.x * scale + tx, y: (wp.y - (seated ? 50 : 66) * FIGURE_SCALE) * scale + ty };
      const tag = { id: c.id, x: p.x, y: p.y, visible: !c.hidden && inside(p) };
      if (c.id === CEO_ID) ceoTag = tag; else tags.push(tag);
    }
    this.hooks.onFrame({ zoom: this.zoomLevel, width: cw, height: ch, view: { scale, tx, ty }, tags, ceo: ceoTag, near: this.near });
  }
}
