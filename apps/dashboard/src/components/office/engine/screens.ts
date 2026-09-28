// Monitor screen textures (a mini "POV" per app, docs/07 §6), baked as skewed iso quads.
// Orientation 'up' = screen on the +y face (desk faces up); 'left' = screen on the +x face.
import type Phaser from 'phaser';
import type { ScreenApp } from '../logic/director';
import { TH, TW } from '../logic/iso';
import type { G } from './art';

export const SCREEN_LU = 0.9;  // screen width in tiles
export const SCREEN_HZ = 17;   // screen height in px
export type ScreenOrient = 'up' | 'left';

export const APP_GLOW: Record<ScreenApp, number> = {
  off: 0x000000, screensaver: 0x6d4aff, editor: 0x7aa2ff, browser: 0xdfe8ff, doc: 0xf2f2ff, sheet: 0xbff0cf,
  leads: 0xe8f1ff, review: 0x7ff0d0, timeline: 0xff7a9a, audio: 0x7ce7e0, design: 0xf0d8ff,
};

type UV = (u: number, v: number) => { x: number; y: number };

function quad(g: G, S: UV, u0: number, v0: number, u1: number, v1: number, color: number, alpha = 1) {
  g.fillStyle(color, alpha);
  g.fillPoints([S(u0, v0), S(u1, v0), S(u1, v1), S(u0, v1)], true);
}

function lines(g: G, S: UV, x0: number, y0: number, rows: number, gap: number, colors: number[], seed: number, maxW = 0.7) {
  let s = seed;
  for (let i = 0; i < rows; i++) {
    s = (s * 9301 + 49297) % 233280;
    const w = 0.15 + (s / 233280) * maxW;
    const indent = (i % 4 === 1 || i % 4 === 2) ? 0.06 : 0;
    quad(g, S, x0 + indent, y0 + i * gap, Math.min(0.97, x0 + indent + w), y0 + i * gap + gap * 0.5, colors[i % colors.length]);
  }
}

