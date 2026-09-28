// Procedural iso drawing helpers + texture baking (textures are generated once, then reused as Images).
import type Phaser from 'phaser';
import { TH, TW } from '../logic/iso';
import { shade } from './looks';

export type G = Phaser.GameObjects.Graphics;
export type Proj = (tx: number, ty: number, z: number) => { x: number; y: number };

export interface Baked { key: string; ox: number; oy: number; w: number; h: number }

const registry = new WeakMap<Phaser.Scene, Map<string, Baked>>();

/**
 * Bake a texture for an object with a footprint of w × h tiles and up to `maxH` pixels tall.
 * The draw callback receives a projector P(tx, ty, z) in footprint-local tile coordinates.
 * The texture's origin (ox, oy) is the footprint's back corner (0, 0) on the floor.
 */
export function bake(scene: Phaser.Scene, key: string, w: number, h: number, maxH: number, draw: (g: G, P: Proj) => void, below = 6): Baked {
  let reg = registry.get(scene);
  if (!reg) { reg = new Map(); registry.set(scene, reg); }
  const hit = reg.get(key);
  if (hit && scene.textures.exists(key)) return hit;
  const pad = 3;
  const texW = Math.ceil((w + h) * (TW / 2) + pad * 2);
  const texH = Math.ceil((w + h) * (TH / 2) + maxH + below + pad);
  const ox = h * (TW / 2) + pad;
  const oy = maxH + pad;
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  const P: Proj = (tx, ty, z) => ({ x: ox + (tx - ty) * (TW / 2), y: oy + (tx + ty) * (TH / 2) - z });
  draw(g, P);
  g.generateTexture(key, texW, texH);
  g.destroy();
  const b = { key, ox, oy, w: texW, h: texH };
  reg.set(key, b);
  return b;
}

/** Place a baked texture so its origin sits on world point (wx, wy). */
export function placeBaked(scene: Phaser.Scene, b: Baked, wx: number, wy: number, depth: number) {
  return scene.add.image(wx, wy, b.key).setOrigin(b.ox / b.w, b.oy / b.h).setDepth(depth);
}

export function poly(g: G, pts: { x: number; y: number }[], color: number, alpha = 1) {
  g.fillStyle(color, alpha);
  g.fillPoints(pts, true);
}

/** Axis-aligned iso box. Colours: top, south face (+y, lower-left), east face (+x, lower-right). */
export function box(
  g: G, P: Proj, x0: number, y0: number, x1: number, y1: number, z0: number, z1: number,
  top: number, south?: number, east?: number, alpha = 1,
) {
  const s = south ?? shade(top, 0.82);
  const e = east ?? shade(top, 0.68);
  poly(g, [P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1)], s, alpha);
  poly(g, [P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), P(x1, y0, z1)], e, alpha);
  poly(g, [P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)], top, alpha);
}

/** Flat quad on the floor or a plane at height z. */
export function floorQuad(g: G, P: Proj, x0: number, y0: number, x1: number, y1: number, z: number, color: number, alpha = 1) {
  poly(g, [P(x0, y0, z), P(x1, y0, z), P(x1, y1, z), P(x0, y1, z)], color, alpha);
}

/** Vertical quad on the plane y = const (spanning x0..x1, z0..z1). */
export function wallY(g: G, P: Proj, y: number, x0: number, x1: number, z0: number, z1: number, color: number, alpha = 1) {
  poly(g, [P(x0, y, z0), P(x1, y, z0), P(x1, y, z1), P(x0, y, z1)], color, alpha);
}

/** Vertical quad on the plane x = const (spanning y0..y1, z0..z1). */
export function wallX(g: G, P: Proj, x: number, y0: number, y1: number, z0: number, z1: number, color: number, alpha = 1) {
  poly(g, [P(x, y0, z0), P(x, y1, z0), P(x, y1, z1), P(x, y0, z1)], color, alpha);
}

/** Soft elliptical contact shadow on the floor. */
export function shadow(g: G, P: Proj, cx: number, cy: number, rx: number, ry: number, alpha = 0.16) {
  const c = P(cx, cy, 0);
  g.fillStyle(0x000000, alpha);
  g.fillEllipse(c.x, c.y, (rx + ry) * TW * 0.9, (rx + ry) * TH * 0.9);
}

/** Leafy plant in a pot centred at (cx, cy). */
export function plant(g: G, P: Proj, cx: number, cy: number, height: number, pot = 0xe9e3d8, seed = 1) {
  shadow(g, P, cx, cy, 0.28, 0.28, 0.2);
  box(g, P, cx - 0.2, cy - 0.2, cx + 0.2, cy + 0.2, 0, height * 0.28, shade(pot, 0.9), pot, shade(pot, 0.78));
  const base = P(cx, cy, height * 0.28);
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return (s % 1000) / 1000; };
  const greens = [0x3f7d4e, 0x4f9a5c, 0x2f6b43, 0x5fae68, 0x386f45];
  const n = Math.round(height / 5);
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2;
    const r = 3 + rnd() * height * 0.22;
    const up = height * 0.2 + rnd() * height * 0.62;
    g.fillStyle(greens[i % greens.length], 1);
    g.fillEllipse(base.x + Math.cos(a) * r, base.y - up + Math.sin(a) * r * 0.4, 7 + rnd() * 6, 5 + rnd() * 5);
  }
  g.fillStyle(0x7bc47f, 0.6);
  g.fillEllipse(base.x - 3, base.y - height * 0.72, 6, 4);
}

/** Radial glow texture (for monitor/lamp glows at night). */
export function makeGlow(scene: Phaser.Scene, key: string, size: number) {
  if (scene.textures.exists(key)) return;
  const tex = scene.textures.createCanvas(key, size, size);
  if (!tex) return;
  const ctx = tex.getContext();
  const grd = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, 'rgba(255,255,255,0.9)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, size, size);
  tex.refresh();
}
