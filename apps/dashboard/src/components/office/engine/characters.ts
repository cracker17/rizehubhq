// Character renderers behind one interface so the procedural placeholder figures can be swapped for
// real sprite sheets from the 3D pipeline (docs/07 §10) via public/office/manifest.json.
import type Phaser from 'phaser';
import type { Motion } from '../logic/motion';
import type { Facing } from '../logic/map';
import type { CharacterLook } from './looks';
import { drawFigure } from './figure';
import { computePose, type PoseCtx } from './pose';

export interface CharacterView {
  /** The display object (camera follow target). */
  readonly object: Phaser.GameObjects.Components.Transform & Phaser.GameObjects.Components.Visible & Phaser.GameObjects.Components.Depth & Phaser.GameObjects.GameObject;
  place(wx: number, wy: number, depth: number): void;
  /** Redraw for the current motion state. Only called for on-screen characters. */
  render(m: Motion, ctx: PoseCtx, time: number): void;
  setVisible(v: boolean): void;
  destroy(): void;
}

export interface CharacterFactory {
  create(scene: Phaser.Scene, id: string, look: CharacterLook): CharacterView;
}

// ---------------------------------------------------------------- procedural (default)
/** Figures are drawn at ~60 px tall and scaled up to sit well against the furniture. */
export const FIGURE_SCALE = 1.2;
class ProceduralView implements CharacterView {
  readonly object: Phaser.GameObjects.Graphics;
  constructor(scene: Phaser.Scene, private look: CharacterLook, private scale = FIGURE_SCALE) {
    this.object = scene.add.graphics();
    // A soft dark rim so the figures sit in the painted, ink-outlined art style of the background.
    this.object.postFX?.addGlow(0x1d1510, 2.2, 0, false, 0.1, 6);
    this.object.postFX?.addShadow(0, 2, 0.06, 0.6, 0x000000, 4, 0.35);
  }
  place(wx: number, wy: number, depth: number) {
    this.object.setPosition(wx, wy);
    this.object.setDepth(depth);
  }
  render(m: Motion, ctx: PoseCtx, time: number) {
    const pose = computePose(m, ctx);
    this.object.setScale(pose.flip ? -this.scale : this.scale, this.scale);
    drawFigure(this.object, this.look, pose, time);
  }
  setVisible(v: boolean) { this.object.setVisible(v); }
  destroy() { this.object.destroy(); }
}

export const proceduralFactory: CharacterFactory = {
  create: (scene, _id, look) => new ProceduralView(scene, look),
};

export function scaledProceduralFactory(scale: number): CharacterFactory {
  return { create: (scene, _id, look) => new ProceduralView(scene, look, scale) };
}

// ---------------------------------------------------------------- pose sprites (manifest v2)
/**
 * public/office/manifest.json (v2): painted pose sprites per character (Magnific, same art style as the
 * office background). Front poses face down-left and back poses face up-right; the view mirrors them for
 * the other two facings, and adds breathing, typing and walking motion so nobody is ever frozen.
 */
export type PoseName = 'stand' | 'walk' | 'stand_back' | 'walk_back' | 'sit_type' | 'coffee' | 'sofa' | 'action'
  | 'run' | 'curl' | 'foosball' | 'sofa_back' | 'pingpong';
export interface PoseEntry { src: string; w: number; h: number; ax: number; ay: number }
export interface PoseCharacter { poses: Partial<Record<PoseName, PoseEntry>>; heightPx: number }
export interface OfficeManifest { version: number; standHeight?: number; characters: Record<string, PoseCharacter> }

export const poseKey = (who: string, pose: string) => `pose:${who}:${pose}`;

/** Queue every pose image of the manifest in the scene loader (paths may be re-based for previews). */
export function loadManifestSheets(scene: Phaser.Scene, manifest: OfficeManifest, rebase: (src: string) => string = (x) => x) {
  for (const [who, c] of Object.entries(manifest.characters ?? {})) {
    for (const [pose, e] of Object.entries(c.poses ?? {})) if (e) scene.load.image(poseKey(who, pose), rebase(e.src));
  }
}

const SEATED_SOFA = new Set(['sofa', 'lobby_sit']);
const BACK = (f: Facing) => f === 'up' || f === 'left';