export function drawScreenContent(g: G, S: UV, app: ScreenApp, frame: number) {
  const f = frame;
  switch (app) {
    case 'off':
      quad(g, S, 0, 0, 1, 1, 0x15171c);
      quad(g, S, 0.55, 0, 0.75, 1, 0x23262e, 0.6);
      break;
    case 'screensaver':
      quad(g, S, 0, 0, 1, 1, 0x191544);
      quad(g, S, 0, 0.6, 1, 1, 0x241c5c);
      quad(g, S, 0.42 + f * 0.04, 0.28, 0.58 + f * 0.04, 0.72, 0x6d4aff);
      quad(g, S, 0.46 + f * 0.04, 0.38, 0.54 + f * 0.04, 0.62, 0xb9a8ff);
      break;
    case 'editor':
      quad(g, S, 0, 0, 1, 1, 0x1e1e2e);
      quad(g, S, 0, 0, 1, 0.12, 0x2a2b3d);
      quad(g, S, 0.03, 0.02, 0.28, 0.1, 0x3b3d56);
      quad(g, S, 0, 0.12, 0.08, 1, 0x252637);
      lines(g, S, 0.12, 0.17 - f * 0.04, 7, 0.115, [0x89b4fa, 0xf38ba8, 0xa6e3a1, 0xf9e2af, 0xcdd6f4, 0x94e2d5], 11 + f * 7);
      break;
    case 'browser':
      quad(g, S, 0, 0, 1, 1, 0xf7f7fb);
      quad(g, S, 0, 0, 1, 0.14, 0xdedfe6);
      quad(g, S, 0.15, 0.03, 0.8, 0.11, 0xffffff);
      quad(g, S, 0.06, 0.2, 0.94, 0.5 + f * 0.02, 0xd9c7f7);
      quad(g, S, 0.1, 0.27, 0.5, 0.33, 0x6d4aff);
      quad(g, S, 0.1, 0.38, 0.36, 0.44, 0x2f2b55);
      lines(g, S, 0.06, 0.58, 3, 0.12, [0xb6b8c8], 5 + f);
      quad(g, S, 0.62, 0.58, 0.94, 0.9, 0xf1d9c9);
      break;
    case 'doc':
      quad(g, S, 0, 0, 1, 1, 0xe9eaf1);
      quad(g, S, 0.15, 0.06, 0.85, 1, 0xffffff);
      quad(g, S, 0.2, 0.12, 0.62, 0.2, 0x2f2b55);
      lines(g, S, 0.2, 0.28, 6 + f, 0.11, [0x9a9cb3, 0xb3b5c8], 3 + f * 5, 0.5);
      break;
    case 'sheet':
      quad(g, S, 0, 0, 1, 1, 0xffffff);
      quad(g, S, 0, 0, 1, 0.14, 0x1f9d6b);
      for (let i = 1; i < 6; i++) quad(g, S, 0, 0.14 + i * 0.145, 1, 0.14 + i * 0.145 + 0.015, 0xd5dbe3);
      for (let j = 1; j < 4; j++) quad(g, S, j * 0.25, 0.14, j * 0.25 + 0.012, 1, 0xd5dbe3);
      quad(g, S, 0.27, 0.3 + f * 0.145, 0.49, 0.42 + f * 0.145, 0xc9f0dc);
      break;
    case 'leads':
      quad(g, S, 0, 0, 1, 1, 0xf6f7fb);
      quad(g, S, 0, 0, 1, 0.14, 0x2f2b55);
      for (let i = 0; i < 5 + f; i++) {
        const y = 0.2 + i * 0.15;
        if (y > 0.92) break;
        quad(g, S, 0.05, y, 0.5, y + 0.07, 0x9a9cb3);
        quad(g, S, 0.62, y, 0.78, y + 0.07, [0x1f9d6b, 0xf5a524, 0x1f9d6b, 0xe5484d, 0x1f9d6b, 0x3ba7ff][i % 6]);
      }
      break;
    case 'review':
      quad(g, S, 0, 0, 1, 1, 0x14212b);
      quad(g, S, 0, 0, 1, 0.14, 0x14b8a6);
      for (let i = 0; i < 5; i++) {
        const y = 0.22 + i * 0.15;
        const pass = i !== 2 || f === 1;
        quad(g, S, 0.06, y, 0.14, y + 0.09, i <= 2 + f ? (pass ? 0x1f9d6b : 0xe5484d) : 0x3b4b58);
        quad(g, S, 0.2, y + 0.01, 0.2 + 0.3 + ((i * 37) % 30) / 100, y + 0.07, 0x9fb3c0);
      }
      break;
    case 'timeline':
      quad(g, S, 0, 0, 1, 1, 0x17151f);
      quad(g, S, 0.18, 0.05, 0.82, 0.5, 0x2a3f5c);
      quad(g, S, 0.2, 0.3, 0.8, 0.48, 0xd98e5f);
      quad(g, S, 0.4, 0.12, 0.6, 0.3, 0xf1c27d);
      quad(g, S, 0.04, 0.58, 0.44, 0.68, 0xe11d48);
      quad(g, S, 0.46, 0.58, 0.9, 0.68, 0xfb7185);
      quad(g, S, 0.04, 0.72, 0.7, 0.8, 0x7c3aed);
      quad(g, S, 0.04, 0.84, 0.96, 0.92, 0x14b8a6);
      quad(g, S, 0.3 + f * 0.12, 0.54, 0.32 + f * 0.12, 0.96, 0xffffff);
      break;
    case 'audio':
      quad(g, S, 0, 0, 1, 1, 0x101820);
      for (let i = 0; i < 22; i++) {
        const h = 0.08 + Math.abs(Math.sin(i * 1.7 + f * 1.3)) * 0.34;
        quad(g, S, 0.04 + i * 0.042, 0.5 - h, 0.07 + i * 0.042, 0.5 + h, i < 12 + f * 3 ? 0x2dd4bf : 0x3b5b66);
      }
      quad(g, S, 0.04, 0.88, 0.96, 0.92, 0x7c3aed);
      break;
    case 'design':
      quad(g, S, 0, 0, 1, 1, 0x2c2c33);
      quad(g, S, 0, 0, 0.14, 1, 0x3a3a43);
      quad(g, S, 0.86, 0, 1, 1, 0x3a3a43);
      quad(g, S, 0.2, 0.12, 0.8, 0.9, 0xfafafa);
      quad(g, S, 0.26, 0.2, 0.74, 0.46, [0xa259ff, 0xf97316][f % 2]);
      quad(g, S, 0.26, 0.52, 0.5, 0.58, 0x2f2b55);
      quad(g, S, 0.26, 0.64, 0.6, 0.68, 0xb6b8c8);
      quad(g, S, 0.26, 0.74, 0.42, 0.82, 0x1abcfe);
      break;
  }
}

export interface ScreenTex { key: string; ox: number; oy: number; w: number; h: number }

/** Bake (once) the texture for an app in an orientation. Origin = the screen's bottom corner at u = 0 ('up') or u = 1 ('left'). */
export function screenTexture(scene: Phaser.Scene, orient: ScreenOrient, app: ScreenApp, frame: number, lu = SCREEN_LU, hz = SCREEN_HZ): ScreenTex {
  const key = `scr-${orient}-${app}-${frame}-${lu}-${hz}`;
  const w = Math.ceil(lu * (TW / 2)) + 4;
  const h = Math.ceil(lu * (TH / 2) + hz) + 4;
  const ox = orient === 'up' ? 2 : w - 2;
  const oy = hz + 2;
  if (!scene.textures.exists(key)) {
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    const S: UV = orient === 'up'
      ? (u, v) => ({ x: ox + u * lu * (TW / 2), y: oy + u * lu * (TH / 2) - (1 - v) * hz })
      : (u, v) => ({ x: ox - (1 - u) * lu * (TW / 2), y: oy + (1 - u) * lu * (TH / 2) - (1 - v) * hz });
    drawScreenContent(g, S, app, frame);
    // glass sheen
    g.fillStyle(0xffffff, app === 'off' ? 0.05 : 0.07);
    g.fillPoints([S(0, 0), S(0.35, 0), S(0.15, 1), S(0, 1)], true);
    g.generateTexture(key, w, h);
    g.destroy();
  }
  return { key, ox, oy, w, h };
}
