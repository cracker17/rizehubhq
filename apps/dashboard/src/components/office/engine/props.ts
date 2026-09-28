// Living props: the things in the picture that should never look frozen.
//   - fireplace: flames licking and flickering (additive, on top of the painted fire), rising embers
//   - water dispenser: bubbles glugging up the bottle, the water line wobbling
//   - espresso machine: steam; brewing (drip into a cup, puffs, a glowing button) when someone takes a coffee
//   - arcade cabinet: an attract-mode game on its screen, the real game when someone stands at it
//   - plants: leaves sway in the draft when someone walks past, and breathe a little in the air-con
// Positions are 1x picture px (layout.json space).
import * as Phaser from 'phaser';
import { LAYOUT, PROJ } from '../logic/layout';
import type { Motion } from '../logic/motion';
import type { Pt } from '../logic/iso';

const S = LAYOUT.image.scale;
const w = (x: number, y: number): Pt => ({ x: x * S, y: y * S });

// quads: TL, TR, BR, BL
/** Box around the fireplace opening (1x px). */
const FIRE_BOX = [756, 484, 818, 550];
const ARCADE: [number, number][] = [[1116, 548], [1136, 556], [1135, 575], [1117, 566]];
const WATER = { cx: 465, top: 498, bottom: 530, rx: 11 };
const ESPRESSO = { steam: [551, 434] as [number, number], spout: [566, 447] as [number, number], cup: [566, 461] as [number, number], button: [556, 441] as [number, number] };

/** Plants cut out of the picture: leaf box, pivot (top of the pot) and floor y. */
const PLANTS: { box: [number, number, number, number]; pivot: [number, number]; base: number }[] = [
  { box: [685, 425, 748, 510], pivot: [717, 508], base: 535 },
  { box: [222, 438, 302, 510], pivot: [262, 508], base: 532 },
  { box: [450, 600, 485, 630], pivot: [465, 628], base: 645 },
  { box: [805, 555, 865, 624], pivot: [835, 622], base: 645 },
  { box: [1085, 145, 1142, 204], pivot: [1112, 202], base: 228 },
  { box: [530, 88, 595, 124], pivot: [556, 122], base: 142 },
];

interface Plant { img: Phaser.GameObjects.Image; tile: Pt; amp: number; vel: number; ang: number; phase: number }
interface QuadCanvas { tex: Phaser.Textures.CanvasTexture; img: Phaser.GameObjects.Image; x0: number; y0: number; q: Pt[] }

export interface PropUser { id: string; motion: Motion; hidden: boolean }

const RES = 3;

export class PropLayer {
  private g!: Phaser.GameObjects.Graphics;
  private fireAnim: { tex: Phaser.Textures.CanvasTexture; img: Phaser.GameObjects.Image; flames: HTMLCanvasElement; base: HTMLCanvasElement; w: number; h: number } | null = null;
  private arcade: QuadCanvas | null = null;
  private plants: Plant[] = [];
  private coffeeSince = new Map<string, number>();
  private brewUntil = 0;
  private embers: { x: number; y: number; vy: number; life: number }[] = [];
  private bubbles: { y: number; x: number; r: number }[] = [];
  private nextGlug = 3;
  private frame = 0;

  constructor(private scene: Phaser.Scene) {}

  create(bgKey: string) {
    this.g = this.scene.add.graphics().setDepth(WATER.bottom * S - 0.2);
    this.setupFire(bgKey);
    this.arcade = this.quadCanvas('prop:arcade', ARCADE, 612 * S - 2);
    this.arcade?.img.setBlendMode(Phaser.BlendModes.SCREEN);
    this.cutPlants(bgKey);
  }

