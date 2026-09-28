// The isometric office scene: static art (baked once), characters driven by the motion state machine,
// camera (pan / pinch / wheel zoom / follow), CEO avatar (click-to-walk + WASD), day/night.
import * as Phaser from 'phaser';
import { OFFICE, FACING_STEP, facingTowards, key as tkey, wallBetween, type Facing } from '../logic/map';
import { TH, TW, depthAt, footprintDepth, isoToWorld, worldToIso, type Pt } from '../logic/iso';
import { findPath, isWalkable, nearestFree } from '../logic/pathfinding';
import { createMotion, setGoal, tick, trigger, type Goal, type Motion } from '../logic/motion';
import { deskGoal, type AgentView, type OfficeEvent, type OfficeModel, type ScreenApp } from '../logic/director';
import { hashString, mulberry32 } from '../logic/rng';
import { placeBaked, makeGlow } from './art';
import { bakeBackdrop, bakeFloor, bakeWalls, WALL_OUTER_H, SLAB } from './environment';
import { bakeChair, bakeProp, monitorsFor, slicesFor } from './props';
import { bake } from './art';
import { APP_GLOW, screenTexture, SCREEN_HZ, SCREEN_LU, type ScreenOrient } from './screens';
import { CEO_LOOK, lookFor } from './looks';
import { loadManifestSheets, manifestFactory, proceduralFactory, type CharacterFactory, type CharacterView, type OfficeManifest } from './characters';
import type { Item } from './pose';

export const ORIGIN: Pt = { x: OFFICE.rows * (TW / 2) + 160, y: 520 };
export const WORLD_W = (OFFICE.cols + OFFICE.rows) * (TW / 2) + 320;
export const WORLD_H = ORIGIN.y + (OFFICE.cols + OFFICE.rows) * (TH / 2) + 140;
const BUILDING = {
  x0: ORIGIN.x - OFFICE.rows * (TW / 2) - 16,
  x1: ORIGIN.x + OFFICE.cols * (TW / 2) + 16,
  y0: ORIGIN.y - WALL_OUTER_H - 40,
  y1: ORIGIN.y + (OFFICE.cols + OFFICE.rows) * (TH / 2) + SLAB + 12,
};
const CEO_ID = '__ceo__';
const NIGHT_DEPTH = 50_000;

export interface TagFrame { id: string; x: number; y: number; visible: boolean }
export interface FrameInfo {
  zoom: number;
  width: number; height: number;
  tags: TagFrame[];
  ceo: TagFrame | null;
  rooms: { id: string; x: number; y: number; visible: boolean }[];
  /** Screen position above the Boardroom for the meeting label. */
  meeting: { x: number; y: number; visible: boolean };
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
}
interface ChairSlot { key: string; x: number; y: number; face: Facing; img: Phaser.GameObjects.Image; off: number; baseX: number; baseY: number }
interface ScreenSlot { agentId: string; orient: ScreenOrient; imgs: Phaser.GameObjects.Image[]; glows: Phaser.GameObjects.Image[]; app: ScreenApp; frame: number; lu: number; hz: number }

const iso = (x: number, y: number, z = 0) => isoToWorld(x, y, z, ORIGIN);

export class OfficeScene extends Phaser.Scene {
  private hooks!: SceneHooks;
  private opts!: SceneOptions;
  private factory: CharacterFactory = proceduralFactory;
  private chars = new Map<string, Char>();
  private chairs: ChairSlot[] = [];
  private screens = new Map<string, ScreenSlot>();
  private benchScreen: ScreenSlot | null = null;
  private pending: { model: OfficeModel; events: OfficeEvent[] } | null = null;
  private model: OfficeModel | null = null;
  private camX = WORLD_W / 2;
  private camY = WORLD_H / 2;
  private zoomLevel = 0.3; // CSS zoom (device zoom = zoomLevel * dpr)
  private userCamera = false;
  private followId: string | null = null;
  private night = false;
  private nightRect!: Phaser.GameObjects.Rectangle;
  private backdropDay!: Phaser.GameObjects.Image;
  private backdropNight!: Phaser.GameObjects.Image;
  private fx!: Phaser.GameObjects.Graphics;
  private keys = new Set<string>();
  private drag: { x: number; y: number; moved: boolean; camX: number; camY: number } | null = null;
  private pinch: { d: number; zoom: number } | null = null;
  private frameTimer = 0;
  private near: string | null = null;
  private readyFired = false;
  private cleanup: (() => void)[] = [];

