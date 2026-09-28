// The CEO suite's live pieces:
//  - the RizeHub logo in 3D neon on the walnut wall: extruded letters (brand gradient "Rize", white "Hub",
//    teal dot), a neon tube frame whose light chases around it, flicker and a breathing glow that washes
//    the wall and floor (stronger at night).
//  - the floor-to-ceiling windows: sky and the city skyline by the time of day (lit windows and blinking
//    tower lights at night, a warm sky at golden hour).
import * as Phaser from 'phaser';
import { LAYOUT } from '../logic/layout';
import type { Pt } from '../logic/iso';

const S = LAYOUT.image.scale;
const RES = 2;

interface Surface { tex: Phaser.Textures.CanvasTexture; img: Phaser.GameObjects.Image; x0: number; y0: number; quads: Pt[][] }

function surface(scene: Phaser.Scene, key: string, quads: Pt[][], depth: number): Surface | null {
  const all = quads.flat();
  const x0 = Math.floor(Math.min(...all.map((p) => p.x))) - 6; const x1 = Math.ceil(Math.max(...all.map((p) => p.x))) + 6;
  const y0 = Math.floor(Math.min(...all.map((p) => p.y))) - 6; const y1 = Math.ceil(Math.max(...all.map((p) => p.y))) + 6;
  if (scene.textures.exists(key)) scene.textures.remove(key);
  const tex = scene.textures.createCanvas(key, (x1 - x0) * RES, (y1 - y0) * RES);
  if (!tex) return null;
  const img = scene.add.image(x0, y0, key).setOrigin(0, 0).setScale(1 / RES).setDepth(depth);
  return { tex, img, x0, y0, quads };
}

/** Map content (0..W, 0..H) onto a parallelogram quad (TL, TR, BR, BL) of a surface. */
function mapTo(ctx: CanvasRenderingContext2D, s: Surface, q: Pt[], W: number, H: number) {
  const [tl, tr, , bl] = q.map((p) => ({ x: (p.x - s.x0) * RES, y: (p.y - s.y0) * RES }));
  ctx.setTransform((tr.x - tl.x) / W, (tr.y - tl.y) / W, (bl.x - tl.x) / H, (bl.y - tl.y) / H, tl.x, tl.y);
}

const W1 = (xy: [number, number]): Pt => ({ x: xy[0] * S, y: xy[1] * S });

export class SuiteLayer {
  private neon: Surface | null = null;
  private neonGlow: Phaser.GameObjects.Image | null = null;
  private wash: Phaser.GameObjects.Image | null = null;
  private windows: Surface | null = null;
  private frame = 0;
  private flickerUntil = 0;
  private nextFlicker = 6;

  constructor(private scene: Phaser.Scene) {}

  create(nightDepth: number) {
    const n = LAYOUT.neon;
    if (n) {
      const q = n.quad.map((p) => W1(p as [number, number]));
      const baseY = Math.min(q[2].y, q[3].y) + 46 * S; // the wall's floor line under the logo
      this.neon = surface(this.scene, 'suite:neon', [q], baseY - 2);
      const c = { x: (q[0].x + q[2].x) / 2, y: (q[0].y + q[2].y) / 2 };
      // glow over the night tint (so the neon lights the dark office) and a wash on the floor below
      this.neonGlow = this.scene.add.image(c.x, c.y, 'glow').setScale(2.6, 1.6).setTint(0x7a5cff).setBlendMode(Phaser.BlendModes.ADD).setDepth(nightDepth + 2).setAlpha(0.2);
      this.wash = this.scene.add.image(c.x + 30 * S, c.y + 70 * S, 'glow').setScale(3.2, 1.4).setTint(0x4a6bff).setBlendMode(Phaser.BlendModes.ADD).setDepth(nightDepth + 1).setAlpha(0.12);
    }
    const w = LAYOUT.windows ?? [];
    if (w.length) {
      const quads = w.map((x) => x.quad.map((p) => W1(p as [number, number])));
      const baseY = Math.min(...quads.map((q) => Math.min(q[2].y, q[3].y))) + 12 * S;
      this.windows = surface(this.scene, 'suite:windows', quads, baseY - 3);
    }
  }