  private quadCanvas(key: string, quad: [number, number][], depth: number): QuadCanvas | null {
    const q = quad.map(([x, y]) => w(x, y));
    const x0 = Math.floor(Math.min(...q.map((p) => p.x))); const x1 = Math.ceil(Math.max(...q.map((p) => p.x)));
    const y0 = Math.floor(Math.min(...q.map((p) => p.y))); const y1 = Math.ceil(Math.max(...q.map((p) => p.y)));
    if (this.scene.textures.exists(key)) this.scene.textures.remove(key);
    const tex = this.scene.textures.createCanvas(key, (x1 - x0) * RES, (y1 - y0) * RES);
    if (!tex) return null;
    const img = this.scene.add.image(x0, y0, key).setOrigin(0, 0).setScale(1 / RES).setDepth(depth);
    return { tex, img, x0, y0, q };
  }

  /** Leaves only (green pixels), so the pot stays put while the plant moves. */
  private cutPlants(bgKey: string) {
    const src = this.scene.textures.get(bgKey).getSourceImage() as HTMLImageElement;
    const k = src.width / (LAYOUT.image.width * S);
    PLANTS.forEach((p, i) => {
      const [bx0, by0, bx1, by1] = p.box.map((v) => v * S);
      const cw = bx1 - bx0; const ch = by1 - by0;
      const key = `prop:plant:${i}`;
      if (this.scene.textures.exists(key)) this.scene.textures.remove(key);
      const tex = this.scene.textures.createCanvas(key, cw, ch);
      if (!tex) return;
      const ctx = tex.getContext();
      ctx.drawImage(src, bx0 * k, by0 * k, cw * k, ch * k, 0, 0, cw, ch);
      const d = ctx.getImageData(0, 0, cw, ch);
      const a = d.data;
      for (let j = 0; j < a.length; j += 4) {
        const r = a[j]; const gg = a[j + 1]; const b = a[j + 2];
        const mx = Math.max(r, gg, b); const mn = Math.min(r, gg, b);
        const green = gg >= r * 0.95 && gg > b * 1.05 && mx - mn > 18;
        const dark = mx < 60 && gg >= r; // leaf shadows / outlines
        a[j + 3] = green ? 255 : dark ? 200 : 0;
      }
      ctx.putImageData(d, 0, 0);
      tex.refresh();
      const pv = w(p.pivot[0], p.pivot[1]);
      const img = this.scene.add.image(pv.x, pv.y, key).setOrigin((pv.x - bx0) / cw, (pv.y - by0) / ch).setDepth(p.base * S - 0.5);
      this.plants.push({ img, tile: PROJ.toTile(p.pivot[0], p.base), amp: 0, vel: 0, ang: 0, phase: i * 1.7 });
    });
  }

  update(dt: number, t: number, users: PropUser[], lamps: number) {
    this.frame++;
    // --- plants: a gust when someone walks by (damped spring), a slow breeze otherwise
    for (const p of this.plants) {
      for (const u of users) {
        if (u.hidden || u.motion.phase !== 'walking') continue;
        const d = Math.hypot(u.motion.pos.x - p.tile.x, u.motion.pos.y - p.tile.y);
        if (d < 1.3) p.vel += (1.3 - d) * dt * (u.motion.pos.x < p.tile.x ? -0.9 : 0.9);
      }
      p.vel += (-p.ang * 38 - p.vel * 3.2) * dt;
      p.ang += p.vel * dt;
      p.ang = Math.max(-0.09, Math.min(0.09, p.ang));
      const breeze = Math.sin(t * 0.9 + p.phase) * 0.008 + Math.sin(t * 2.3 + p.phase) * 0.003;
      p.img.setRotation(p.ang + breeze);
      p.img.setScale(1, 1 + Math.sin(t * 1.3 + p.phase) * 0.006);
    }

    // --- who is at the coffee machine (a fresh arrival starts a brew)
    for (const u of users) {
      const at = u.motion.at?.startsWith('spot:coffee') && u.motion.loop === 'coffee';
      if (at && !this.coffeeSince.has(u.id)) { this.coffeeSince.set(u.id, t); this.brewUntil = Math.max(this.brewUntil, t + 7); }
      if (!at) this.coffeeSince.delete(u.id);
    }
    const arcadePlayer = users.some((u) => u.motion.at === 'spot:arcade-1');

    const g = this.g;
    g.clear();
    this.drawWater(g, dt, t);
    this.drawCoffee(g, t);
    if (this.frame % 2 === 0) this.drawFire(t, dt * 2, lamps);
    if (this.arcade && this.frame % 3 === 0) this.drawArcade(this.arcade, t, arcadePlayer);
  }