  constructor() { super('office'); }

  init(data: { hooks: SceneHooks; opts: SceneOptions }) {
    this.hooks = data.hooks;
    this.opts = data.opts;
  }

  preload() {
    this.load.json('office-manifest', '/office/manifest.json');
    this.load.once('filecomplete-json-office-manifest', (_k: string, _t: string, data: OfficeManifest) => {
      if (data && Object.keys(data.characters ?? {}).length) loadManifestSheets(this, data);
    });
  }

  create() {
    const manifest = (this.cache.json.get('office-manifest') as OfficeManifest | undefined) ?? null;
    this.factory = manifestFactory(manifest);
    this.cameras.main.setBackgroundColor('#0e0d26');
    this.buildWorld();
    this.fx = this.add.graphics().setDepth(NIGHT_DEPTH - 1);
    this.nightRect = this.add.rectangle(WORLD_W / 2, WORLD_H / 2, WORLD_W * 3, WORLD_H * 3, 0x0a0f30, 0).setDepth(NIGHT_DEPTH);
    this.setupInput();
    this.fitView();
    const ceo = OFFICE.ceoSeat;
    this.addChar(CEO_ID, CEO_LOOK, { key: 'spot:ceo-chair', x: ceo.x, y: ceo.y, face: ceo.face, seated: true, loop: 'ceo_desk' }, null);
    if (this.pending) { this.applyModel(this.pending.model, this.pending.events); this.pending = null; }
    this.scale.on('resize', () => { if (!this.userCamera) this.fitView(); });
  }

