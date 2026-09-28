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
import { ceoGoalAt, ceoSeatGoal, deskGoal, type AgentView, type OfficeEvent, type OfficeModel, type ScreenApp } from '../logic/director';
import { hashString, mulberry32 } from '../logic/rng';
import { CEO_LOOK, lookFor } from './looks';
import { gameState, loadManifestSheets, manifestFactory, type CharacterFactory, type CharacterView, type OfficeManifest } from './characters';
import type { Item } from './pose';
import { FurnitureLayer, loadFurniture, type SeatUser } from './furniture';
import { OccluderLayer } from './occluders';
import { DoorLayer } from './doors';
import { ScreenLayer } from './screens';
import { officeAudio } from './audio';
import { PropLayer } from './props';
import { SuiteLayer } from './suite';

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
  [702, 118, 70], [770, 420, 60], [1090, 405, 60], [615, 573, 55], [762, 662, 55], [1446, 143, 70],
  [1712, 455, 70], [1550, 480, 55], [908, 210, 45], [1250, 505, 110], [2024, 468, 55], [1818, 640, 45],
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
  private props!: PropLayer;
  private suite!: SuiteLayer;
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
  /** CEO life: last time the person drove the avatar, when the current activity started, whether he holds a coffee. */
  private ceoLife = { lastUser: -1e9, since: 0, key: '', mug: false, next: 0 };
  private zzz: Phaser.GameObjects.Text[] = [];
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
    (globalThis as unknown as { __office?: unknown }).__office = this; // debugging handle (preview / tests)
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
    this.props = new PropLayer(this);
    this.props.create('office-bg');
    this.suite = new SuiteLayer(this);
    this.suite.create(NIGHT_DEPTH);
    this.screenLayer = new ScreenLayer(this, this.furniture);
    this.screenLayer.setMap(this.map);
    officeAudio.arm();
    this.fx = this.add.graphics().setDepth(FX_DEPTH);
    this.nightRect = this.add.rectangle(WORLD_W / 2, WORLD_H / 2, WORLD_W * 3, WORLD_H * 3, 0x0b1030, 0).setDepth(NIGHT_DEPTH);
    for (const [x, y, r] of LAMPS) {
      const p = W(x, y);
      this.glows.push(this.add.image(p.x, p.y, 'glow').setScale((r * S) / 64).setTint(0xffc98a).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0).setDepth(NIGHT_DEPTH + 1));
    }
    const f = W(1250, 505);
    this.fire = this.add.image(f.x, f.y, 'glow').setScale((90 * S) / 64).setTint(0xff9a3c).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0.18).setDepth(FX_DEPTH - 1);
    this.zzz = [0, 1, 2].map(() => this.add.text(0, 0, 'z', { fontFamily: 'ui-rounded, system-ui, sans-serif', fontStyle: '800', fontSize: `${14 * S}px`, color: '#e9e4ff', stroke: '#3b2f7a', strokeThickness: 3 * S }).setOrigin(0.5).setDepth(FX_DEPTH + 2).setVisible(false));
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
      const c = W(870, 330);
      this.camX = c.x; this.camY = c.y;
    } else {
      this.zoomLevel = this.coverZoom();
      // The picture is wider than most screens: keep the CEO suite (right) in the first view.
      const visW = this.scale.width / (this.zoomLevel * this.opts.dpr);
      this.camX = Math.max(WORLD_W / 2, WORLD_W - visW / 2);
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
    // Click-to-walk for the CEO avatar: onto a chair, sofa, the gym, the coffee bar or his bed when the tap is
    // on one (and nobody else is using it), else to the closest walkable point (graph node).
    this.ceoLife.lastUser = this.time.now;
    const t = PROJ.toTile(w.x / S, w.y / S);
    const ceo = this.chars.get(CEO_ID)!;
    const goal = this.ceoTarget(t);
    if (goal) { this.ceoGo(goal); this.followId = CEO_ID; return; }
    const n = nearestNode(this.map, t);
    const face = this.facingOnScreen(ceo.motion.pos, n.pos);
    setGoal(ceo.motion, { key: `node:${n.id}`, x: n.pos.x, y: n.pos.y, face, seated: false, loop: 'stand' });
    this.ceoLife.mug = false;
    this.followId = CEO_ID;
  }

  /** Keys (spot:/desk:/seat:) that someone other than the CEO is using or heading to. */
  private takenKeys() {
    const out = new Set<string>();
    for (const c of this.chars.values()) {
      if (c.id === CEO_ID || c.hidden || !c.motion.goal) continue;
      out.add(c.motion.goal.key);
      if (c.motion.goal.key.startsWith('desk:')) { const d = this.map.desks.find((x) => x.agentId === c.motion.goal!.key.slice(5)); if (d) out.add(`seat:${d.id}`); }
    }
    return out;
  }

  /** The spot or free desk chair nearest to a tile point (within ~1 tile), as a CEO goal. */
  private ceoTarget(t: Pt, maxD = 1.0): Goal | null {
    const taken = this.takenKeys();
    let best: Goal | null = null;
    let bestD = maxD;
    for (const s of this.map.spots) {
      const g = s.kind === 'ceo' ? { key: 'spot:ceo-chair', x: s.x, y: s.y, face: s.face, seated: true, loop: 'ceo_desk' as const } : ceoGoalAt(s);
      if (taken.has(g.key)) continue;
      const d = Math.hypot(t.x - s.x, t.y - s.y);
      if (d < bestD) { bestD = d; best = g; }
    }
    const owned = new Set(this.map.desks.map((d) => d.id));
    for (const seat of this.map.seats) {
      if (seat.kind === 'ceo' || seat.kind === 'board' || owned.has(seat.id)) continue;
      const g = ceoSeatGoal(seat);
      if (taken.has(g.key)) continue;
      const d = Math.hypot(t.x - seat.x, t.y - seat.y);
      if (d < bestD) { bestD = d; best = g; }
    }
    return best;
  }

  private ceoGo(g: Goal) {
    const ceo = this.chars.get(CEO_ID);
    if (!ceo) return;
    // Coffee in hand stays in hand on the way to a seat; anything else puts it down.
    if (g.loop === 'coffee') this.ceoLife.mug = true;
    else if (!(g.loop === 'sofa' || g.loop === 'lobby_sit')) this.ceoLife.mug = false;
    setGoal(ceo.motion, g);
    this.ceoLife.key = g.key;
    this.ceoLife.since = this.time.now;
  }

  /** When nobody drives the avatar, the CEO lives his day: desk, coffee then the lounge, the gym, the sofa — and bed at night. */
  private ceoRoutine(now: number) {
    const ceo = this.chars.get(CEO_ID);
    if (!ceo || now - this.ceoLife.lastUser < 90_000) return;
    const m = ceo.motion;
    const night = this.ambient.lamps > 0.55;
    const key = m.goal?.key ?? '';
    const arrived = m.at === key && m.phase !== 'walking';
    if (night) {
      if (key !== 'spot:ceo-bed') { const bed = this.map.spots.find((s) => s.kind === 'bed'); if (bed) this.ceoGo(ceoGoalAt(bed)); }
      return;
    }
    if (key === 'spot:ceo-bed') {
      // morning: get up and shower first
      const sh = this.map.spots.find((x) => x.kind === 'bath_shower');
      if (sh) { this.ceoGo(ceoGoalAt(sh)); this.ceoLife.next = now + 45_000; return; }
      this.ceoLife.next = 0;
    }
    if (key.startsWith('spot:ceo-bath-toilet') && now >= this.ceoLife.next) {
      const v = this.map.spots.find((x) => x.kind === 'bath_vanity'); // wash hands after
      if (v) { this.ceoGo(ceoGoalAt(v)); this.ceoLife.next = now + 8_000; return; }
    }
    if (!arrived && key !== 'spot:ceo-bed' && m.phase === 'walking') return;
    if (now < this.ceoLife.next && key !== 'spot:ceo-bed') return;
    const free = (kind: string) => { const taken = this.takenKeys(); return this.map.spots.filter((s) => s.kind === kind && !taken.has(`spot:${s.id}`)); };
    const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)];
    let g: Goal | null = null;
    let stay = 60_000;
    if (key.startsWith('spot:coffee')) {
      // Coffee made: go and drink it on a sofa.
      const sofas = [...free('lounge_sofa'), ...free('ceo_sofa')];
      if (sofas.length) { g = ceoGoalAt(pick(sofas)); stay = 45_000; }
    } else {
      const r = Math.random();
      const seat = this.map.ceoSeat;
      if (r < 0.5 || key !== 'spot:ceo-chair' && r < 0.62) { g = { key: 'spot:ceo-chair', x: seat.x, y: seat.y, face: seat.face, seated: true, loop: 'ceo_desk' }; stay = 120_000 + Math.random() * 120_000; }
      else if (r < 0.74) { const c = free('coffee'); if (c.length) { g = ceoGoalAt(pick(c)); stay = 9_000; } }
      else if (r < 0.8) { const c = free('bath_toilet'); if (c.length) { g = ceoGoalAt(c[0]); stay = 25_000; } }
      else if (r < 0.86) { const c = free('gym').filter((s) => s.loop === 'treadmill'); if (c.length) { g = ceoGoalAt(pick(c)); stay = 50_000; } }
      else { const c = free('ceo_sofa'); if (c.length) { g = ceoGoalAt(pick(c)); stay = 50_000; } }
    }
    if (g && g.key !== key) this.ceoGo(g);
    this.ceoLife.next = now + stay;
  }

  /** The CEO asleep: his figure goes under the duvet (the bed sprite with him in it), with drifting Zzz. */
  private ceoSleep(t: number) {
    const ceo = this.chars.get(CEO_ID);
    const m = ceo?.motion;
    const asleep = !!m && m.goal?.key === 'spot:ceo-bed' && m.at === 'spot:ceo-bed' && m.phase !== 'walking';
    this.furniture.setShown('bed', !asleep);
    this.furniture.setShown('bed-asleep', asleep);
    if (ceo && asleep) ceo.view.object.setVisible(false);
    const bed = this.furniture.placed.get('bed-asleep');
    this.zzz.forEach((z, i) => {
      if (!asleep || !bed) { z.setVisible(false); return; }
      const k = ((t * 0.35 + i / 3) % 1);
      const hx = bed.anchor.x + 22 * S; const hy = bed.anchor.y - 150 * S; // above the pillow
      z.setVisible(true).setPosition(hx + k * 26 * S + Math.sin(t * 2 + i) * 3 * S, hy - k * 40 * S).setAlpha(Math.sin(k * Math.PI)).setScale(0.6 + k * 0.7);
    });
  }

  private stepKeys() {
    if (!this.keys.size) return;
    this.ceoLife.lastUser = this.time.now;
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
    const rallyState = gameState(t, 0);
    const rally = rallyState.state === 'play' ? rallyState.k : -1;
    let near: string | null = null;
    let nearD = 1.6;
    const ceo = this.chars.get(CEO_ID);

    const users = new Map<string, SeatUser>();
    const people: { pos: Pt; walking: boolean }[] = [];
    for (const c of this.chars.values()) {
      if (c.hidden) continue;
      tick(c.motion, dt, env);
      const m = c.motion;
      const gk = m.goal?.key ?? '';
      const goalSeat = gk.startsWith('desk:') ? this.map.desks.find((d) => d.agentId === gk.slice(5))?.id ?? null
        : gk.startsWith('seat:') ? gk.slice(5)
        : gk === 'spot:ceo-chair' && this.map.seats.some((x) => x.id === 'ceo') ? 'ceo' : null;
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
      // someone sitting on a sprite sofa sits in front of its back and arms (the sofa's slices sort by its front edge)
      const onSofaSprite = m.at?.startsWith('spot:ceo-sofa') && (m.phase === 'seated' || m.phase === 'sitting_down' || m.phase === 'standing_up');
      c.view.place(wp.x, wp.y, wp.y + (m.phase === 'seated' ? 2 : 0) + (m.loop === 'treadmill' && m.at ? 90 : 0) + (onSofaSprite ? 34 * S : 0));
      // In the shower the CEO is a soft silhouette behind the fogged glass.
      const showering = m.loop === 'shower' && !!m.at && m.phase !== 'walking';
      (c.view.object as unknown as { setAlpha(a: number): void }).setAlpha(showering ? 0.42 : 1);
      const onScreen = wp.x > vx0 && wp.x < vx1 && wp.y > vy0 && wp.y < vy1;
      c.view.object.setVisible(onScreen);
      if (!onScreen) continue;
      const spot = m.goal?.key.startsWith('spot:') ? m.goal.key.slice(5) : '';
      const side: 0 | 1 = spot.endsWith('-b') ? 1 : 0;
      const pairPhase = m.loop === 'pingpong' || m.loop === 'foosball' ? Math.max(0, rally) : m.loop === 'chat' ? ((t / 7 + (hashString(spot.slice(0, -2)) % 100) / 100) % 1) : undefined;
      const lf = m.loop === 'raise_hand' || m.micro?.name === 'look_ceo' ? this.facingOnScreen(m.pos, this.map.ceoSeat) : undefined;
      c.view.render(m, { pairPhase, pairSide: side, lookFacing: lf, carry: c.carry }, time / 1000);
      if (ceo && c.id !== CEO_ID && this.opts.avatar) {
        const d = Math.hypot(m.pos.x - ceo.motion.pos.x, m.pos.y - ceo.motion.pos.y);
        if (d < nearD) { nearD = d; near = c.id; }
      }
    }
    this.near = near;

    this.furniture.update(dt, users, t);
    this.doors.update(dt, people, time);
    this.screenLayer.update(t);
    this.suite.update(dt, t, this.ambient);
    this.props.update(dt, t, [...this.chars.values()].map((c) => ({ id: c.id, motion: c.motion, hidden: c.hidden })), this.ambient.lamps);
    this.ceoRoutine(time);
    this.ceoSleep(t);
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
    // the CEO's shower: rain from the shower head, drops bouncing on the tray, steam fogging up the glass
    const bossS = this.chars.get(CEO_ID);
    if (bossS && bossS.motion.loop === 'shower' && bossS.motion.at && bossS.motion.phase !== 'walking') {
      const p = world(bossS.motion.pos.x, bossS.motion.pos.y);
      const top = p.y - 84 * S; const bot = p.y - 2 * S;
      g.lineStyle(1 * S, 0xcfe8ff, 0.55);
      for (let i = 0; i < 26; i++) {
        const k = ((t * 1.9 + i * 0.137) % 1);
        const x = p.x - 14 * S + ((i * 37) % 28) * S + Math.sin(i) * 2 * S;
        const y = top + (bot - top) * k;
        g.lineBetween(x, y, x - 0.6 * S, y + 6 * S);
      }
      for (let i = 0; i < 7; i++) {
        const k = ((t * 0.25 + i / 7) % 1);
        g.fillStyle(0xffffff, 0.16 * (1 - k)); g.fillCircle(p.x - 16 * S + ((i * 23) % 32) * S + Math.sin(t + i) * 3 * S, bot - 20 * S - k * 70 * S, (5 + k * 9) * S);
      }
      g.fillStyle(0xe6f2ff, 0.18); g.fillRect(p.x - 18 * S, top, 36 * S, bot - top);
    }
    // the CEO's coffee: a mug in his hand while he carries it and drinks it on the sofa, with a curl of steam
    const boss = this.chars.get(CEO_ID);
    if (boss && this.ceoLife.mug && boss.view.object.visible && !(boss.motion.phase === 'standing' && boss.motion.loop === 'coffee')) {
      const m = boss.motion;
      const seated = m.phase === 'seated';
      const sip = seated ? Math.max(0, Math.sin(t * 0.9)) ** 8 : 0; // now and then a sip
      const o = boss.view.object;
      const x = o.x + (seated ? 7 : 9) * S; const y = o.y - (seated ? 34 : 40) * S - sip * 16 * S;
      g.fillStyle(0xf4f1ea, 1); g.fillRoundedRect(x - 3 * S, y - 4 * S, 6 * S, 7 * S, 1.5 * S);
      g.lineStyle(1 * S, 0x2a2a2a, 0.9); g.strokeRoundedRect(x - 3 * S, y - 4 * S, 6 * S, 7 * S, 1.5 * S);
      g.lineStyle(1.2 * S, 0xf4f1ea, 1); g.beginPath(); g.arc(x + 3.4 * S, y - 0.5 * S, 1.8 * S, -1.2, 1.2); g.strokePath();
      g.fillStyle(0x5a3a22, 1); g.fillRect(x - 2.2 * S, y - 3.4 * S, 4.4 * S, 1.2 * S);
      for (let i = 0; i < 2; i++) {
        const k = (t * 0.6 + i * 0.5) % 1;
        g.fillStyle(0xffffff, 0.35 * (1 - k)); g.fillCircle(x + Math.sin(t * 3 + i * 2) * 1.5 * S, y - 6 * S - k * 10 * S, (1.4 + k * 1.6) * S);
      }
    }
    // fireplace flicker
    this.fire.setAlpha(0.16 + this.ambient.lamps * 0.5 + Math.sin(t * 7.3) * 0.03 + Math.sin(t * 13.1) * 0.02);
    // ping-pong ball when both players are at the table
    const at = (key: string) => [...this.chars.values()].find((c) => !c.hidden && c.motion.goal?.key === key && c.motion.at === key);
    if (rally >= 0 && at('spot:pp-a') && at('spot:pp-b')) {
      const s = rally < 0.5 ? rally * 2 : 2 - rally * 2;
      const A = W(1438, 612);
      const B = W(1316, 700);
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
      const asleep = c.id === CEO_ID && m.goal?.key === 'spot:ceo-bed' && m.at === 'spot:ceo-bed';
      const tag = { id: c.id, x: p.x, y: p.y, visible: !c.hidden && !asleep && inside(p) };
      if (c.id === CEO_ID) ceoTag = tag; else tags.push(tag);
    }
    this.hooks.onFrame({ zoom: this.zoomLevel, width: cw, height: ch, view: { scale, tx, ty }, tags, ceo: ceoTag, near: this.near });
  }
}