/** Which pose to show, and whether to mirror it, for a motion state. Pure (tested). */
export function pickPose(m: Motion, has: (p: PoseName) => boolean, isCeo = false): { pose: PoseName; flip: boolean } {
  const f = m.facing;
  const front = (pose: PoseName) => ({ pose, flip: f === 'right' || f === 'up' });
  const back = (pose: PoseName) => ({ pose, flip: f === 'left' || f === 'down' });
  const byFacing = (fr: PoseName, bk: PoseName) => (BACK(f) && has(bk) ? back(bk) : front(fr));
  if (m.gesture?.name === 'wave' && isCeo) return front('action');
  switch (m.phase) {
    case 'walking': {
      const step = Math.sin(m.walkCycle) > 0;
      return BACK(f) ? back(step ? 'walk_back' : 'stand_back') : front(step ? 'walk' : 'stand');
    }
    case 'seated':
    case 'sitting_down':
    case 'standing_up': {
      if (m.phase !== 'seated' && m.phaseT < 0.3) return byFacing('stand', 'stand_back');
      if (SEATED_SOFA.has(m.loop) && BACK(f) && has('sofa_back')) return back('sofa_back');
      if (SEATED_SOFA.has(m.loop) || !BACK(f)) return { pose: 'sofa', flip: f === 'right' || f === 'up' };
      return back('sit_type');
    }
    default: break;
  }
  if (m.loop === 'coffee' || m.micro?.name === 'sip') return front('coffee');
  if (m.loop === 'treadmill' && m.at) return back(Math.sin(m.clock * 9) > 0 ? 'walk_back' : 'stand_back');
  if (m.loop === 'curl' && has('curl')) return front('curl');
  if (m.loop === 'foosball' && BACK(f) && has('foosball')) return back('foosball');
  if (m.loop === 'pingpong' && BACK(f) && has('pingpong')) return back('pingpong');
  if (m.loop === 'pingpong' && !isCeo) return front('action');
  if ((m.loop === 'present' || m.loop === 'whiteboard') && !BACK(f) && !isCeo) return front('action');
  if (isCeo && m.micro?.name === 'look_view') return front('action');
  return byFacing('stand', 'stand_back');
}

class PoseView implements CharacterView {
  readonly object: Phaser.GameObjects.Container;
  private img: Phaser.GameObjects.Image;
  private shadow: Phaser.GameObjects.Ellipse;
  private base: number;
  private current = '';
  private emote: Phaser.GameObjects.Text;
  private emoteText = '';
  constructor(scene: Phaser.Scene, private who: string, private c: PoseCharacter, standHeight: number, private isCeo: boolean) {
    this.base = standHeight / c.heightPx;
    this.shadow = scene.add.ellipse(0, 0, standHeight * 0.34, standHeight * 0.1, 0x1b1209, 0.22);
    this.img = scene.add.image(0, 0, poseKey(who, 'stand'));
    this.emote = scene.add.text(0, -standHeight * 1.12, '', {
      fontFamily: '"Inter", ui-sans-serif, system-ui, sans-serif', fontSize: `${Math.round(standHeight * 0.2)}px`, fontStyle: '800',
      color: '#ffffff', backgroundColor: 'rgba(15,12,40,0.82)', padding: { x: 10, y: 5 },
    }).setOrigin(0.5, 1).setVisible(false);
    this.object = scene.add.container(0, 0, [this.shadow, this.img, this.emote]);
  }
  private setEmote(text: string) {
    if (text === this.emoteText) return;
    this.emoteText = text;
    this.emote.setText(text).setVisible(!!text);
  }
  place(wx: number, wy: number, depth: number) { this.object.setPosition(wx, wy); this.object.setDepth(depth); }
  render(m: Motion, ctx: PoseCtx, time: number) {
    const has = (p: PoseName) => !!this.c.poses[p];
    let { pose, flip } = pickPose(m, has, this.isCeo);
    if (!has(pose)) pose = 'stand';
    const e = this.c.poses[pose]!;
    const key = poseKey(this.who, pose);
    if (key !== this.current) { this.img.setTexture(key); this.current = key; }
    const s = this.base;
    const seated = pose === 'sit_type' || pose === 'sofa' || pose === 'sofa_back';
    const t = time + m.seed * 10;
    // micro-motion: breathing, typing, walking bounce, gestures
    let bob = 0;
    let sy = 1 + Math.sin(t * 2.1) * 0.012;
    let rot = Math.sin(t * 0.7) * 0.006;
    if (m.phase === 'walking') { bob = -Math.abs(Math.sin(m.walkCycle)) * 0.035 * s * this.c.heightPx; rot = Math.sin(m.walkCycle) * 0.03; }
    else if (m.loop === 'treadmill' && m.at) { bob = -Math.abs(Math.sin(m.clock * 9)) * 0.03 * s * this.c.heightPx - 0.035 * s * this.c.heightPx; rot = Math.sin(m.clock * 9) * 0.025; }
    else if (m.loop === 'curl' && pose === 'curl') { sy += Math.sin(t * 3.2) * 0.01; rot = Math.sin(t * 3.2) * 0.012; }
    else if (seated && ['type', 'write', 'draw', 'review', 'call', 'ceo_desk'].includes(m.loop)) { bob = Math.sin(t * 13) * 0.006 * s * this.c.heightPx; }
    // Games: swing when the ball comes to you, then celebrate or groan at the end of each point.
    let dx = 0;
    let emote = '';
    const game = (m.loop === 'pingpong' || m.loop === 'foosball') && m.at && ctx.pairPhase !== undefined;
    if (game) {
      const g = gameState(time, ctx.pairSide ?? 0, m.loop === 'foosball');
      const H = s * this.c.heightPx;
      if (g.state === 'play') {
        const dir = flip ? -1 : 1;
        rot = g.swing * 0.2 * dir - (1 - g.swing) * 0.03 * dir;
        dx = g.swing * 0.08 * H * dir;
        bob = -g.swing * 0.03 * H + Math.sin(time * 6 + m.seed * 5) * 0.008 * H; // ready bounce
        sy += Math.sin(time * 6 + m.seed * 5) * 0.012;
      } else if (g.state === 'win') {
        bob = -Math.abs(Math.sin(g.k * Math.PI * 3)) * 0.12 * H;
        rot = Math.sin(g.k * Math.PI * 6) * 0.07;
        sy += 0.04;
        emote = g.k < 0.95 ? ['Yes!! 🎉', 'Point! 🔥', 'Let’s go! 💪'][g.n % 3] : '';
      } else if (g.state === 'lose') {
        sy -= 0.05 * Math.sin(Math.min(1, g.k * 2) * Math.PI / 2);
        rot = (flip ? 1 : -1) * 0.1 * Math.min(1, g.k * 3);
        bob = 0.02 * H;
        emote = g.k < 0.95 ? ['Argh 😩', 'Noo! 😫', 'Lucky… 😤'][g.n % 3] : '';
      }
    }
    this.setEmote(emote);
    if (m.gesture) { const g = m.gesture.t / m.gesture.dur; bob -= Math.sin(g * Math.PI * 3) * (m.gesture.name === 'done' ? 0.07 : 0.03) * s * this.c.heightPx; }
    if (m.micro?.name === 'stretch') sy += Math.sin((m.micro.t / m.micro.dur) * Math.PI) * 0.05;
    if (m.phase === 'sitting_down' || m.phase === 'standing_up') sy *= 0.94;
    const sitLift = (seated ? (pose === 'sit_type' ? 0.28 : pose === 'sofa_back' ? 0.2 : 0.25) : 0) * s * this.c.heightPx;
    this.img.setOrigin(flip ? 1 - e.ax : e.ax, e.ay);
    this.img.setScale(flip ? -s : s, s * sy);
    this.img.setPosition(dx, bob - sitLift);
    this.img.setRotation(rot);
    const walkingShadow = m.phase === 'walking' ? 0.85 + Math.abs(Math.sin(m.walkCycle)) * 0.1 : 1;
    this.shadow.setScale(seated ? 1.3 : walkingShadow, seated ? 1.1 : 1);
    this.shadow.setPosition(seated ? (flip ? -0.06 : 0.06) * s * this.c.heightPx : 0, 2);
  }
  setVisible(v: boolean) { this.object.setVisible(v); }
  destroy() { this.object.destroy(); }
}

