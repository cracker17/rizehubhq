// Time-of-day light for the office, from the Philippine clock (Asia/Manila): a colour wash over the
// picture and how bright the lamps glow. Keyframes are blended, so the light drifts through dawn, day,
// golden hour, dusk and night instead of flipping between two states.

export interface AmbientLight { color: number; alpha: number; lamps: number; phase: 'dawn' | 'day' | 'golden' | 'dusk' | 'night' }

/** [minute of day, colour, wash strength, lamp brightness] */
const KEYS: [number, number, number, number][] = [
  [0, 0x0b1030, 0.44, 0.58],
  [4 * 60 + 45, 0x0b1030, 0.42, 0.56],
  [5 * 60 + 40, 0x4a2f6b, 0.28, 0.4], // first light
  [6 * 60 + 30, 0xff9f6e, 0.12, 0.12], // sunrise
  [7 * 60 + 30, 0xfff3dc, 0.03, 0],
  [15 * 60 + 45, 0xfff3dc, 0.03, 0],
  [16 * 60 + 50, 0xffa857, 0.1, 0], // golden hour
  [17 * 60 + 50, 0xff7b45, 0.17, 0.12], // sunset
  [18 * 60 + 40, 0x3d2a6e, 0.3, 0.38], // dusk
  [19 * 60 + 40, 0x0b1030, 0.42, 0.56],
  [24 * 60, 0x0b1030, 0.44, 0.58],
];

const mix = (a: number, b: number, k: number) => {
  const ch = (c: number, s: number) => (c >> s) & 0xff;
  const m = (s: number) => Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * k) << s;
  return m(16) | m(8) | m(0);
};

export function manilaMinutes(d = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Manila' }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return (h % 24) * 60 + m;
}

export function ambientAt(minute: number): AmbientLight {
  const t = ((minute % 1440) + 1440) % 1440;
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1][0] <= t) i++;
  const [t0, c0, a0, l0] = KEYS[i];
  const [t1, c1, a1, l1] = KEYS[i + 1];
  const k = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
  const phase: AmbientLight['phase'] = t < 5 * 60 + 30 || t >= 19 * 60 + 20 ? 'night'
    : t < 7 * 60 ? 'dawn' : t < 16 * 60 + 30 ? 'day' : t < 18 * 60 + 10 ? 'golden' : 'dusk';
  return { color: mix(c0, c1, k), alpha: a0 + (a1 - a0) * k, lamps: l0 + (l1 - l0) * k, phase };
}

export const DAY_LIGHT = ambientAt(12 * 60);
export const NIGHT_LIGHT = ambientAt(23 * 60);
