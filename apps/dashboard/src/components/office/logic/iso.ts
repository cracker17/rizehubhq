// Isometric (2:1) projection helpers shared by the logic and the Phaser renderer.
// Tile (x, y) is a logical grid cell; +x runs screen down-right, +y runs screen down-left.

export const TW = 64; // tile width in world pixels
export const TH = 32; // tile height in world pixels

export interface Pt { x: number; y: number }

/** World pixel of logical point (x, y) at height z (pixels above the floor). */
export function isoToWorld(x: number, y: number, z: number, origin: Pt): Pt {
  return { x: origin.x + (x - y) * (TW / 2), y: origin.y + (x + y) * (TH / 2) - z };
}

/** Inverse of isoToWorld at floor height. Returns fractional tile coordinates. */
export function worldToIso(wx: number, wy: number, origin: Pt): Pt {
  const a = (wx - origin.x) / (TW / 2);
  const b = (wy - origin.y) / (TH / 2);
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

/** Painter's-order depth of a point on the floor. Larger = drawn later (in front). */
export function depthAt(x: number, y: number): number {
  return x + y;
}

/** Depth of an object whose footprint is x..x+w-1, y..y+h-1 (front-most tile centre). */
export function footprintDepth(x: number, y: number, w: number, h: number): number {
  return x + w - 0.5 + (y + h - 0.5);
}
