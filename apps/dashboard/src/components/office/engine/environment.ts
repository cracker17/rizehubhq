// Floor slab, glass partitions, outer window walls and the city skyline backdrop.
import type Phaser from 'phaser';
import { OFFICE, roomAt, type Floor, type OfficeMap } from '../logic/map';
import { TH, TW, isoToWorld, type Pt } from '../logic/iso';
import { bake, box, floorQuad, poly, wallX, wallY, type Baked, type G, type Proj } from './art';
import { shade } from './looks';

export const WALL_GLASS_H = 40;
export const WALL_OUTER_H = 118;
export const SLAB = 20;

const FLOOR: Record<Floor, { base: number; alt: number; kind: 'planks' | 'tiles' | 'solid' | 'dots' }> = {
  oak: { base: 0xd9b88f, alt: 0xcfab80, kind: 'planks' },
  oak_dark: { base: 0xb88a60, alt: 0xa97c54, kind: 'planks' },
  concrete: { base: 0xc4c0b9, alt: 0xbab5ad, kind: 'tiles' },
  concrete_dark: { base: 0x8e8b86, alt: 0x86837e, kind: 'tiles' },
  carpet_blue: { base: 0x6f7f96, alt: 0x6a7a90, kind: 'solid' },
  carpet_warm: { base: 0xb5a58f, alt: 0xae9e88, kind: 'solid' },
  epoxy: { base: 0xe3e6e8, alt: 0xdadee1, kind: 'tiles' },
  marble: { base: 0xefe9df, alt: 0xe3dccf, kind: 'tiles' },
  rubber: { base: 0x5f7f78, alt: 0x587770, kind: 'dots' },
};

function rand(seed: number) { let s = seed % 2147483647; if (s <= 0) s += 2147483646; return () => (s = (s * 16807) % 2147483647) / 2147483647; }

function drawFloor(g: G, P: Proj, m: OfficeMap) {
  const r = rand(7);
  // slab edges (cut-away front of the building)
  poly(g, [P(0, m.rows, 0), P(m.cols, m.rows, 0), P(m.cols, m.rows, -SLAB), P(0, m.rows, -SLAB)], 0x6a655e);
  poly(g, [P(m.cols, 0, 0), P(m.cols, m.rows, 0), P(m.cols, m.rows, -SLAB), P(m.cols, 0, -SLAB)], 0x55514b);
  poly(g, [P(0, m.rows, -SLAB + 3), P(m.cols, m.rows, -SLAB + 3), P(m.cols, m.rows, -SLAB), P(0, m.rows, -SLAB)], 0x4a4641);
  for (let x = 0; x < m.cols; x++) {
    for (let y = 0; y < m.rows; y++) {
      const room = roomAt(m, x, y);
      const f = FLOOR[room?.floor ?? 'concrete'];
      const jitter = 0.97 + r() * 0.06;
      switch (f.kind) {
        case 'planks': {
          for (let k = 0; k < 4; k++) {
            const c = shade(k % 2 ? f.base : f.alt, 0.96 + r() * 0.08);
            floorQuad(g, P, x, y + k * 0.25, x + 1, y + (k + 1) * 0.25, 0, c);
          }
          g.lineStyle(0.6, shade(f.base, 0.8), 0.5);
          const off = (x * 7 + y * 3) % 4;
          const a = P(x + off * 0.25, y, 0); const b = P(x + off * 0.25, y + 0.25, 0);
          g.lineBetween(a.x, a.y, b.x, b.y);
          break;
        }
        case 'tiles': {
          floorQuad(g, P, x, y, x + 1, y + 1, 0, shade((x + y) % 2 ? f.base : f.alt, jitter));
          if ((x % 2 === 0) || (y % 2 === 0)) {
            g.lineStyle(0.6, shade(f.base, 0.85), 0.35);
            if (x % 2 === 0) { const a = P(x, y, 0); const b = P(x, y + 1, 0); g.lineBetween(a.x, a.y, b.x, b.y); }
            if (y % 2 === 0) { const a = P(x, y, 0); const b = P(x + 1, y, 0); g.lineBetween(a.x, a.y, b.x, b.y); }
          }
          if (room?.floor === 'marble' && r() < 0.35) {
            const a = P(x + r(), y + r(), 0); const b = P(x + r(), y + r(), 0);
            g.lineStyle(0.6, 0xc9c0b0, 0.5); g.lineBetween(a.x, a.y, b.x, b.y);
          }
          break;
        }
        case 'dots': {
          floorQuad(g, P, x, y, x + 1, y + 1, 0, shade(f.base, jitter));
          const c = P(x + 0.5, y + 0.5, 0);
          g.fillStyle(shade(f.base, 0.85), 0.6); g.fillEllipse(c.x, c.y, 6, 3);
          break;
        }
        default:
          floorQuad(g, P, x, y, x + 1, y + 1, 0, shade(f.base, 0.985 + r() * 0.03));
      }
    }
  }
  // soft daylight pools under the windows (outer walls are x = 0 and y = 0)
  for (let x = 1; x < m.cols; x += 2) floorQuad(g, P, x, 0, x + 1.3, 2.4, 0.1, 0xfff3d6, 0.12);
  for (let y = 1; y < m.rows; y += 2) floorQuad(g, P, 0, y, 2.4, y + 1.3, 0.1, 0xfff3d6, 0.12);
}

