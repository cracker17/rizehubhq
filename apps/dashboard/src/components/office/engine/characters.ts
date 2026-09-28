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
  constructor(scene: Phaser.Scene, private look: CharacterLook) {
    this.object = scene.add.graphics();
  }
  place(wx: number, wy: number, depth: number) {
    this.object.setPosition(wx, wy);
    this.object.setDepth(depth);
  }
  render(m: Motion, ctx: PoseCtx, time: number) {
    const pose = computePose(m, ctx);
    this.object.setScale(pose.flip ? -FIGURE_SCALE : FIGURE_SCALE, FIGURE_SCALE);
    drawFigure(this.object, this.look, pose, time);
  }
  setVisible(v: boolean) { this.object.setVisible(v); }
  destroy() { this.object.destroy(); }
}

export const proceduralFactory: CharacterFactory = {
  create: (scene, _id, look) => new ProceduralView(scene, look),
};

// ---------------------------------------------------------------- sprite sheets (manifest)
/**
 * public/office/manifest.json:
 * {
 *   "version": 1,
 *   "characters": {
 *     "<agentId>|default": {
 *       "image": "/office/sprites/shopify-dev.png", "frameWidth": 128, "frameHeight": 160,
 *       "originX": 0.5, "originY": 0.94, "scale": 0.45,
 *       "clips": { "walk_up": { "frames": [0,1,2,3,4,5,6,7], "fps": 10 }, "type_up": { … }, "idle_down": { … } }
 *     }
 *   }
 * }
 * Clip names are `<clip>_<facing>` (facing: up/down/left/right, the four iso diagonals) with fallbacks
 * `<clip>` → `idle_<facing>` → `idle`. Clips: walk, sit_down, stand_up, idle, sit_idle, type, read, drink,
 * stretch, talk, raise_hand, head_scratch, celebrate, nod + the role loops (draw, scrub, sing, whiteboard,
 * inspect, present, pingpong, foosball, phone, sofa).
 */
export interface SpriteClip { frames: number[]; fps: number; repeat?: number }
export interface SpriteEntry {
  image: string; frameWidth: number; frameHeight: number;
  originX?: number; originY?: number; scale?: number;
  clips: Record<string, SpriteClip>;
}
export interface OfficeManifest { version: number; characters: Record<string, SpriteEntry> }

export function clipFor(m: Motion): string {
  if (m.gesture) return { done: 'celebrate', scratch: 'head_scratch', nod: 'nod', wave: 'raise_hand' }[m.gesture.name];
  switch (m.phase) {
    case 'walking': return 'walk';
    case 'sitting_down': return 'sit_down';
    case 'standing_up': return 'stand_up';
    default: break;
  }
  if (m.micro) {
    const map: Partial<Record<string, string>> = { sip: 'drink', blow: 'drink', stretch: 'stretch', celebrate: 'celebrate', laugh: 'talk', phone: 'phone', nod: 'nod' };
    const c = map[m.micro.name];
    if (c) return c;
  }
  const loops: Record<string, string> = {
    type: 'type', write: 'type', ceo_desk: 'type', draw: 'draw', scrub: 'scrub', sing: 'sing', whiteboard: 'whiteboard',
    call: 'phone', review: 'inspect', inspect: 'inspect', present: 'present', meeting: 'sit_idle', wait_qa: 'drink',
    raise_hand: 'raise_hand', head_in_hands: 'head_in_hands', desk_idle: 'sit_idle', coffee: 'drink', sofa: 'sofa',
    lobby_sit: 'sit_idle', lobby_stand: 'phone', pingpong: 'pingpong', foosball: 'foosball', chat: 'talk', stand: 'idle',
  };
  return loops[m.loop] ?? 'idle';
}

class SpriteView implements CharacterView {
  readonly object: Phaser.GameObjects.Sprite;
  private current = '';
  constructor(scene: Phaser.Scene, private id: string, private entry: SpriteEntry, private texKey: string) {
    this.object = scene.add.sprite(0, 0, texKey, 0).setOrigin(entry.originX ?? 0.5, entry.originY ?? 0.94).setScale(entry.scale ?? 0.5);
  }
  place(wx: number, wy: number, depth: number) { this.object.setPosition(wx, wy); this.object.setDepth(depth); }
  private pick(clip: string, facing: Facing): string | null {
    const c = this.entry.clips;
    for (const name of [`${clip}_${facing}`, clip, `idle_${facing}`, 'idle']) if (c[name]) return name;
    return null;
  }
  render(m: Motion) {
    const name = this.pick(clipFor(m), m.facing);
    if (!name || name === this.current) return;
    this.current = name;
    this.object.play(`${this.texKey}:${name}`, true);
  }
  setVisible(v: boolean) { this.object.setVisible(v); }
  destroy() { this.object.destroy(); }
}

/** Queue the sprite sheets of a manifest in the scene loader. */
export function loadManifestSheets(scene: Phaser.Scene, manifest: OfficeManifest) {
  for (const [id, e] of Object.entries(manifest.characters ?? {})) {
    scene.load.spritesheet(`char-${id}`, e.image, { frameWidth: e.frameWidth, frameHeight: e.frameHeight });
  }
}

/** Factory that uses sprite sheets when the manifest has an entry (or a "default"), else procedural. */
export function manifestFactory(manifest: OfficeManifest | null): CharacterFactory {
  return {
    create(scene, id, look) {
      const chars = manifest?.characters ?? {};
      const key = chars[id] ? id : chars.default ? 'default' : null;
      const entry = key ? chars[key] : null;
      const texKey = `char-${key}`;
      if (!entry || !scene.textures.exists(texKey)) return proceduralFactory.create(scene, id, look);
      for (const [name, clip] of Object.entries(entry.clips)) {
        const animKey = `${texKey}:${name}`;
        if (!scene.anims.exists(animKey)) {
          scene.anims.create({
            key: animKey, frameRate: clip.fps, repeat: clip.repeat ?? -1,
            frames: clip.frames.map((f) => ({ key: texKey, frame: f })),
          });
        }
      }
      return new SpriteView(scene, id, entry, texKey);
    },
  };
}
