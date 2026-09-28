// Live monitors: every assigned desk's screens show a small picture of the agent's actual work (the
// task they are on, its progress, the kind of app they use for it), redrawn a couple of times a second.
// Each screen is its own little canvas mapped onto the monitor (affine: the monitors are parallelograms
// in the picture) and sorted just in front of its desk, so a seated person's head still covers it.
import * as Phaser from 'phaser';
import { LAYOUT, PROJ } from '../logic/layout';
import type { OfficeMap } from '../logic/map';
import type { ScreenApp } from '../logic/director';
import type { Pt } from '../logic/iso';
import type { FurnitureLayer } from './furniture';

const S = LAYOUT.image.scale;
const RES = 2; // canvas px per world px (crisp when zoomed in)
const CW = 160; // logical screen content size
const CH = 100;

export interface ScreenInfo {
  app: ScreenApp; title: string; progress?: number; color: string; name: string;
  /** Real screen content from agent_screens (text of the draft / code, current step, deliverable image). */
  content?: string | null; note?: string | null; image?: string | null;
}

// Deliverable images (agent_screens.image_url), loaded CORS-clean so they can be drawn into the canvas.
const images = new Map<string, HTMLImageElement | null>();
function imageFor(url: string | null | undefined): HTMLImageElement | null {
  if (!url || typeof Image === 'undefined') return null;
  if (images.has(url)) { const im = images.get(url)!; return im && im.complete && im.naturalWidth ? im : null; }
  const im = new Image();
  im.crossOrigin = 'anonymous';
  im.onerror = () => images.set(url, null);
  im.src = url;
  images.set(url, im);
  return null;
}

/** One canvas per desk (all its monitors); drawn as slices matching the desk's own slices. */
interface Slot { key: string; agentId: string; quads: Pt[][]; x0: number; y0: number; tex: Phaser.Textures.CanvasTexture; imgs: Phaser.GameObjects.Image[] }

const IDLE_INFO: ScreenInfo = { app: 'screensaver', title: '', color: '#7b5cff', name: '' };
const hashStr = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

export class ScreenLayer {
  private slots: Slot[] = [];
  private info = new Map<string, ScreenInfo>();
  private last = 0;

  constructor(private scene: Phaser.Scene, private furniture: FurnitureLayer) {}

  setMap(map: OfficeMap) {
    this.clear();
    // Every sprite desk gets live screens; nobody's desk shows the RizeHub screensaver.
    const owned = new Map(map.desks.map((d) => [d.id, d.agentId]));
    for (const seat of map.seats) {
      const d = { ...seat, agentId: owned.get(seat.id) ?? `idle:${seat.id}` };
      if (!owned.has(seat.id) && !seat.deskId) continue;
      const placed = d.deskId ? this.furniture.placed.get(d.deskId) : undefined;
      if (placed?.item.screens) {
        // Same footprint and slicing as the desk sprite: each monitor column sorts exactly like the desk under it.
        const { origin, item } = placed;
        const key = `screen:${d.agentId}`;
        const tex = this.makeTex(key, item.w, item.h);
        if (!tex) continue;
        const imgs = placed.slices.map((sl) => this.scene.add.image(origin.x, origin.y, key).setOrigin(0, 0).setScale(1 / RES)
          .setCrop(sl.cx * RES, 0, sl.w * RES, item.h * RES).setDepth(sl.depth + 0.05));
        const quads = (item.screens ?? []).map((q) => q.map(([x, y]) => ({ x: origin.x + x, y: origin.y + y })));
        this.slots.push({ key, agentId: d.agentId, quads, x0: origin.x, y0: origin.y, tex, imgs });
      } else if (d.screens.length) {
        // Painted monitors: one canvas over their bounding box, just behind the person sitting there.
        const quads = d.screens.map((q) => q.map((p) => ({ x: p.x * S, y: p.y * S })));
        const all = quads.flat();
        const x0 = Math.floor(Math.min(...all.map((p) => p.x))); const x1 = Math.ceil(Math.max(...all.map((p) => p.x)));
        const y0 = Math.floor(Math.min(...all.map((p) => p.y))); const y1 = Math.ceil(Math.max(...all.map((p) => p.y)));
        const key = `screen:${d.agentId}`;
        const tex = this.makeTex(key, x1 - x0, y1 - y0);
        if (!tex) continue;
        const img = this.scene.add.image(x0, y0, key).setOrigin(0, 0).setScale(1 / RES).setDepth(PROJ_Y(d.x, d.y) - 1);
        this.slots.push({ key, agentId: d.agentId, quads, x0, y0, tex, imgs: [img] });
      }
    }
    this.last = 0;
  }