export function bakeFloor(scene: Phaser.Scene, m: OfficeMap = OFFICE): Baked {
  return bake(scene, 'office-floor', m.cols, m.rows, 2, (g, P) => drawFloor(g, P, m), SLAB + 6);
}

// ---------------------------------------------------------------- walls
function glass(g: G, P: Proj, dir: 'h' | 'v') {
  const plane = dir === 'h' ? (z0: number, z1: number, c: number, a = 1, u0 = 0, u1 = 1) => wallY(g, P, 0, u0, u1, z0, z1, c, a)
    : (z0: number, z1: number, c: number, a = 1, u0 = 0, u1 = 1) => wallX(g, P, 0, u0, u1, z0, z1, c, a);
  plane(0, 3, 0x6d7178);
  plane(3, WALL_GLASS_H - 2, 0xcde7f3, 0.3);
  // reflection streak
  const pt = (u: number, z: number) => (dir === 'h' ? P(u, 0, z) : P(0, u, z));
  poly(g, [pt(0.15, 6), pt(0.32, 6), pt(0.55, WALL_GLASS_H - 4), pt(0.38, WALL_GLASS_H - 4)], 0xffffff, 0.22);
  plane(WALL_GLASS_H - 2, WALL_GLASS_H, 0xd9dde2);
  if (dir === 'h') { floorQuad(g, P, 0, -0.03, 1, 0.03, WALL_GLASS_H, 0xf3f4f6); box(g, P, -0.03, -0.03, 0.03, 0.03, 0, WALL_GLASS_H, 0xaeb4bc); }
  else { floorQuad(g, P, -0.03, 0, 0.03, 1, WALL_GLASS_H, 0xf3f4f6); box(g, P, -0.03, -0.03, 0.03, 0.03, 0, WALL_GLASS_H, 0xaeb4bc); }
}

function outer(g: G, P: Proj, dir: 'h' | 'v') {
  const plane = (z0: number, z1: number, c: number, a = 1) => (dir === 'h' ? wallY(g, P, 0, 0, 1, z0, z1, c, a) : wallX(g, P, 0, 0, 1, z0, z1, c, a));
  plane(0, 7, 0xe6e0d5);
  plane(7, 10, 0xcfc8bb);
  plane(10, WALL_OUTER_H - 10, 0xb9dcef, 0.14);
  plane(72, 74, 0x3a3e46, 0.9);
  plane(WALL_OUTER_H - 10, WALL_OUTER_H, 0xf0ebe2);
  if (dir === 'h') {
    floorQuad(g, P, 0, -0.14, 1, 0, WALL_OUTER_H, 0xf8f5ef);
    box(g, P, -0.03, -0.06, 0.03, 0, 10, WALL_OUTER_H - 10, 0x3a3e46);
  } else {
    floorQuad(g, P, -0.14, 0, 0, 1, WALL_OUTER_H, 0xf8f5ef);
    box(g, P, -0.06, -0.03, 0, 0.03, 10, WALL_OUTER_H - 10, 0x3a3e46);
  }
}

export function bakeWalls(scene: Phaser.Scene) {
  return {
    hGlass: bake(scene, 'wall-h-glass', 1, 1, WALL_GLASS_H + 2, (g, P) => glass(g, P, 'h')),
    vGlass: bake(scene, 'wall-v-glass', 1, 1, WALL_GLASS_H + 2, (g, P) => glass(g, P, 'v')),
    hOuter: bake(scene, 'wall-h-outer', 1, 1, WALL_OUTER_H + 4, (g, P) => outer(g, P, 'h')),
    vOuter: bake(scene, 'wall-v-outer', 1, 1, WALL_OUTER_H + 4, (g, P) => outer(g, P, 'v')),
  };
}