  update(dt: number, t: number, ambient: { color: number; alpha: number; lamps: number }) {
    this.frame++;
    const night = Math.min(1, Math.max(0, (ambient.alpha - 0.04) / 0.4));
    if (this.neon && this.frame % 2 === 0) this.drawNeon(this.neon, t);
    if (this.windows && this.frame % 6 === 0) this.drawWindows(this.windows, t, night, ambient.color);
    // flicker now and then like a real neon tube
    this.nextFlicker -= dt;
    if (this.nextFlicker <= 0) { this.flickerUntil = t + 0.35; this.nextFlicker = 7 + Math.random() * 12; }
    const flick = t < this.flickerUntil ? (Math.sin(t * 90) > 0 ? 0.55 : 1) : 1;
    const breathe = 0.85 + 0.15 * Math.sin(t * 1.6);
    this.neon?.img.setAlpha(flick);
    this.neonGlow?.setAlpha((0.12 + 0.38 * night) * breathe * flick).setTint(Math.sin(t * 0.5) > 0 ? 0x7a5cff : 0x3d8bff);
    this.wash?.setAlpha((0.05 + 0.2 * night) * breathe * flick);
  }

  private drawNeon(s: Surface, t: number) {
    const ctx = s.tex.getContext();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, s.tex.width, s.tex.height);
    const W = 300; const H = 118;
    mapTo(ctx, s, s.quads[0], W, H);
    // backing panel: smoked acrylic
    const r = 16;
    const rr = (x: number, y: number, w: number, h: number, rad: number) => {
      ctx.beginPath(); ctx.moveTo(x + rad, y); ctx.arcTo(x + w, y, x + w, y + h, rad); ctx.arcTo(x + w, y + h, x, y + h, rad);
      ctx.arcTo(x, y + h, x, y, rad); ctx.arcTo(x, y, x + w, y, rad); ctx.closePath();
    };
    rr(4, 4, W - 8, H - 8, r);
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, 'rgba(14,10,40,0.92)'); bg.addColorStop(1, 'rgba(8,16,40,0.92)');
    ctx.fillStyle = bg; ctx.fill();
    // neon tube frame with a light chasing around it
    const hue = (t * 40) % 360;
    ctx.lineWidth = 3.2;
    ctx.shadowBlur = 14; ctx.shadowColor = `hsl(${250 + 30 * Math.sin(t)}, 100%, 65%)`;
    const frame = ctx.createLinearGradient(0, 0, W, 0);
    frame.addColorStop(0, '#7b5cff'); frame.addColorStop(0.5, '#3d8bff'); frame.addColorStop(1, '#19c3b1');
    ctx.strokeStyle = frame; rr(9, 9, W - 18, H - 18, r - 4); ctx.stroke();
    // chasing highlight
    const per = 2 * (W - 18 + H - 18);
    const pos = ((t * 160) % per);
    ctx.setLineDash([40, per - 40]); ctx.lineDashOffset = -pos;
    ctx.strokeStyle = `hsla(${hue}, 100%, 88%, 0.95)`; ctx.lineWidth = 3.6; rr(9, 9, W - 18, H - 18, r - 4); ctx.stroke();
    ctx.setLineDash([]);
    // 3D letters: extrusion first, then the lit face
    ctx.font = '800 64px "Inter", ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'alphabetic';
    const rize = 'Rize'; const hub = 'Hub';
    const wr = ctx.measureText(rize).width; const wh = ctx.measureText(hub).width;
    const total = wr + wh + 26;
    const x0 = (W - total) / 2; const y0 = 82;
    ctx.shadowBlur = 0;
    for (let k = 7; k >= 1; k--) {
      ctx.fillStyle = `rgba(${24 + k * 3}, ${16 + k * 2}, ${70 + k * 6}, 1)`;
      ctx.fillText(rize, x0 + k * 0.9, y0 + k * 0.9);
      ctx.fillStyle = `rgba(${40 + k * 4}, ${44 + k * 4}, ${70 + k * 5}, 1)`;
      ctx.fillText(hub, x0 + wr + k * 0.9, y0 + k * 0.9);
    }
    // face: "Rize" in the brand gradient with a sweep of light, "Hub" white-hot
    const sweep = (t * 0.35) % 1.6 - 0.3;
    const gr = ctx.createLinearGradient(x0, 0, x0 + wr, 0);
    gr.addColorStop(0, '#8a6bff'); gr.addColorStop(Math.max(0, Math.min(1, sweep)), '#c9bcff'); gr.addColorStop(1, '#4f7dff');
    ctx.shadowBlur = 18; ctx.shadowColor = '#7b5cff';
    ctx.fillStyle = gr; ctx.fillText(rize, x0, y0);
    ctx.shadowColor = '#9ec2ff'; ctx.fillStyle = '#f5f7ff'; ctx.fillText(hub, x0 + wr, y0);
    // the teal dot, pulsing
    const pulse = 0.75 + 0.25 * Math.sin(t * 3);
    ctx.shadowBlur = 22 * pulse; ctx.shadowColor = '#19c3b1';
    ctx.fillStyle = '#1fc6b3';
    ctx.beginPath(); ctx.arc(x0 + wr + wh + 16, y0 - 17, 8.5, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    // glossy highlight on the letter tops
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(0, y0 - 52, W, 16);
    ctx.globalCompositeOperation = 'source-over';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    s.tex.refresh();
  }

  private drawWindows(s: Surface, t: number, night: number, amb: number) {
    const ctx = s.tex.getContext();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, s.tex.width, s.tex.height);
    const W = 100; const H = 120;
    const ar = (amb >> 16) & 255; const ag = (amb >> 8) & 255; const ab = amb & 255;
    const warm = ar > ab + 40 ? Math.min(1, (ar - ab) / 180) : 0; // golden hour / sunrise
    const mix = (a: number[], b: number[], k: number) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
    let top = mix([96, 168, 238], [10, 14, 44], night); let bot = mix([206, 232, 250], [36, 40, 86], night);
    top = mix(top, [120, 90, 170], warm * 0.6); bot = mix(bot, [255, 160, 96], warm);
    s.quads.forEach((q, pi) => {
      mapTo(ctx, s, q, W, H);
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, `rgb(${top})`); g.addColorStop(1, `rgb(${bot})`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      // Davao skyline across the panes (one continuous silhouette): towers with lit windows at night
      for (let b = 0; b < 7; b++) {
        const seed = pi * 7 + b;
        const rnd = (k: number) => ((Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453) % 1 + 1) % 1;
        const bw = 10 + rnd(1) * 16; const bx = b * 15 - 4 + rnd(2) * 6;
        const bh = 30 + rnd(3) * 62;
        const shade = mix([120, 140, 170], [14, 18, 38], night);
        ctx.fillStyle = `rgb(${shade})`;
        ctx.fillRect(bx, H - bh, bw, bh);
        if (night > 0.3) {
          for (let wy = H - bh + 4; wy < H - 4; wy += 6) for (let wx = bx + 2; wx < bx + bw - 3; wx += 4) {
            if (rnd(wx * 0.37 + wy * 1.3) < 0.42) {
              ctx.fillStyle = `rgba(255, ${210 + Math.round(rnd(wy) * 40)}, 140, ${0.55 * night})`;
              ctx.fillRect(wx, wy, 2, 2.4);
            }
          }
          if (rnd(9) > 0.6 && Math.sin(t * 2.5 + seed) > 0.2) { ctx.fillStyle = '#ff3b3b'; ctx.fillRect(bx + bw / 2 - 1, H - bh - 3, 2, 2); }
        }
      }
      // glass reflection
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(30, 0); ctx.lineTo(4, H); ctx.lineTo(-16, H); ctx.fill();
    });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    s.tex.refresh();
  }

  destroy() { this.neon?.img.destroy(); this.windows?.img.destroy(); this.neonGlow?.destroy(); this.wash?.destroy(); }
}
