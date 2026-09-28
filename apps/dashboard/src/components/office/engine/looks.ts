// Character looks (docs/07 §9): one consistent semi-realistic office style with a signature look per role.
import { hashString } from '../logic/rng';

export type HairStyle = 'short' | 'quiff' | 'long' | 'bun' | 'curly' | 'buzz' | 'bob' | 'ponytail';
export type TopStyle = 'shirt' | 'rolled' | 'blazer' | 'hoodie' | 'coat' | 'turtleneck' | 'jacket' | 'apron' | 'tee' | 'cardigan' | 'sweater';
export type Accessory =
  | 'headphones' | 'studio_headphones' | 'headset' | 'beret' | 'cap' | 'beanie' | 'glasses' | 'sunglasses'
  | 'lanyard' | 'tie' | 'backpack' | 'stubble' | 'earring';

export interface CharacterLook {
  skin: number;
  hair: number;
  hairStyle: HairStyle;
  top: number;
  topStyle: TopStyle;
  inner: number;
  pants: number;
  shoes: number;
  accessories: Accessory[];
  accent: number;
  /** Item carried in idle hands when it suits the role (tablet, clipboard, phone…). */
  prop?: 'tablet' | 'clipboard' | 'phone';
}

const SKINS = [0xf2cda9, 0xe3b08a, 0xc98e66, 0xad7550, 0x8d5a3a, 0x6e432b];
const HAIRS = [0x3a2619, 0x4a3223, 0x6b442c, 0x2b2728, 0x875331, 0xb07b43, 0x3d2e27];
const PANTS = [0x2e3440, 0x3b4252, 0x4a4036, 0x283548, 0x55504a];

export const hexToNum = (hex: string) => parseInt(hex.replace('#', ''), 16);

/** Mix a colour towards grey for a softer, more realistic fabric tone. */
export function soften(c: number, amount = 0.2): number {
  const r = (c >> 16) & 255;
  const g = (c >> 8) & 255;
  const b = c & 255;
  const grey = (r + g + b) / 3;
  const mix = (v: number) => Math.round(v + (grey - v) * amount);
  return (mix(r) << 16) | (mix(g) << 8) | mix(b);
}

export function shade(c: number, f: number): number {
  const r = (c >> 16) & 255;
  const g = (c >> 8) & 255;
  const b = c & 255;
  const s = (v: number) => Math.max(0, Math.min(255, Math.round(f >= 1 ? v + (255 - v) * (f - 1) : v * f)));
  return (s(r) << 16) | (s(g) << 8) | s(b);
}

type Spec = Partial<CharacterLook> & { topStyle: TopStyle; hairStyle?: HairStyle; accessories: Accessory[] };

const ROLE: Record<string, Spec> = {
  coo: { topStyle: 'blazer', hairStyle: 'short', accessories: [], prop: 'tablet', inner: 0xf3f1ea },
  'web-dev': { topStyle: 'hoodie', hairStyle: 'quiff', accessories: ['headphones'] },
  designer: { topStyle: 'sweater', hairStyle: 'bob', accessories: ['earring'] },
  writer: { topStyle: 'cardigan', hairStyle: 'long', accessories: ['glasses'] },
  sales: { topStyle: 'rolled', hairStyle: 'short', accessories: ['headset'], prop: 'phone' },
  'qa-lead': { topStyle: 'jacket', hairStyle: 'bun', accessories: ['glasses'], prop: 'clipboard' },
};

export function lookFor(agentId: string, color: string): CharacterLook {
  const h = hashString(agentId);
  const spec = ROLE[agentId] ?? { topStyle: 'shirt', accessories: [] };
  const base = soften(hexToNum(color), 0.18);
  return {
    skin: SKINS[h % SKINS.length],
    hair: HAIRS[(h >> 3) % HAIRS.length],
    hairStyle: spec.hairStyle ?? 'short',
    top: spec.topStyle === 'coat' ? 0xf4f6f6 : base,
    topStyle: spec.topStyle,
    inner: spec.inner ?? (spec.topStyle === 'coat' ? base : spec.topStyle === 'apron' ? base : shade(base, 1.35)),
    pants: PANTS[(h >> 5) % PANTS.length],
    shoes: (h >> 7) % 3 === 0 ? 0xeeeeea : 0x2b2622,
    accessories: spec.accessories,
    accent: base,
    prop: spec.prop,
  };
}

/** Julev (CEO): dark-brown textured quiff, light stubble, stud earring, black turtleneck, charcoal trousers, white sneakers. */
export const CEO_LOOK: CharacterLook = {
  skin: 0xc99670,
  hair: 0x3a2618,
  hairStyle: 'quiff',
  top: 0x17171a,
  topStyle: 'turtleneck',
  inner: 0x17171a,
  pants: 0x3a3d42,
  shoes: 0xf4f4f0,
  accessories: ['stubble', 'earring'],
  accent: 0x6d4aff,
};