  private drawWater(g: Phaser.GameObjects.Graphics, dt: number, t: number) {
    const { cx, top, bottom, rx } = WATER;
    this.nextGlug -= dt;
    if (this.nextGlug <= 0) {
      this.nextGlug = 5 + Math.random() * 7;
      for (let i = 0; i < 5 + Math.floor(Math.random() * 4); i++) this.bubbles.push({ y: bottom - 2 - i * 2.5, x: cx + (Math.random() - 0.5) * 6, r: 0.8 + Math.random() * 1.6 });
    }
    if (Math.random() < dt * 0.6) this.bubbles.push({ y: bottom - 2, x: cx + (Math.random() - 0.5) * 14, r: 0.5 + Math.random() * 0.7 });
    this.bubbles = this.bubbles.filter((b) => b.y > top + 4);
    for (const b of this.bubbles) {
      b.y -= dt * (14 + b.r * 6);
      b.x += Math.sin(t * 6 + b.y) * dt * 3;
      const p = w(b.x, b.y);
      g.fillStyle(0xe8f6ff, 0.75); g.fillCircle(p.x, p.y, b.r * S);
      g.lineStyle(0.6 * S, 0x6fa8d6, 0.6); g.strokeCircle(p.x, p.y, b.r * S);
    }
    // water line wobble + highlight
    const ly = top + 5 + Math.sin(t * 2.1) * 0.6;
    const a = w(cx - rx * 0.8, ly); const b = w(cx + rx * 0.8, ly + Math.sin(t * 3.1) * 0.5);
    g.lineStyle(1.2 * S, 0xffffff, 0.35); g.lineBetween(a.x, a.y, b.x, b.y);
    const s0 = w(cx - rx * 0.55, top + 8); const s1 = w(cx - rx * 0.55, bottom - 4);
    g.lineStyle(1.6 * S, 0xffffff, 0.12 + Math.sin(t * 1.4) * 0.05); g.lineBetween(s0.x, s0.y, s1.x, s1.y);
  }

  private drawCoffee(g: Phaser.GameObjects.Graphics, t: number) {
    const brewing = t < this.brewUntil;
    // steam from the machine top (thicker while brewing)
    const s = w(...ESPRESSO.steam);
    const n = brewing ? 6 : 3;
    for (let i = 0; i < n; i++) {
      const k = (t * (brewing ? 0.7 : 0.45) + i / n) % 1;
      g.fillStyle(0xffffff, (brewing ? 0.55 : 0.34) * (1 - k));
      g.fillCircle(s.x + Math.sin(t * 2 + i * 2) * 3 * S + k * 4 * S, s.y - k * (brewing ? 32 : 24) * S, (2.5 + k * (brewing ? 7 : 5)) * S);
    }
    if (!brewing) return;
    const left = this.brewUntil - t;
    // cup
    const c = w(...ESPRESSO.cup);
    g.fillStyle(0xf4efe6, 1); g.fillRoundedRect(c.x - 4 * S, c.y - 5 * S, 8 * S, 6 * S, 1.5 * S);
    g.fillStyle(0x3b2416, 1); g.fillEllipse(c.x, c.y - 4.6 * S, 6.4 * S, 1.8 * S);
    g.lineStyle(1 * S, 0xc9c1b3, 1); g.strokeRoundedRect(c.x - 4 * S, c.y - 5 * S, 8 * S, 6 * S, 1.5 * S);
    // espresso stream (stops a second before the brew ends)
    const sp = w(...ESPRESSO.spout);
    if (left > 1.2) {
      g.lineStyle(1.1 * S, 0x4a2a14, 0.95);
      const wob = Math.sin(t * 20) * 0.3 * S;
      g.lineBetween(sp.x + wob, sp.y, sp.x, c.y - 5 * S);
      g.fillStyle(0xc28a4e, 0.9); g.fillCircle(sp.x, c.y - 5 * S, 1 * S); // crema splash
    }
    // brew button glow
    const bt = w(...ESPRESSO.button);
    g.fillStyle(0x7dff9b, 0.6 + Math.sin(t * 8) * 0.3); g.fillCircle(bt.x, bt.y, 1.6 * S);
    g.fillStyle(0x7dff9b, 0.15); g.fillCircle(bt.x, bt.y, 4 * S);
  }