  // ---------------------------------------------------------------- world
  private buildWorld() {
    const m = OFFICE;
    const day = bakeBackdrop(this, ORIGIN, false);
    const night = bakeBackdrop(this, ORIGIN, true);
    this.backdropDay = this.add.image(day.x, day.y, day.key).setOrigin(0, 0).setScale(day.scale).setDepth(-30000);
    this.backdropNight = this.add.image(night.x, night.y, night.key).setOrigin(0, 0).setScale(night.scale).setDepth(-30000).setVisible(false);
    const floor = bakeFloor(this);
    const o = iso(0, 0);
    placeBaked(this, floor, o.x, o.y, -20000);

    // walls: outer window walls on the two back edges, glass partitions elsewhere
    const walls = bakeWalls(this);
    for (const k of m.hWalls) {
      const [x, y] = k.split(',').map(Number);
      const p = iso(x, y);
      placeBaked(this, y === 0 ? walls.hOuter : walls.hGlass, p.x, p.y, x + y + 0.5);
    }
    for (let x = 0; x < m.cols; x++) { const p = iso(x, 0); placeBaked(this, walls.hOuter, p.x, p.y, x + 0.5); }
    for (const k of m.vWalls) {
      const [x, y] = k.split(',').map(Number);
      const p = iso(x, y);
      placeBaked(this, walls.vGlass, p.x, p.y, x + y + 0.5);
    }
    for (let y = 0; y < m.rows; y++) { const p = iso(0, y); placeBaked(this, walls.vOuter, p.x, p.y, y + 0.5); }

    // props
    for (const p of m.props) {
      const flat = p.kind === 'rug';
      const wallDecor = p.kind === 'kanban' || p.kind === 'tv_wall' || p.kind === 'foam';
      const slices = slicesFor(p);
      if (slices) {
        for (const s of slices) {
          const b = bake(this, s.key, 1, 1, s.maxH, s.draw);
          const w = iso(s.tx, s.ty);
          const seat = p.kind === 'sofa' || p.kind === 'couch';
          const behind = seat && (p.face === 'right' || p.face === 'down');
          placeBaked(this, b, w.x, w.y, depthAt(s.tx, s.ty) + 1 + (seat ? (behind ? -0.06 : 0.06) : 0));
        }
        continue;
      }
      const b = bakeProp(this, p);
      const w = iso(p.x, p.y);
      const depth = flat ? -19000 + p.x * 0.001 : wallDecor ? p.x + p.y + 0.6
        : p.kind === 'armchair' ? depthAt(p.x, p.y) + 1 + (p.face === 'left' || p.face === 'up' ? 0.06 : -0.06)
          : footprintDepth(p.x, p.y, p.w, p.h);
      placeBaked(this, b, w.x, w.y, depth);
    }

    // chairs: every desk (except the vocal booth), boardroom seats and the CEO chair
    for (const d of m.desks) if (d.kind !== 'booth') this.addChair(`desk:${d.agentId}`, d.x, d.y, d.face, 0x3d424b);
    for (const s of m.spots) {
      if (s.kind === 'boardroom') this.addChair(`spot:${s.id}`, s.x, s.y, s.face, 0x4f5a6e);
      if (s.kind === 'ceo') this.addChair(`spot:${s.id}`, s.x, s.y, s.face, 0x26272b);
    }

    // screens
    makeGlow(this, 'glow', 64);
    for (const d of m.desks) {
      if (d.kind === 'booth') continue;
      const orient: ScreenOrient = d.face === 'left' ? 'left' : 'up';
      const slot: ScreenSlot = { agentId: d.agentId, orient, imgs: [], glows: [], app: 'screensaver', frame: 0, lu: SCREEN_LU, hz: SCREEN_HZ };
      const deskDepth = d.face === 'left' ? footprintDepth(d.x - 1, d.y - 1, 1, 3) : footprintDepth(d.x - 1, d.y - 1, 3, 1);
      for (const [a0] of monitorsFor(d.kind)) {
        const pos = orient === 'up' ? iso(d.x - 1 + a0 + 0.03, d.y - 1 + 0.32, 33) : iso(d.x - 1 + 0.32, d.y - 1 + a0 + 0.03, 33);
        const tex = screenTexture(this, orient, 'screensaver', 0);
        slot.imgs.push(this.add.image(pos.x, pos.y, tex.key).setOrigin(tex.ox / tex.w, tex.oy / tex.h).setDepth(deskDepth + 0.002));
        const c = orient === 'up' ? iso(d.x - 1 + a0 + 0.48, d.y - 1 + 0.5, 42) : iso(d.x - 1 + 0.5, d.y - 1 + a0 + 0.48, 42);
        slot.glows.push(this.add.image(c.x, c.y + 6, 'glow').setScale(1.3, 0.9).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0).setDepth(NIGHT_DEPTH + 1));
      }
      this.screens.set(d.agentId, slot);
    }
    // QA bench big screen
    {
      const lu = 1.4;
      const hz = 26;
      const pos = iso(39.83, 3.2, 36);
      const tex = screenTexture(this, 'up', 'screensaver', 0, lu, hz);
      const img = this.add.image(pos.x, pos.y, tex.key).setOrigin(tex.ox / tex.w, tex.oy / tex.h).setDepth(footprintDepth(39, 3, 3, 1) + 0.002);
      const c = iso(40.5, 3.5, 50);
      const glow = this.add.image(c.x, c.y, 'glow').setScale(2, 1.2).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0).setDepth(NIGHT_DEPTH + 1);
      this.benchScreen = { agentId: 'qa-bench', orient: 'up', imgs: [img], glows: [glow], app: 'screensaver', frame: 0, lu, hz };
    }
    // warm lamp glows (night): espresso bar, reception, CEO desk lamp, boardroom TV
    for (const [x, y, z, s] of [[35, 21.5, 50, 2.5], [53, 30.5, 40, 2.4], [51.4, 5.35, 44, 1.6], [0.3, 4.5, 64, 2.6]] as const) {
      const c = iso(x, y, z);
      this.add.image(c.x, c.y, 'glow').setScale(s, s * 0.7).setTint(0xffd9a0).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0).setDepth(NIGHT_DEPTH + 1).setName('lamp');
    }
  }

  private addChair(key: string, x: number, y: number, face: Facing, color: number) {
    const b = bakeChair(this, face, color);
    const p = iso(x, y);
    const img = placeBaked(this, b, p.x, p.y, depthAt(x, y) + 1 + (face === 'up' || face === 'left' ? 0.06 : -0.06));
    this.chairs.push({ key, x, y, face, img, off: 0.18, baseX: p.x, baseY: p.y });
  }

  // ---------------------------------------------------------------- model binding
  setModel(model: OfficeModel, events: OfficeEvent[]) {
    if (!this.sys.isActive() || !this.chars.has(CEO_ID)) { this.pending = { model, events: [...(this.pending?.events ?? []), ...events] }; return; }
    this.applyModel(model, events);
  }

  private addChar(id: string, look: ReturnType<typeof lookFor>, start: Goal, agent: AgentView | null): Char {
    const rng = mulberry32(hashString(id) || 1);
    const motion = createMotion(start, rng);
    const view = this.factory.create(this, id, look);
    const c: Char = { id, view, motion, agent, hidden: false, carry: (look.prop as Item) ?? null };
    this.chars.set(id, c);
    return c;
  }

  private applyModel(model: OfficeModel, events: OfficeEvent[]) {
    this.model = model;
    const seen = new Set<string>([CEO_ID]);
    for (const a of model.agents) {
      seen.add(a.id);
      let c = this.chars.get(a.id);
      if (!c) {
        const start = a.goal ?? deskGoal(OFFICE, a.id, 'desk_idle') ?? { key: 'spot:lobby-3', x: 54, y: 25, face: 'up' as Facing, seated: false, loop: 'stand' as const };
        c = this.addChar(a.id, lookFor(a.id, a.color), start, a);
      }
      c.agent = a;
      for (const e of events) if (e.agentId === a.id) trigger(c.motion, e.gesture);
      if (!a.goal) {
        c.hidden = true;
        c.view.setVisible(false);
      } else {
        if (c.hidden) {
          // Coming back online: walk in from the lobby entrance.
          c.hidden = false;
          c.view.setVisible(true);
          c.motion = createMotion({ key: 'spot:entrance', x: 50, y: 31, face: 'up', seated: false, loop: 'stand' }, mulberry32(hashString(a.id)));
        }
        setGoal(c.motion, a.goal);
      }
      this.setScreen(a.id, a.status === 'offline' ? 'off' : a.screen);
    }
    for (const [id, c] of this.chars) if (!seen.has(id)) { c.view.destroy(); this.chars.delete(id); }
    const qa = model.agents.find((a) => a.id === 'qa-lead');
    if (this.benchScreen) this.setScreenSlot(this.benchScreen, qa?.goal?.key === 'spot:qa-bench' ? 'review' : 'screensaver');
  }

  private setScreen(agentId: string, app: ScreenApp) {
    const s = this.screens.get(agentId);
    if (s) this.setScreenSlot(s, app);
  }

  private setScreenSlot(s: ScreenSlot, app: ScreenApp) {
    if (s.app === app) return;
    s.app = app;
    this.refreshScreen(s);
  }

  private refreshScreen(s: ScreenSlot) {
    s.imgs.forEach((img, i) => {
      // Second monitor of dev/edit desks shows a browser preview / reference.
      const app = i === 1 && s.app !== 'off' && s.app !== 'screensaver' ? (s.app === 'editor' ? 'browser' : s.app === 'timeline' ? 'timeline' : s.app) : s.app;
      const tex = screenTexture(this, s.orient, app, i === 1 ? (s.frame + 1) % 2 : s.frame, s.lu, s.hz);
      img.setTexture(tex.key);
    });
    const glowOn = s.app !== 'off';
    s.glows.forEach((g) => { g.setTint(APP_GLOW[s.app]); g.setData('on', glowOn); g.setAlpha(this.night && glowOn ? 0.45 : 0); });
  }

  // ---------------------------------------------------------------- controls from React
  setNight(night: boolean) {
    this.night = night;
    if (!this.nightRect) return;
    this.tweens.add({ targets: this.nightRect, fillAlpha: night ? 0.42 : 0, duration: 900 });
    this.backdropDay.setVisible(!night);
    this.backdropNight.setVisible(night);
    const all = [...this.screens.values(), ...(this.benchScreen ? [this.benchScreen] : [])];
    for (const s of all) s.glows.forEach((g) => g.setAlpha(night && g.getData('on') ? 0.45 : 0));
    this.children.list.filter((o) => o.name === 'lamp').forEach((o) => (o as Phaser.GameObjects.Image).setAlpha(night ? 0.55 : 0));
  }

  zoomBy(f: number) {
    const W = this.scale.width;
    const H = this.scale.height;
    this.zoomAt(W / 2, H / 2, this.zoomLevel * f);
    this.userCamera = true;
  }

  resetView() { this.userCamera = false; this.followId = null; this.fitView(); }

  follow(id: string | null) {
    this.followId = id === 'ceo' ? CEO_ID : id;
    if (this.followId && this.zoomLevel < 0.7) this.zoomLevel = Math.min(this.maxZoom(), 0.9);
    this.userCamera = true;
  }

  setAvatar(on: boolean) { this.opts.avatar = on; }

  // ---------------------------------------------------------------- camera
  private fitZoom() {
    const W = this.scale.width / this.opts.dpr;
    const H = this.scale.height / this.opts.dpr;
    return Math.min(W / (BUILDING.x1 - BUILDING.x0), H / (BUILDING.y1 - BUILDING.y0));
  }
  private minZoom() { return Math.min(0.2, this.fitZoom() * 0.9); }
  private maxZoom() { return 2.4; }

  private fitView() {
    const W = this.scale.width / this.opts.dpr;
    if (this.opts.startZoom === 'close' || W < 640) {
      // Phones: start closer, centred on the Dev / Growth rooms (spectator mode).
      this.zoomLevel = Math.max(this.fitZoom(), W < 640 ? 0.42 : 0.6);
      const c = iso(24, 12);
      this.camX = c.x; this.camY = c.y;
    } else {
      this.zoomLevel = this.fitZoom();
      this.camX = (BUILDING.x0 + BUILDING.x1) / 2;
      this.camY = (BUILDING.y0 + BUILDING.y1) / 2;
    }
    this.applyCamera();
  }

  private clampCamera() {
    const W = this.scale.width / (this.zoomLevel * this.opts.dpr);
    const H = this.scale.height / (this.zoomLevel * this.opts.dpr);
    const bx0 = BUILDING.x0 - 200;
    const bx1 = BUILDING.x1 + 200;
    const by0 = BUILDING.y0 - 260;
    const by1 = BUILDING.y1 + 160;
    this.camX = W >= bx1 - bx0 ? (bx0 + bx1) / 2 : Math.min(bx1 - W / 2, Math.max(bx0 + W / 2, this.camX));
    this.camY = H >= by1 - by0 ? (by0 + by1) / 2 : Math.min(by1 - H / 2, Math.max(by0 + H / 2, this.camY));
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

  private onTap(px: number, py: number) {
    const w = this.toWorld(px, py);
    // characters first (front-most wins)
    const hits = [...this.chars.values()]
      .filter((c) => !c.hidden && c.view.object.visible)
      .filter((c) => {
        const o = c.view.object;
        const seated = c.motion.phase === 'seated';
        return w.x > o.x - 15 && w.x < o.x + 15 && w.y > o.y - (seated ? 66 : 80) && w.y < o.y + 6;
      })
      .sort((a, b) => b.view.object.depth - a.view.object.depth);
    const hit = hits[0];
    if (hit && hit.id !== CEO_ID) { this.hooks.onSelect(hit.id); return; }
    if (!this.opts.avatar) return;
    // click-to-walk for the CEO avatar
    const t = worldToIso(w.x, w.y, ORIGIN);
    const tx = Math.floor(t.x);
    const ty = Math.floor(t.y);
    const ceo = this.chars.get(CEO_ID)!;
    const seat = OFFICE.ceoSeat;
    if (tx === seat.x && ty === seat.y) {
      setGoal(ceo.motion, { key: 'spot:ceo-chair', x: seat.x, y: seat.y, face: seat.face, seated: true, loop: 'ceo_desk' });
      return;
    }
    const free = nearestFree(OFFICE, tx, ty, 3);
    if (!free) return;
    const face = facingTowards(ceo.motion.pos.x, ceo.motion.pos.y, free.x, free.y);
    setGoal(ceo.motion, { key: `tile:${free.x},${free.y}`, x: free.x, y: free.y, face, seated: false, loop: 'stand' });
    this.followId = CEO_ID;
  }

  private stepKeys() {
    if (!this.keys.size) return;
    const ceo = this.chars.get(CEO_ID);
    if (!ceo) return;
    const m = ceo.motion;
    if (m.phase === 'walking' || m.phase === 'standing_up' || m.phase === 'sitting_down') return;
    const k = this.keys;
    // Screen-aligned: W/up = up-right? Use grid directions that feel natural on an iso map.
    const dir: Facing | null = k.has('w') || k.has('arrowup') ? 'up' : k.has('s') || k.has('arrowdown') ? 'down'
      : k.has('a') || k.has('arrowleft') ? 'left' : k.has('d') || k.has('arrowright') ? 'right' : null;
    if (!dir) return;
    const st = FACING_STEP[dir];
    const x = Math.round(m.pos.x);
    const y = Math.round(m.pos.y);
    const nx = x + st.dx;
    const ny = y + st.dy;
    if (!isWalkable(OFFICE, nx, ny) || OFFICE.seats.has(tkey(nx, ny)) || wallBetween(OFFICE, x, y, nx, ny)) {
      m.facing = dir;
      return;
    }
    setGoal(m, { key: `tile:${nx},${ny}`, x: nx, y: ny, face: dir, seated: false, loop: 'stand' });
  }

  // ---------------------------------------------------------------- frame
  update(time: number, deltaMs: number) {
    const dt = Math.min(0.1, deltaMs / 1000);
    const env = { findPath: (a: Pt, b: Pt) => findPath(OFFICE, a, b) };
    this.stepKeys();

    const z = this.zoomLevel * this.opts.dpr;
    const W = this.scale.width;
    const H = this.scale.height;
    const vx0 = this.camX - W / (2 * z) - 40;
    const vx1 = this.camX + W / (2 * z) + 40;
    const vy0 = this.camY - H / (2 * z) - 20;
    const vy1 = this.camY + H / (2 * z) + 90;

    // pair phases (ping-pong rally, chats)
    const t = time / 1000;
    const rally = (t / 1.5) % 1;
    let near: string | null = null;
    let nearD = 1.9;
    const ceo = this.chars.get(CEO_ID);

    for (const c of this.chars.values()) {
      if (c.hidden) continue;
      tick(c.motion, dt, env);
      const m = c.motion;
      const wp = iso(m.pos.x + 0.5, m.pos.y + 0.5);
      const atGoal = !!m.goal && m.at === m.goal.key;
      const bump = atGoal && m.loop === 'pingpong' ? 1.2 : 0;
      c.view.place(wp.x, wp.y, m.pos.x + m.pos.y + 1 + 0.03 + bump);
      const onScreen = wp.x > vx0 && wp.x < vx1 && wp.y > vy0 && wp.y < vy1;
      c.view.object.setVisible(onScreen);
      if (!onScreen) continue;
      const spot = m.goal?.key.startsWith('spot:') ? m.goal.key.slice(5) : '';
      const side: 0 | 1 = spot.endsWith('-b') ? 1 : 0;
      const pairPhase = m.loop === 'pingpong' ? rally : m.loop === 'chat' ? ((t / 7 + (hashString(spot.slice(0, -2)) % 100) / 100) % 1) : undefined;
      const lf = m.loop === 'raise_hand' || m.micro?.name === 'look_ceo' ? this.gridFacingTowards(m.pos, OFFICE.ceoSeat) : undefined;
      c.view.render(m, { pairPhase, pairSide: side, lookFacing: lf, carry: c.carry }, t);
      if (ceo && c.id !== CEO_ID && this.opts.avatar) {
        const d = Math.hypot(m.pos.x - ceo.motion.pos.x, m.pos.y - ceo.motion.pos.y);
        if (d < nearD) { nearD = d; near = c.id; }
      }
    }
    this.near = near;

    this.updateChairs(dt);
    this.updateFx(t, rally);

    // animate working screens (content scrolls every ~1.2 s)
    this.frameTimer += dt;
    if (this.frameTimer > 1.2) {
      this.frameTimer = 0;
      for (const s of this.screens.values()) {
        if (s.app === 'off' || s.app === 'screensaver') continue;
        s.frame = (s.frame + 1) % 2;
        this.refreshScreen(s);
      }
      if (this.benchScreen && this.benchScreen.app === 'review') { this.benchScreen.frame = (this.benchScreen.frame + 1) % 2; this.refreshScreen(this.benchScreen); }
    }

    // follow
    if (this.followId) {
      const f = this.chars.get(this.followId);
      if (f && !f.hidden) {
        const wp = iso(f.motion.pos.x + 0.5, f.motion.pos.y + 0.5, 30);
        const k = Math.min(1, dt * 4);
        this.camX += (wp.x - this.camX) * k;
        this.camY += (wp.y - this.camY) * k;
      }
    }
    this.applyCamera();
    this.emitFrame();
    if (!this.readyFired) { this.readyFired = true; this.hooks.onReady(); }
  }

  private gridFacingTowards(from: Pt, to: Pt): Facing {
    // Which of the 4 iso diagonals points most towards the target, judged on screen.
    const a = iso(from.x, from.y);
    const b = iso(to.x, to.y);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (dy < 0) return dx >= 0 ? 'up' : 'left';
    return dx >= 0 ? 'right' : 'down';
  }

  private updateChairs(dt: number) {
    for (const s of this.chairs) {
      // Occupied (or being sat on) → pulled out; empty → pushed in towards the desk.
      let target = 0.18;
      let occupantDepth: number | null = null;
      for (const c of this.chars.values()) {
        if (c.hidden || c.motion.goal?.key !== s.key) continue;
        const m = c.motion;
        const d = Math.hypot(m.pos.x - s.x, m.pos.y - s.y);
        if (d < 0.6) {
          target = m.phase === 'seated' ? 0 : m.phase === 'sitting_down' || m.phase === 'standing_up' ? -0.12 : 0.24;
          occupantDepth = m.pos.x + m.pos.y + 1.03;
        } else if (d < 2.5 && m.phase === 'walking') target = -0.05;
      }
      // someone who just stood up and is walking away: chair gets pushed in after them
      s.off += (target - s.off) * Math.min(1, dt * 5);
      const st = FACING_STEP[s.face];
      const p = iso(s.x + st.dx * s.off, s.y + st.dy * s.off);
      s.img.setPosition(p.x, p.y);
      const front = s.face === 'up' || s.face === 'left';
      if (occupantDepth !== null) s.img.setDepth(occupantDepth + (front && target <= 0 ? 0.03 : -0.06));
      else s.img.setDepth(depthAt(s.x, s.y) + 1 + (front ? 0.06 : -0.06));
    }
  }

  private updateFx(t: number, rally: number) {
    const g = this.fx;
    g.clear();
    // espresso steam
    const m = iso(34.5, 21.35, 50);
    for (let i = 0; i < 3; i++) {
      const k = (t * 0.45 + i / 3) % 1;
      g.fillStyle(0xffffff, 0.35 * (1 - k));
      g.fillCircle(m.x + Math.sin(t * 2 + i * 2) * 3, m.y - k * 26, 2 + k * 4);
    }
    // ping-pong ball when both players are at the table
    const a = [...this.chars.values()].find((c) => !c.hidden && c.motion.goal?.key === 'spot:pp-a' && c.motion.at === 'spot:pp-a');
    const b = [...this.chars.values()].find((c) => !c.hidden && c.motion.goal?.key === 'spot:pp-b' && c.motion.at === 'spot:pp-b');
    if (a && b) {
      const s = rally < 0.5 ? rally * 2 : 2 - rally * 2; // 0 at A, 1 at B
      const A = { x: 41.95, y: 24.2 };
      const B = { x: 44.95, y: 23.8 };
      const x = A.x + (B.x - A.x) * s;
      const y = A.y + (B.y - A.y) * s;
      const hgt = 27 + Math.abs(Math.sin(s * Math.PI * 2)) * 16;
      const p = iso(x, y, hgt);
      const sh = iso(x, y, 25);
      g.fillStyle(0x000000, 0.2); g.fillEllipse(sh.x, sh.y, 5, 2.4);
      g.fillStyle(0xfff6e0, 1); g.fillCircle(p.x, p.y, 2.2);
      g.setDepth(71.5);
    } else g.setDepth(NIGHT_DEPTH - 1);
  }

  private emitFrame() {
    const dpr = this.opts.dpr;
    const z = this.zoomLevel * dpr;
    const W = this.scale.width;
    const H = this.scale.height;
    const toScreen = (wx: number, wy: number) => ({ x: ((wx - this.camX) * z + W / 2) / dpr, y: ((wy - this.camY) * z + H / 2) / dpr });
    const cw = W / dpr;
    const ch = H / dpr;
    const inside = (p: Pt) => p.x > -40 && p.x < cw + 40 && p.y > -30 && p.y < ch + 30;
    const tags: TagFrame[] = [];
    let ceoTag: TagFrame | null = null;
    for (const c of this.chars.values()) {
      const m = c.motion;
      const seated = m.phase === 'seated' || m.phase === 'sitting_down';
      const wp = iso(m.pos.x + 0.5, m.pos.y + 0.5);
      const p = toScreen(wp.x, wp.y - (seated ? 70 : 86));
      const tag = { id: c.id, x: p.x, y: p.y, visible: !c.hidden && inside(p) };
      if (c.id === CEO_ID) ceoTag = tag; else tags.push(tag);
    }
    const rooms = OFFICE.rooms.map((r) => {
      // Room signs sit on the floor inside each room, like Gather's room labels.
      const w = iso(r.label.x, r.label.y, 0);
      const p = toScreen(w.x, w.y);
      return { id: r.id, x: p.x, y: p.y, visible: inside(p) };
    });
    const mw = iso(6, 0.2, WALL_OUTER_H + 16);
    const mp = toScreen(mw.x, mw.y);
    this.hooks.onFrame({ zoom: this.zoomLevel, width: cw, height: ch, tags, ceo: ceoTag, rooms, meeting: { ...mp, visible: inside(mp) }, near: this.near });
  }
}