  private makeTex(key: string, w: number, h: number) {
    if (this.scene.textures.exists(key)) this.scene.textures.remove(key);
    return this.scene.textures.createCanvas(key, Math.max(2, Math.ceil(w * RES)), Math.max(2, Math.ceil(h * RES)));
  }

  private clear() {
    this.slots.forEach((s) => { s.imgs.forEach((i) => i.destroy()); this.scene.textures.remove(s.key); });
    this.slots = [];
  }

  setInfo(agentId: string, info: ScreenInfo) { this.info.set(agentId, info); }

  update(t: number) {
    if (t - this.last < 0.12) return;
    this.last = t;
    for (const s of this.slots) this.draw(s, t);
  }

  private draw(s: Slot, t: number) {
    const ctx = s.tex.getContext();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, s.tex.width, s.tex.height);
    const info = this.info.get(s.agentId) ?? (s.agentId.startsWith('idle:') ? IDLE_INFO : undefined);
    if (info) {
      s.quads.forEach((quad, i) => {
        // map the content rect (0..CW, 0..CH) onto the monitor: affine from its TL, TR, BL corners
        const [tl, tr, , bl] = quad.map((p) => ({ x: (p.x - s.x0) * RES, y: (p.y - s.y0) * RES }));
        ctx.save();
        ctx.setTransform((tr.x - tl.x) / CW, (tr.y - tl.y) / CW, (bl.x - tl.x) / CH, (bl.y - tl.y) / CH, tl.x, tl.y);
        ctx.beginPath(); ctx.rect(0, 0, CW, CH); ctx.clip();
        drawApp(ctx, info, t, i, s.quads.length, s.agentId);
        screenFinish(ctx);
        ctx.restore();
      });
    }
    s.tex.refresh();
  }

  destroy() { this.clear(); }
}
// Seat tile → world y (used to sort painted monitors behind their seated user).
function PROJ_Y(tx: number, ty: number) { return PROJ.toImage(tx, ty).y * S; }

// ---------------------------------------------------------------- the pictures on the screens
function bar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: string) { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); }

function text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, color: string, maxW: number, weight = 600) {
  ctx.fillStyle = color;
  ctx.font = `${weight} ${size}px ui-sans-serif, system-ui, sans-serif`;
  let str = s;
  while (str.length > 3 && ctx.measureText(str).width > maxW) str = `${str.slice(0, -2)}…`;
  ctx.fillText(str, x, y);
}

function progressBar(ctx: CanvasRenderingContext2D, p: number | undefined, y: number, color: string) {
  if (p === undefined) return;
  bar(ctx, 8, y, CW - 16, 4, 'rgba(255,255,255,.15)');
  bar(ctx, 8, y, (CW - 16) * Math.max(0.03, Math.min(1, p / 100)), 4, color);
}