  private mapQuad(ctx: CanvasRenderingContext2D, qc: QuadCanvas, W: number, H: number) {
    const [tl, tr, , bl] = qc.q.map((p) => ({ x: (p.x - qc.x0) * RES, y: (p.y - qc.y0) * RES }));
    ctx.setTransform((tr.x - tl.x) / W, (tr.y - tl.y) / W, (bl.x - tl.x) / H, (bl.y - tl.y) / H, tl.x, tl.y);
  }

  /** The painted fire, animated: its flame pixels sway and lick upwards (per-row wobble, per-column lift),
   *  flicker in brightness and throw sparks; the opening behind them is a dark ember bed. */
  private setupFire(bgKey: string) {
    const src = this.scene.textures.get(bgKey).getSourceImage() as HTMLImageElement;
    const k = src.width / (LAYOUT.image.width * S);
    const [x0, y0, x1, y1] = FIRE_BOX.map((v) => v * S);
    const w = x1 - x0; const h = y1 - y0;
    const flames = document.createElement('canvas'); flames.width = w; flames.height = h;
    const base = document.createElement('canvas'); base.width = w; base.height = h;
    const fc = flames.getContext('2d')!; const bc = base.getContext('2d')!;
    fc.drawImage(src, x0 * k, y0 * k, w * k, h * k, 0, 0, w, h);
    bc.drawImage(src, x0 * k, y0 * k, w * k, h * k, 0, 0, w, h);
    const fd = fc.getImageData(0, 0, w, h); const bd = bc.getImageData(0, 0, w, h);
    for (let i = 0; i < fd.data.length; i += 4) {
      const r = fd.data[i]; const g = fd.data[i + 1]; const b = fd.data[i + 2];
      const flame = r > 150 && r - b > 70 && g > 70;
      const soft = Math.max(0, Math.min(1, (r - 140) / 60)) * (r - b > 60 ? 1 : 0);
      fd.data[i + 3] = Math.round(255 * (flame ? 1 : soft));
      if (flame || soft > 0.2) { // behind the flames: glowing embers, dark at the top
        const y = Math.floor(i / 4 / w) / h;
        bd.data[i] = Math.round(70 + 90 * y); bd.data[i + 1] = Math.round(26 + 30 * y); bd.data[i + 2] = 12;
      }
    }
    fc.putImageData(fd, 0, 0); bc.putImageData(bd, 0, 0);
    if (this.scene.textures.exists('prop:fire')) this.scene.textures.remove('prop:fire');
    const tex = this.scene.textures.createCanvas('prop:fire', w * RES, h * RES);
    if (!tex) return;
    const img = this.scene.add.image(x0, y0, 'prop:fire').setOrigin(0, 0).setScale(1 / RES).setDepth(552 * S - 1);
    this.fireAnim = { tex, img, flames, base, w, h };
  }