/**
 * Shared clock of a paired game (both players and the ball derive from it, so they stay in sync):
 * a rally of hits, then ~2.2 s where one side won the point. Pure (tested).
 */
export const RALLY_HIT = 0.8; // seconds per crossing (half of the 1.6 s back-and-forth)
export function gameState(time: number, side: 0 | 1, foosball = false) {
  const hits = 7 + 0; const rally = hits * RALLY_HIT; const pause = 2.2; const period = rally + pause;
  const n = Math.floor(time / period); const tt = time - n * period;
  if (tt >= rally) {
    const winner = ((n * 2654435761) >>> 0) % 2;
    return { state: winner === side ? 'win' as const : 'lose' as const, k: (tt - rally) / pause, swing: 0, n };
  }
  // ball phase 0..1 over a back-and-forth; side 0 hits at 0, side 1 at 0.5
  const ph = (tt / (2 * RALLY_HIT)) % 1;
  const d = side === 0 ? Math.min(ph, 1 - ph) : Math.abs(ph - 0.5);
  const swing = foosball ? Math.exp(-((d / 0.12) ** 2)) : Math.exp(-((d / 0.07) ** 2));
  return { state: 'play' as const, k: ph, swing, n };
}

/** Painted pose sprites when the manifest has them for this character, else the procedural figure. */
export function manifestFactory(manifest: OfficeManifest | null, figureScale = FIGURE_SCALE, worldScale = 1): CharacterFactory {
  const procedural = scaledProceduralFactory(figureScale);
  return {
    create(scene, id, look) {
      const who = id === '__ceo__' ? 'ceo' : id;
      const c = manifest?.characters?.[who];
      if (!c || !scene.textures.exists(poseKey(who, 'stand'))) return procedural.create(scene, id, look);
      return new PoseView(scene, who, c, (manifest?.standHeight ?? 102) * worldScale, who === 'ceo');
    },
  };
}