function drawApp(ctx: CanvasRenderingContext2D, info: ScreenInfo, t: number, index: number, count: number, agentId: string) {
  const seed = hashStr(agentId + info.title);
  const rnd = (i: number) => ((Math.sin(seed * 0.001 + i * 12.9898) * 43758.5453) % 1 + 1) % 1;
  const app = info.app;
  if (app === 'off') { bar(ctx, 0, 0, CW, CH, '#07080c'); return; }
  if (app === 'screensaver') { drawScreensaver(ctx, t, index, seed); return; }
  if (app === 'review' && index === 3) { drawMobilePreview(ctx, info, t, rnd); return; }
  // A second monitor shows the "result" side (preview / tests / chart) of the same work.
  const side = count > 1 && index === count - 1;
  const title = info.title || 'Working';
  const lines = (info.content ?? '').split(/\r?\n/).map((l) => l.replace(/\t/g, '  ')).filter((l, i, a) => l.trim() || (i > 0 && a[i - 1].trim()));
  const img = imageFor(info.image);
  if (img && (app === 'design' || app === 'browser' || side)) {
    // The actual deliverable (a design, a page screenshot…), letterboxed.
    bar(ctx, 0, 0, CW, CH, '#101218');
    const k = Math.min(CW / img.naturalWidth, (CH - (info.note ? 12 : 0)) / img.naturalHeight);
    const w = img.naturalWidth * k; const h = img.naturalHeight * k;
    ctx.drawImage(img, (CW - w) / 2, (CH - (info.note ? 12 : 0) - h) / 2, w, h);
    if (info.note) { bar(ctx, 0, CH - 12, CW, 12, 'rgba(0,0,0,.72)'); text(ctx, info.note, 4, CH - 3.5, 7, '#fff', CW - 8, 600); }
    return;
  }
  switch (app) {
    case 'editor': {
      if (side) { // live preview of the page being built
        bar(ctx, 0, 0, CW, CH, '#f4f6fb'); bar(ctx, 0, 0, CW, 12, '#dfe3ec');
        [0, 1, 2].forEach((i) => bar(ctx, 6 + i * 7, 4, 4, 4, ['#ff5f57', '#febc2e', '#28c840'][i]));
        bar(ctx, 8, 18, CW - 16, 30, info.color); text(ctx, title, 12, 37, 10, '#fff', CW - 24, 800);
        for (let i = 0; i < 3; i++) { bar(ctx, 8 + i * 49, 54, 44, 30, '#e3e8f2'); bar(ctx, 12 + i * 49, 76, 30, 4, '#b8c1d3'); }
        progressBar(ctx, info.progress, CH - 8, '#39d98a');
        return;
      }
      bar(ctx, 0, 0, CW, CH, '#11151f'); bar(ctx, 0, 0, CW, 11, '#1b2130');
      text(ctx, `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 22)}.tsx`, 6, 8.5, 7, '#9fb3d9', CW - 12, 500);
      if (lines.length) {
        ctx.font = '500 6.4px ui-monospace, SFMono-Regular, Menlo, monospace';
        const start = lines.length > 11 ? Math.floor(t * 0.8) % (lines.length - 10) : 0;
        for (let i = 0; i < 11 && start + i < lines.length; i++) {
          const y = 20 + i * 7.6;
          ctx.fillStyle = '#4d5873'; ctx.fillText(String(start + i + 1), 3, y + 3);
          ctx.fillStyle = ['#c3e88d', '#89ddff', '#e6edf7', '#ffcb6b'][(start + i) % 4];
          ctx.fillText(lines[start + i].slice(0, 44), 16, y + 3);
        }
        if (info.note) text(ctx, info.note, 6, CH - 10, 6, '#9fb3d9', CW - 12, 500);
        progressBar(ctx, info.progress, CH - 6, '#39d98a');
        return;
      }
      const scroll = Math.floor(t * 1.4) % 12;
      for (let i = 0; i < 11; i++) {
        const k = i + scroll; const y = 17 + i * 7.6;
        text(ctx, String(k + 1), 3, y + 3, 5.5, '#4d5873', 12, 500);
        const ind = (Math.floor(rnd(k) * 3)) * 6;
        const w1 = 12 + rnd(k + 1) * 30; const w2 = 10 + rnd(k + 2) * 50;
        bar(ctx, 16 + ind, y, w1, 3.4, ['#c792ea', '#82aaff', '#f78c6c'][k % 3]);
        bar(ctx, 20 + ind + w1, y, w2, 3.4, ['#c3e88d', '#89ddff', '#ffcb6b'][(k + 1) % 3]);
      }
      if (Math.floor(t * 2) % 2) bar(ctx, 60, 17 + 10 * 7.6, 1.5, 5, '#fff');
      progressBar(ctx, info.progress, CH - 6, '#39d98a');
      return;
    }
    case 'design': {
      bar(ctx, 0, 0, CW, CH, '#2a2b31'); bar(ctx, 0, 0, 14, CH, '#1f2025'); bar(ctx, CW - 26, 0, 26, CH, '#1f2025');
      bar(ctx, 20, 8, CW - 52, CH - 16, '#f7f3ea');
      ctx.fillStyle = info.color; ctx.beginPath(); ctx.arc(52 + Math.sin(t * 0.6) * 4, 40, 16, 0, Math.PI * 2); ctx.fill();
      bar(ctx, 76, 26, 40, 8, '#1e2530'); bar(ctx, 76, 38, 30, 5, '#8a93a3');
      bar(ctx, 30, 62, CW - 72, 14, '#ffd166'); text(ctx, title, 34, 72, 7.5, '#1e2530', CW - 80, 800);
      ['#ff6b6b', '#ffd166', '#06d6a0', '#118ab2', info.color].forEach((c, i) => bar(ctx, CW - 21, 8 + i * 12, 16, 9, c));
      progressBar(ctx, info.progress, CH - 5, '#ff8fb1');
      return;
    }
    case 'leads':
    case 'sheet': {
      bar(ctx, 0, 0, CW, CH, '#ffffff'); bar(ctx, 0, 0, CW, 13, app === 'leads' ? '#1f9d6b' : '#2563eb');
      text(ctx, title, 5, 9.5, 7.5, '#fff', CW - 10, 800);
      const cols = [8, 62, 108];
      ['Company', 'Stage', 'Next'].forEach((h, i) => text(ctx, h, cols[i], 22, 6.5, '#475569', 50, 800));
      const stages = ['New', 'Researched', 'Contacted', 'Replied', 'Proposal'];
      for (let r = 0; r < 7; r++) {
        const y = 26 + r * 9.5;
        bar(ctx, 4, y, CW - 8, 0.6, '#e2e8f0');
        bar(ctx, cols[0], y + 3, 26 + rnd(r) * 22, 3.2, '#334155');
        const st = stages[Math.floor(rnd(r + 9) * stages.length)];
        text(ctx, st, cols[1], y + 7.2, 6, ['#64748b', '#2563eb', '#7c3aed', '#16a34a', '#b45309'][stages.indexOf(st)], 44, 700);
        bar(ctx, cols[2], y + 3, 18 + rnd(r + 4) * 20, 3.2, '#94a3b8');
      }
      if (Math.floor(t) % 3 === 0) bar(ctx, 4, 26 + (Math.floor(t) % 7) * 9.5, CW - 8, 9, 'rgba(37,99,235,.10)');
      return;
    }
    case 'review': {
      // QA station: the page under test (desktop), the checklist, the scores, and the mobile preview on the tablet.
      if (index === 3) { drawMobilePreview(ctx, info, t, rnd); return; }
      if (index === 0 && count > 2) { drawPagePreview(ctx, info, t, rnd, false); return; }
      if (index === 2 && count > 2) { drawScores(ctx, info, t, rnd); return; }
      bar(ctx, 0, 0, CW, CH, '#0f1720');
      bar(ctx, 0, 0, CW, 14, '#16212d');
      text(ctx, `QA · ${title}`, 6, 10, 7.5, '#e2f7ec', CW - 12, 800);
      const n = 7;
      const done = Math.floor((t * 0.8) % (n + 3));
      const labels = ['Links & buttons', 'Mobile layout', 'Spelling', 'Images / alt', 'Page speed', 'SEO meta', 'Brand check'];
      for (let i = 0; i < n; i++) {
        const y = 19 + i * 10.5;
        const state = i < done ? (rnd(i + 3) < 0.86 ? 'ok' : 'x') : i === done ? 'run' : 'wait';
        const c = state === 'ok' ? '#39d98a' : state === 'x' ? '#ff6b6b' : state === 'run' ? '#ffd166' : '#3b4a5a';
        ctx.fillStyle = c; ctx.beginPath(); ctx.arc(10, y + 3.5, 3, 0, Math.PI * 2); ctx.fill();
        text(ctx, labels[i], 18, y + 6, 6.5, state === 'wait' ? '#5b6b7d' : '#c9d6e3', 90, 600);
        text(ctx, state === 'ok' ? 'pass' : state === 'x' ? 'fix' : state === 'run' ? '…' : '', CW - 26, y + 6, 6, c, 22, 700);
      }
      progressBar(ctx, info.progress, CH - 6, '#39d98a');
      return;
    }
    case 'browser': {
      bar(ctx, 0, 0, CW, CH, '#f8fafc'); bar(ctx, 0, 0, CW, 12, '#e2e8f0'); bar(ctx, 20, 3, CW - 40, 6, '#ffffff');
      text(ctx, 'rizehub.ph', 24, 8, 5.5, '#64748b', 80, 500);
      bar(ctx, 8, 18, CW - 16, 26, info.color); text(ctx, title, 12, 34, 9, '#fff', CW - 24, 800);
      for (let i = 0; i < 4; i++) bar(ctx, 8, 52 + i * 9, 60 + rnd(i) * 80, 4, '#cbd5e1');
      return;
    }
    default: { // doc
      bar(ctx, 0, 0, CW, CH, '#eceff4'); bar(ctx, 20, 4, CW - 40, CH, '#ffffff');
      text(ctx, title, 26, 17, 9, '#111827', CW - 52, 800);
      if (lines.length) {
        ctx.font = '500 6px ui-serif, Georgia, serif'; ctx.fillStyle = '#374151';
        const words = lines.join(' ').split(/\s+/);
        const rows: string[] = []; let row = '';
        for (const w of words) { const nx = row ? `${row} ${w}` : w; if (ctx.measureText(nx).width > CW - 56) { rows.push(row); row = w; } else row = nx; if (rows.length > 40) break; }
        if (row) rows.push(row);
        const start = rows.length > 9 ? Math.floor(t * 0.5) % (rows.length - 8) : 0;
        rows.slice(start, start + 9).forEach((r, i) => ctx.fillText(r, 26, 29 + i * 7.4));
        if (info.note) text(ctx, info.note, 26, CH - 10, 6, '#6b7280', CW - 52, 600);
        progressBar(ctx, info.progress, CH - 6, info.color);
        return;
      }
      const nLines = 10;
      const typed = (t * 3) % (nLines * 3);
      for (let i = 0; i < nLines; i++) {
        const w = (i % 4 === 3 ? 50 : 95) * (0.7 + rnd(i) * 0.3);
        const shown = Math.min(1, Math.max(0, typed / 3 - i));
        if (shown > 0) bar(ctx, 26, 25 + i * 7, w * shown, 3, '#9ca3af');
      }
      if (Math.floor(t * 2) % 2) { const i = Math.min(nLines - 1, Math.floor(typed / 3)); bar(ctx, 27 + 95 * 0.8, 24 + i * 7, 1, 5, '#111827'); }
      progressBar(ctx, info.progress, CH - 6, info.color);
    }
  }
}

