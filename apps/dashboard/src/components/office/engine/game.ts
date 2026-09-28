// Boots Phaser inside a DOM element and returns a small controller for React.
// Client-only: this module (and Phaser) is only ever loaded through a dynamic import.
import * as Phaser from 'phaser';
import type { OfficeEvent, OfficeModel } from '../logic/director';
import { OfficeScene, type FrameInfo, type SceneOptions } from './OfficeScene';

export interface OfficeController {
  setModel(model: OfficeModel, events: OfficeEvent[]): void;
  setNight(night: boolean): void;
  zoomBy(factor: number): void;
  resetView(): void;
  follow(id: string | null): void;
  setAvatar(on: boolean): void;
  destroy(): void;
}

export interface CreateOptions {
  avatar: boolean;
  wheel: 'always' | 'modifier';
  onSelect: (id: string) => void;
  onFrame: (f: FrameInfo) => void;
  onReady: () => void;
  onUserCamera: () => void;
}

export function createOfficeGame(parent: HTMLElement, o: CreateOptions): OfficeController {
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const size = () => ({ w: Math.max(200, parent.clientWidth), h: Math.max(200, parent.clientHeight) });
  const { w, h } = size();
  const opts: SceneOptions = { avatar: o.avatar, wheel: o.wheel, dpr };
  const scene = new OfficeScene();
  let queued: (() => void)[] = [];
  let ready = false;
  const run = (fn: () => void) => (ready ? fn() : queued.push(fn));

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    width: Math.round(w * dpr),
    height: Math.round(h * dpr),
    backgroundColor: '#0e0d26',
    scale: { mode: Phaser.Scale.NONE, zoom: 1 / dpr },
    fps: { target: 30, limit: 30, forceSetTimeOut: false },
    render: { antialias: true, pixelArt: false, roundPixels: false, powerPreference: 'default' },
    input: { activePointers: 3, touch: { capture: true } },
    disableContextMenu: true,
    banner: false,
    audio: { noAudio: true },
    scene: [],
  });
  game.scene.add('office', scene, true, {
    hooks: {
      onSelect: o.onSelect,
      onFrame: o.onFrame,
      onUserCamera: o.onUserCamera,
      onReady: () => {
        ready = true;
        const q = queued;
        queued = [];
        q.forEach((f) => f());
        o.onReady();
      },
    },
    opts,
  });

  // Keep the canvas crisp and sized to its container.
  const ro = new ResizeObserver(() => {
    const s = size();
    game.scale.resize(Math.round(s.w * dpr), Math.round(s.h * dpr));
    game.scale.setZoom(1 / dpr);
  });
  ro.observe(parent);

  // Pause rendering when the tab is hidden or the map is scrolled out of view (docs/07 §11).
  let onScreen = true;
  const sync = () => {
    if (!game.isBooted || !game.loop.started) return;
    const awake = onScreen && document.visibilityState === 'visible';
    if (awake && !game.loop.running) game.loop.wake();
    else if (!awake && game.loop.running) game.loop.sleep();
  };
  const io = new IntersectionObserver((entries) => { onScreen = entries.some((e) => e.isIntersecting); sync(); });
  io.observe(parent);
  document.addEventListener('visibilitychange', sync);

  // Wheel over the canvas: stop page scroll only when we actually zoom.
  const canvasWheel = (e: WheelEvent) => { if (o.wheel === 'always' || e.ctrlKey || e.metaKey) e.preventDefault(); };
  parent.addEventListener('wheel', canvasWheel, { passive: false });

  return {
    setModel: (model, events) => scene.setModel(model, events),
    setNight: (night) => run(() => scene.setNight(night)),
    zoomBy: (f) => run(() => scene.zoomBy(f)),
    resetView: () => run(() => scene.resetView()),
    follow: (id) => run(() => scene.follow(id)),
    setAvatar: (on) => run(() => scene.setAvatar(on)),
    destroy: () => {
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', sync);
      parent.removeEventListener('wheel', canvasWheel);
      game.destroy(true);
    },
  };
}
