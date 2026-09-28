// Parts of the painted picture that stand in front of people walking behind them (glass walls, table
// tops, sofa backs…): each occluder polygon is cut out of the background and redrawn as thin vertical
// slices, every slice sorted by the occluder's floor line at that x. People whose feet are above the
// line (further back) are drawn under it; people in front of it walk over it. Glass keeps its dark frame
// opaque and lets the person show through the panes.
import * as Phaser from 'phaser';
import { LAYOUT, type LayoutOccluder } from '../logic/layout';
import type { Pt } from '../logic/iso';

const S = LAYOUT.image.scale;
const SLICE = 10;

function lineY(line: Pt[], x: number) {
  const pts = [...line].sort((a, b) => a.x - b.x);
  if (x <= pts[0].x) return pts[0].y;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]; const b = pts[i + 1];
    if (x <= b.x) return a.y + ((b.y - a.y) * (x - a.x)) / Math.max(1e-6, b.x - a.x);
  }
  return pts[pts.length - 1].y;
}

export class OccluderLayer {
  private images: Phaser.GameObjects.Image[] = [];

  constructor(private scene: Phaser.Scene) {}

  create(bgKey: string, list: LayoutOccluder[] = LAYOUT.occluders ?? []) {
    const src = this.scene.textures.get(bgKey).getSourceImage() as HTMLImageElement | HTMLCanvasElement;
    const k = src.width / (LAYOUT.image.width * S); // texture px per world px (1 for the 2x picture)
    for (const o of list) this.cut(o, src, k);
  }

  private cut(o: LayoutOccluder, src: HTMLImageElement | HTMLCanvasElement, k: number) {
    const poly = o.poly.map(([x, y]) => ({ x: x * S, y: y * S }));
    const base = o.base.map(([x, y]) => ({ x: x * S, y: y * S }));
    const x0 = Math.floor(Math.min(...poly.map((p) => p.x)));
    const x1 = Math.ceil(Math.max(...poly.map((p) => p.x)));
    const y0 = Math.floor(Math.min(...poly.map((p) => p.y)));
    const y1 = Math.ceil(Math.max(...poly.map((p) => p.y)));
    const w = Math.max(1, x1 - x0);
    const h = Math.max(1, y1 - y0);
    const key = `occ:${o.id}`;
    if (this.scene.textures.exists(key)) this.scene.textures.remove(key);
    const tex = this.scene.textures.createCanvas(key, w, h);
    if (!tex) return;
    const ctx = tex.getContext();
    ctx.save();
    ctx.beginPath();
    poly.forEach((p, i) => (i ? ctx.lineTo(p.x - x0, p.y - y0) : ctx.moveTo(p.x - x0, p.y - y0)));
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(src, x0 * k, y0 * k, w * k, h * k, 0, 0, w, h);
    ctx.restore();
    if (o.kind === 'glass') {
      // Panes see-through, frames solid: alpha from darkness.
      const d = ctx.getImageData(0, 0, w, h);
      const a = d.data;
      for (let i = 0; i < a.length; i += 4) {
        if (!a[i + 3]) continue;
        const lum = 0.3 * a[i] + 0.59 * a[i + 1] + 0.11 * a[i + 2];
        const f = lum < 60 ? 1 : lum < 95 ? 1 - ((lum - 60) / 35) * 0.72 : 0.28;
        a[i + 3] = Math.round(a[i + 3] * f);
      }
      ctx.putImageData(d, 0, 0);
    }
    tex.refresh();
    for (let cx = 0; cx < w; cx += SLICE) {
      const sw = Math.min(SLICE, w - cx);
      const img = this.scene.add.image(x0, y0, key).setOrigin(0, 0);
      img.setCrop(cx, 0, sw, h);
      img.setDepth(lineY(base, x0 + cx + sw / 2) - 0.5);
      this.images.push(img);
    }
  }

  destroy() { this.images.forEach((i) => i.destroy()); this.images = []; }
}