/** A web page being checked, scrolling slowly (desktop viewport). */
function drawPagePreview(ctx: CanvasRenderingContext2D, info: ScreenInfo, t: number, rnd: (i: number) => number, _mobile: boolean) {
  bar(ctx, 0, 0, CW, CH, '#f8fafc');
  bar(ctx, 0, 0, CW, 11, '#e2e8f0');
  [0, 1, 2].forEach((i) => { ctx.fillStyle = ['#ff5f57', '#febc2e', '#28c840'][i]; ctx.beginPath(); ctx.arc(6 + i * 6, 5.5, 2, 0, Math.PI * 2); ctx.fill(); });
  bar(ctx, 26, 2.5, CW - 34, 6, '#ffffff'); text(ctx, 'staging.client-site.com', 29, 7.6, 5, '#64748b', CW - 40, 500);
  ctx.save(); ctx.beginPath(); ctx.rect(0, 11, CW, CH - 11); ctx.clip();
  const scroll = (t * 9) % 120;
  ctx.translate(0, 11 - scroll);
  bar(ctx, 0, 0, CW, 8, '#111827'); for (let i = 0; i < 4; i++) bar(ctx, CW - 70 + i * 16, 3, 11, 2, '#9ca3af');
  bar(ctx, 0, 8, CW, 46, info.color || '#7c3aed');
  text(ctx, info.title || 'Landing page', 10, 26, 10, '#ffffff', CW - 20, 800);
  bar(ctx, 10, 32, 90, 3, 'rgba(255,255,255,.75)'); bar(ctx, 10, 38, 70, 3, 'rgba(255,255,255,.6)');
  bar(ctx, 10, 44, 34, 7, '#ffffff');
  for (let c = 0; c < 3; c++) { bar(ctx, 8 + c * 50, 60, 44, 30, '#e5e7eb'); bar(ctx, 12 + c * 50, 64, 36, 14, ['#c4b5fd', '#93c5fd', '#fcd34d'][c]); bar(ctx, 12 + c * 50, 82, 30, 3, '#9ca3af'); }
  for (let i = 0; i < 8; i++) bar(ctx, 10, 98 + i * 8, 60 + rnd(i + 20) * 80, 3.2, '#cbd5e1');
  bar(ctx, 0, 170, CW, 60, '#111827');
  ctx.restore();
  // QA highlight box hunting over the page
  const hx = 12 + ((Math.sin(t * 0.7) + 1) / 2) * 90; const hy = 30 + ((Math.cos(t * 0.53) + 1) / 2) * 50;
  ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 1.2; ctx.setLineDash([3, 2]); ctx.strokeRect(hx, hy, 46, 18); ctx.setLineDash([]);
}