  private drawFire(t: number, dt: number, lamps: number) {
    const f = this.fireAnim;
    if (!f) return;
    const ctx = f.tex.getContext();
    const R = RES;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, f.tex.width, f.tex.height);
    ctx.drawImage(f.base, 0, 0, f.w * R, f.h * R);
    const flick = 0.85 + 0.15 * Math.sin(t * 11.3) * Math.sin(t * 7.1 + 1);
    ctx.globalAlpha = Math.min(1, flick + 0.1);
    // rows sway sideways (more towards the tips), columns lick upwards
    const rows = 2;
    for (let y = 0; y < f.h; y += rows) {
      const up = 1 - y / f.h; // 1 at the top
      const dx = Math.sin(t * 7 - y * 0.35) * 2.2 * up * up + Math.sin(t * 13 + y * 0.9) * 0.6 * up;
      const lift = (Math.sin(t * 9 + y * 0.2) * 0.5 + 0.5) * 2.5 * up;
      ctx.drawImage(f.flames, 0, y, f.w, rows, dx * R, (y - lift) * R, f.w * R, rows * R + 1);
    }
    ctx.globalAlpha = 1;
    // hot core
    ctx.globalCompositeOperation = 'lighter';
    const cx = f.w * 0.52 * R; const cy = f.h * 0.72 * R;
    const g = ctx.createRadialGradient(cx, cy, 2, cx, cy, f.w * 0.45 * R);
    g.addColorStop(0, `rgba(255,190,90,${0.35 * flick})`); g.addColorStop(1, 'rgba(255,90,20,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, f.tex.width, f.tex.height);
    // sparks
    if (Math.random() < dt * 4) this.embers.push({ x: f.w * (0.3 + Math.random() * 0.45), y: f.h * 0.75, vy: 10 + Math.random() * 16, life: 1 });
    this.embers = this.embers.filter((e) => e.life > 0 && e.y > 2);
    for (const e of this.embers) {
      e.y -= e.vy * dt; e.x += Math.sin(t * 6 + e.y) * 0.3; e.life -= dt * 0.8;
      ctx.fillStyle = `rgba(255,210,120,${Math.max(0, e.life)})`;
      ctx.fillRect(e.x * R, e.y * R, 1.4 * R, 1.4 * R);
    }
    ctx.globalCompositeOperation = 'source-over';
    f.tex.refresh();
    void lamps;
  }

  private drawArcade(qc: QuadCanvas, t: number, playing: boolean) {
    const ctx = qc.tex.getContext();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, qc.tex.width, qc.tex.height);
    const W = 64; const H = 56;
    this.mapQuad(ctx, qc, W, H);
    ctx.fillStyle = '#05061a'; ctx.fillRect(0, 0, W, H);
    // starfield
    for (let i = 0; i < 26; i++) {
      const y = ((i * 37 + t * (playing ? 40 : 18) * (1 + (i % 3))) % H);
      ctx.fillStyle = i % 5 ? '#6b7cff' : '#ffffff';
      ctx.fillRect((i * 23) % W, y, 1, 1);
    }
    // invaders marching
    const off = Math.sin(t * (playing ? 2.4 : 1.2)) * 8;
    const colors = ['#ff4fd8', '#ffd84f', '#4fffb0'];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 5; c++) {
      if (playing && (c + r + Math.floor(t)) % 7 === 0) continue; // shot down
      const x = 10 + c * 10 + off; const y = 8 + r * 7 + (Math.floor(t * 2) % 2);
      ctx.fillStyle = colors[r]; ctx.fillRect(x, y, 6, 3); ctx.fillRect(x + 1, y + 3, 1, 1); ctx.fillRect(x + 4, y + 3, 1, 1);
    }
    // player ship + shots
    const sx = 32 + Math.sin(t * (playing ? 3.1 : 1.5)) * 20;
    ctx.fillStyle = '#4fd1ff'; ctx.fillRect(sx - 3, H - 8, 7, 3); ctx.fillRect(sx, H - 10, 1, 2);
    const shot = (t * (playing ? 3 : 1.2)) % 1;
    ctx.fillStyle = '#fff'; ctx.fillRect(sx, H - 12 - shot * 30, 1, 3);
    ctx.font = 'bold 6px monospace'; ctx.fillStyle = playing ? '#ffd84f' : `rgba(255,255,255,${Math.floor(t * 2) % 2 ? 0.95 : 0.2})`;
    ctx.fillText(playing ? `SCORE ${String(Math.floor(t * 37) % 99999).padStart(5, '0')}` : 'INSERT COIN', playing ? 8 : 12, playing ? 6 : H - 16);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    qc.tex.refresh();
    qc.img.setAlpha(0.85);
  }

  destroy() {
    this.g?.destroy(); this.fireAnim?.img.destroy(); this.arcade?.img.destroy();
    this.plants.forEach((p) => p.img.destroy()); this.plants = [];
  }
}