// ---------------------------------------------------------------- skyline backdrop (half resolution)
export function bakeBackdrop(scene: Phaser.Scene, origin: Pt, night: boolean, m: OfficeMap = OFFICE) {
  const key = night ? 'backdrop-night' : 'backdrop-day';
  const L = isoToWorld(0, m.rows, 0, origin);
  const T = isoToWorld(0, 0, 0, origin);
  const R = isoToWorld(m.cols, 0, 0, origin);
  const minX = L.x - 20;
  const maxX = R.x + 20;
  const top = T.y - WALL_OUTER_H - 380;
  const bottom = Math.max(L.y, R.y) + 20;
  const S = 0.5;
  const info = { key, x: minX, y: top, scale: 1 / S };
  if (scene.textures.exists(key)) return info;
  const W = Math.ceil((maxX - minX) * S);
  const H = Math.ceil((bottom - top) * S);
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  const X = (x: number) => (x - minX) * S;
  const Y = (y: number) => (y - top) * S;
  const lineY = (x: number) => T.y + Math.abs(x - T.x) * (TH / TW);
  const skyTop = night ? 0x0b1233 : 0x8fc0e6;
  const skyLow = night ? 0x2d2b63 : 0xf6e3c8;
  const mix = (a: number, b: number, k: number) => {
    const c = (s: number) => Math.round(((a >> s) & 255) + ((((b >> s) & 255) - ((a >> s) & 255)) * k));
    return (c(16) << 16) | (c(8) << 8) | c(0);
  };
  const step = 6;
  for (let y = top; y < bottom; y += step) {
    const k = Math.max(0, Math.min(1, (y - top) / (T.y - top)));
    g.fillStyle(mix(skyTop, skyLow, k), 1);
    // visible where y is above the back-wall lines
    if (y < T.y) g.fillRect(X(minX), Y(y), W, step * S + 1);
    else {
      const dx = (y - T.y) * (TW / TH);
      if (T.x - dx > minX) g.fillRect(X(minX), Y(y), X(T.x - dx) - X(minX), step * S + 1);
      if (T.x + dx < maxX) g.fillRect(X(T.x + dx), Y(y), X(maxX) - X(T.x + dx), step * S + 1);
    }
  }
  if (night) {
    const rs = rand(3);
    for (let i = 0; i < 90; i++) { g.fillStyle(0xffffff, 0.3 + rs() * 0.6); g.fillCircle(X(minX + rs() * (maxX - minX)), Y(top + rs() * 260), 0.6 + rs() * 0.7); }
    g.fillStyle(0xfff4d8, 1); g.fillCircle(X(T.x + 620), Y(top + 90), 16);
    g.fillStyle(0xfff4d8, 0.15); g.fillCircle(X(T.x + 620), Y(top + 90), 34);
  } else {
    const rs = rand(5);
    for (let i = 0; i < 9; i++) {
      const cx = X(minX + rs() * (maxX - minX));
      const cy = Y(top + 40 + rs() * 160);
      g.fillStyle(0xffffff, 0.5);
      g.fillEllipse(cx, cy, 70 + rs() * 60, 14 + rs() * 8);
      g.fillEllipse(cx + 20, cy - 6, 40, 12);
    }
  }
  // two layers of buildings rising behind the window walls
  const layers = night
    ? [{ c: 0x232a52, hMin: 230, hMax: 420, win: 0.18 }, { c: 0x161c3c, hMin: 150, hMax: 330, win: 0.32 }]
    : [{ c: 0xbccad8, hMin: 230, hMax: 420, win: 0 }, { c: 0x93a8be, hMin: 150, hMax: 330, win: 0 }];
  layers.forEach((layer, li) => {
    const rs = rand(11 + li * 17);
    let x = minX;
    while (x < maxX) {
      const bw = 50 + rs() * 90;
      const bh = layer.hMin + rs() * (layer.hMax - layer.hMin);
      const base = lineY(Math.min(maxX, Math.max(minX, x + bw / 2))) + 30;
      const ytop = base - bh;
      const col = shade(layer.c, 0.94 + rs() * 0.12);
      g.fillStyle(col, 1);
      g.fillRect(X(x), Y(ytop), bw * S, (base - ytop) * S);
      g.fillStyle(shade(col, night ? 1.2 : 1.08), 1);
      g.fillRect(X(x), Y(ytop), bw * S * 0.18, (base - ytop) * S);
      if (rs() < 0.3) { g.fillStyle(col, 1); g.fillRect(X(x + bw * 0.4), Y(ytop - 24), bw * S * 0.12, 24 * S); }
      // windows
      for (let wy = ytop + 10; wy < base - 8; wy += 12) {
        for (let wx = x + 8; wx < x + bw - 8; wx += 10) {
          if (night) {
            if (rs() < layer.win) { g.fillStyle(rs() < 0.8 ? 0xffd98a : 0x9fd8ff, 0.85); g.fillRect(X(wx), Y(wy), 3, 3.5); }
          } else if (rs() < 0.5) { g.fillStyle(0xe8f1f8, 0.35); g.fillRect(X(wx), Y(wy), 3, 3.5); }
        }
      }
      x += bw + 4 + rs() * 16;
    }
  });
  g.generateTexture(key, W, H);
  g.destroy();
  return info;
}