/** Lighthouse-style scores and a small trend. */
function drawScores(ctx: CanvasRenderingContext2D, info: ScreenInfo, t: number, rnd: (i: number) => number) {
  bar(ctx, 0, 0, CW, CH, '#0b1220');
  text(ctx, 'Page checks', 6, 10, 7.5, '#e5e7eb', CW - 12, 800);
  const names = ['Perf', 'A11y', 'SEO', 'Best'];
  names.forEach((n, i) => {
    const cx = 22 + i * 38; const cy = 38; const v = 0.72 + rnd(i + 9) * 0.26;
    const p = Math.min(v, ((t * 0.3 + i * 0.2) % 1.6));
    const c = v > 0.9 ? '#22c55e' : v > 0.8 ? '#f59e0b' : '#ef4444';
    ctx.lineWidth = 3.4; ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.beginPath(); ctx.arc(cx, cy, 12, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = c; ctx.beginPath(); ctx.arc(cx, cy, 12, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p); ctx.stroke();
    text(ctx, `${Math.round(p * 100)}`, cx - 6, cy + 3, 7, '#f8fafc', 20, 800);
    text(ctx, n, cx - 8, cy + 22, 6, '#94a3b8', 30, 600);
  });
  ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 1.4; ctx.beginPath();
  for (let i = 0; i <= 16; i++) { const x = 8 + i * 9; const y = 86 - (rnd(i + 40) * 10 + i * 0.6); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
  ctx.stroke();
  progressBar(ctx, info.progress, CH - 6, '#39d98a');
}

/** The tablet on the QA desk: the same page on two phone viewports (iPhone / Android), scrolling. */
function drawMobilePreview(ctx: CanvasRenderingContext2D, info: ScreenInfo, t: number, rnd: (i: number) => number) {
  bar(ctx, 0, 0, CW, CH, '#1f2937');
  text(ctx, 'Mobile preview', 6, 9, 6.5, '#e5e7eb', 80, 700);
  [0, 1].forEach((k) => {
    const x = 22 + k * 64; const y = 13; const w = 44; const h = 82;
    ctx.fillStyle = '#0b0b0f'; ctx.beginPath(); ctx.roundRect(x - 2.5, y - 2.5, w + 5, h + 5, 6); ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.roundRect(x, y, w, h, 4); ctx.clip();
    bar(ctx, x, y, w, h, '#f8fafc');
    const sc = ((t * 7 + k * 25) % 70);
    ctx.translate(0, -sc);
    bar(ctx, x, y + 6, w, 30, info.color || '#7c3aed');
    text(ctx, info.title || 'Page', x + 3, y + 20, 5.5, '#fff', w - 6, 800);
    bar(ctx, x + 3, y + 26, 22, 4, '#fff');
    for (let i = 0; i < 10; i++) bar(ctx, x + 3, y + 42 + i * 7, 18 + rnd(i + k * 11) * 20, 2.6, '#cbd5e1');
    bar(ctx, x + 3, y + 112, w - 6, 18, '#e5e7eb');
    ctx.restore();
    bar(ctx, x + w / 2 - 6, y + 1.5, 12, 2.6, '#0b0b0f'); // notch
    // a tap ripple now and then
    const ph = (t * 0.6 + k * 0.5) % 1;
    if (ph < 0.35) { ctx.strokeStyle = `rgba(59,130,246,${0.8 - ph * 2})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x + 12 + rnd(k + Math.floor(t * 0.6)) * 20, y + 30 + rnd(k + 5) * 30, 2 + ph * 14, 0, Math.PI * 2); ctx.stroke(); }
  });
}

/** Glass finish over any screen: a thin dark bezel and a soft diagonal reflection. */
function screenFinish(ctx: CanvasRenderingContext2D) {
  const g = ctx.createLinearGradient(0, 0, CW, CH);
  g.addColorStop(0, 'rgba(255,255,255,0.10)'); g.addColorStop(0.35, 'rgba(255,255,255,0.02)'); g.addColorStop(0.36, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(0,0,0,0.12)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, CW, CH);
  ctx.strokeStyle = 'rgba(8,10,14,0.9)'; ctx.lineWidth = 3; ctx.strokeRect(0, 0, CW, CH);
}

/** RizeHub screensaver: navy grid, drifting aurora, twinkles, and the RizeHub wordmark gliding and bouncing
 *  around the screen ("Rize" in the brand violet-to-blue gradient, "Hub" white, the teal dot pulsing). */
function drawScreensaver(ctx: CanvasRenderingContext2D, t: number, index: number, seed: number) {
  const ph = index * 2.3 + (seed % 97) * 0.13;
  ctx.fillStyle = '#0a0f1f'; ctx.fillRect(0, 0, CW, CH);
  // aurora blobs
  for (let i = 0; i < 3; i++) {
    const x = CW * (0.5 + 0.45 * Math.sin(t * (0.13 + i * 0.05) + ph + i * 2));
    const y = CH * (0.5 + 0.4 * Math.cos(t * (0.11 + i * 0.04) + ph * 1.3 + i));
    const g = ctx.createRadialGradient(x, y, 0, x, y, 70);
    g.addColorStop(0, ['rgba(123,92,255,0.35)', 'rgba(61,139,255,0.3)', 'rgba(25,195,177,0.22)'][i]);
    g.addColorStop(1, 'rgba(10,15,31,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, CW, CH);
  }
  // faint grid, slowly scrolling
  ctx.strokeStyle = 'rgba(120,140,200,0.10)'; ctx.lineWidth = 0.5;
  const off = (t * 3) % 12;
  ctx.beginPath();
  for (let x = -12 + off; x < CW; x += 12) { ctx.moveTo(x, 0); ctx.lineTo(x, CH); }
  for (let y = -12 + off * 0.6; y < CH; y += 12) { ctx.moveTo(0, y); ctx.lineTo(CW, y); }
  ctx.stroke();
  // twinkles
  for (let i = 0; i < 14; i++) {
    const r = ((Math.sin(seed * 0.01 + i * 91.7) * 43758.5) % 1 + 1) % 1;
    const r2 = ((Math.sin(seed * 0.02 + i * 17.3) * 12731.1) % 1 + 1) % 1;
    const a = 0.5 + 0.5 * Math.sin(t * (1.5 + r * 2) + i);
    ctx.fillStyle = `rgba(200,210,255,${0.5 * a})`;
    ctx.fillRect(r * CW, r2 * CH, 1.1, 1.1);
  }
  // wordmark, bouncing (DVD-style) — its size fits the screen
  ctx.font = '800 24px "Inter", ui-sans-serif, system-ui, sans-serif';
  ctx.textBaseline = 'alphabetic';
  const wr = ctx.measureText('Rize').width; const wh = ctx.measureText('Hub').width;
  const w = wr + wh + 12; const h = 20;
  const tri = (v: number) => 1 - Math.abs(((v % 2) + 2) % 2 - 1); // 0..1..0
  const x = 4 + tri(t * 0.09 + ph) * (CW - w - 8);
  const y = h + 4 + tri(t * 0.13 + ph * 0.7) * (CH - h - 10);
  const gr = ctx.createLinearGradient(x, 0, x + wr, 0);
  const sweep = ((t * 0.5 + ph) % 2.2) - 0.6;
  gr.addColorStop(0, '#7b5cff'); gr.addColorStop(Math.min(1, Math.max(0, sweep)), '#c7bcff'); gr.addColorStop(1, '#4b7bff');
  ctx.shadowColor = 'rgba(123,92,255,0.8)'; ctx.shadowBlur = 10;
  ctx.fillStyle = gr; ctx.fillText('Rize', x, y);
  ctx.shadowColor = 'rgba(160,190,255,0.6)'; ctx.fillStyle = '#f4f6ff'; ctx.fillText('Hub', x + wr, y);
  const pulse = 0.7 + 0.3 * Math.sin(t * 3 + ph);
  ctx.shadowColor = '#19c3b1'; ctx.shadowBlur = 12 * pulse;
  ctx.fillStyle = '#19b3a6';
  ctx.beginPath(); ctx.arc(x + wr + wh + 7, y - 6.5, 3.3, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
  // soft reflection under the wordmark
  ctx.globalAlpha = 0.12; ctx.save(); ctx.translate(0, 2 * y + 4); ctx.scale(1, -1);
  ctx.fillStyle = '#7b5cff'; ctx.fillText('Rize', x, y); ctx.fillStyle = '#ffffff'; ctx.fillText('Hub', x + wr, y);
  ctx.restore(); ctx.globalAlpha = 1;
}
