// Procedural semi-realistic office person drawn with Phaser Graphics from a Pose (see pose.ts).
// Local space: feet at (0, 0); the Graphics object is mirrored (scaleX = -1) for left/down facings.
import type Phaser from 'phaser';
import type { CharacterLook } from './looks';
import { shade } from './looks';
import { ik, type Pose, type V } from './pose';

type G = Phaser.GameObjects.Graphics;

const UPPER = 9.5;
const FORE = 9.5;
const THIGH = 12;
const SHIN = 12.5;
const HEAD_R = 7;

function limb(g: G, a: V, b: V, w: number, color: number) {
  g.lineStyle(w, color, 1);
  g.lineBetween(a.x, a.y, b.x, b.y);
  g.fillStyle(color, 1);
  g.fillCircle(a.x, a.y, w / 2);
  g.fillCircle(b.x, b.y, w / 2);
}

function drawLeg(g: G, hip: V, foot: V, look: CharacterLook, F: V, tone = 1) {
  const knee = ik(hip, foot, THIGH, SHIN, { x: F.x, y: F.y * 0.3 - 0.2 });
  const c = shade(look.pants, tone);
  limb(g, hip, knee, 5.4, c);
  limb(g, knee, foot, 4.6, c);
  g.fillStyle(shade(look.shoes, tone), 1);
  g.fillEllipse(foot.x + F.x * 1.6, foot.y + 0.6 + F.y * 1.2, 6.4, 3.2);
}

function sleeveBare(look: CharacterLook) {
  return look.topStyle === 'tee' || look.topStyle === 'rolled' || look.topStyle === 'apron';
}

function drawArm(g: G, shoulder: V, hand: V, look: CharacterLook, F: V, tone = 1) {
  const elbow = ik(shoulder, hand, UPPER, FORE, { x: -F.x * 0.6, y: 1 });
  const sleeve = shade(look.topStyle === 'apron' ? look.inner : look.top, tone);
  const forearm = sleeveBare(look) ? shade(look.skin, tone) : sleeve;
  limb(g, shoulder, elbow, 4.4, sleeve);
  if (look.topStyle === 'tee') {
    // short sleeve cuff
    const mid = { x: shoulder.x + (elbow.x - shoulder.x) * 0.55, y: shoulder.y + (elbow.y - shoulder.y) * 0.55 };
    limb(g, mid, elbow, 3.6, shade(look.skin, tone));
  }
  limb(g, elbow, hand, 3.8, forearm);
  g.fillStyle(shade(look.skin, tone), 1);
  g.fillCircle(hand.x, hand.y, 2.1);
}

function torsoPoly(chest: V, hip: V, wTop: number, wBot: number, extraBottom = 0): Phaser.Types.Math.Vector2Like[] {
  return [
    { x: chest.x - wTop, y: chest.y + 1.5 },
    { x: chest.x - wTop + 1.5, y: chest.y - 0.8 },
    { x: chest.x + wTop - 1.5, y: chest.y - 0.8 },
    { x: chest.x + wTop, y: chest.y + 1.5 },
    { x: hip.x + wBot, y: hip.y + 2 + extraBottom },
    { x: hip.x - wBot, y: hip.y + 2 + extraBottom },
  ];
}

function drawTorso(g: G, p: Pose, look: CharacterLook) {
  const { chest, hip, back } = p;
  const s = look.topStyle;
  const long = s === 'coat' ? 8 : s === 'hoodie' || s === 'jacket' || s === 'cardigan' ? 1.5 : 0;
  // hood behind the neck
  if (s === 'hoodie') {
    g.fillStyle(shade(look.top, 0.85), 1);
    g.fillEllipse(chest.x + (back ? 0 : -2.5), chest.y - 1.5, 10, 6);
  }
  g.fillStyle(look.top, 1);
  g.fillPoints(torsoPoly(chest, hip, 7.4, 6.2, long), true);
  // soft shading on the side away from the light
  g.fillStyle(shade(look.top, 0.84), 1);
  g.fillPoints([
    { x: chest.x + 3.5, y: chest.y - 0.6 }, { x: chest.x + 7.4, y: chest.y + 1.5 },
    { x: hip.x + 6.2, y: hip.y + 2 + long }, { x: hip.x + 3.2, y: hip.y + 2 + long },
  ], true);
  // belt line / hem
  if (s !== 'coat' && s !== 'apron') {
    g.fillStyle(shade(look.top, 0.72), 1);
    g.fillRect(hip.x - 6.2, hip.y + 0.8 + long, 12.4, 1.3);
  }
  if (back) {
    if (s === 'hoodie') { g.fillStyle(shade(look.top, 0.78), 1); g.fillEllipse(chest.x, chest.y + 2.5, 9, 5); }
    if (s === 'apron') { g.lineStyle(1, 0xe9e2d0, 1); g.lineBetween(chest.x - 5, chest.y + 9, chest.x + 5, chest.y + 9); }
    return;
  }
  // front details
  const cx = chest.x + 1.8; // front centre line sits a little forward in 3/4 view
  switch (s) {
    case 'blazer':
      g.fillStyle(look.inner, 1);
      g.fillTriangle(cx - 2.6, chest.y - 0.5, cx + 2.6, chest.y - 0.5, cx, chest.y + 9);
      g.fillStyle(shade(look.top, 0.7), 1);
      g.fillTriangle(cx - 3.4, chest.y - 0.5, cx - 0.6, chest.y + 9.5, cx - 2.8, chest.y + 3);
      g.fillTriangle(cx + 3.4, chest.y - 0.5, cx + 0.6, chest.y + 9.5, cx + 2.8, chest.y + 3);
      break;
    case 'coat':
      g.fillStyle(look.inner, 1);
      g.fillTriangle(cx - 2.4, chest.y - 0.5, cx + 2.4, chest.y - 0.5, cx, chest.y + 8);
      g.lineStyle(0.9, 0xc9d0d2, 1);
      g.lineBetween(cx, chest.y + 8, cx, hip.y + 9);
      g.fillStyle(0x9aa4a8, 1);
      g.fillRect(cx + 2.5, chest.y + 5, 3, 0.9); // pocket pen
      break;
    case 'turtleneck':
      g.fillStyle(shade(look.top, 1.25), 1);
      g.fillRoundedRect(chest.x - 2.6, chest.y - 3.6, 6.4, 4.2, 1.6);
      g.lineStyle(0.6, shade(look.top, 1.5), 0.6);
      for (let i = 0; i < 4; i++) g.lineBetween(chest.x - 4 + i * 3, chest.y + 3, chest.x - 4.5 + i * 3, hip.y);
      break;
    case 'hoodie':
      g.lineStyle(0.9, 0xf2f2f2, 0.9);
      g.lineBetween(cx - 1.2, chest.y + 0.5, cx - 1.4, chest.y + 5);
      g.lineBetween(cx + 1.2, chest.y + 0.5, cx + 1.4, chest.y + 5);
      g.fillStyle(shade(look.top, 0.8), 1);
      g.fillRoundedRect(cx - 4.5, hip.y - 5, 9, 4.2, 1.5);
      break;
    case 'jacket':
    case 'cardigan':
      g.lineStyle(1, shade(look.top, 0.6), 1);
      g.lineBetween(cx, chest.y, cx, hip.y + 2);
      g.fillStyle(look.inner, 1);
      g.fillTriangle(cx - 2.2, chest.y - 0.4, cx + 2.2, chest.y - 0.4, cx, chest.y + 5);
      break;
    case 'apron':
      g.fillStyle(0xeee6d4, 1);
      g.fillPoints([
        { x: cx - 3.8, y: chest.y + 2 }, { x: cx + 3.8, y: chest.y + 2 },
        { x: cx + 5.5, y: hip.y + 6 }, { x: cx - 5.5, y: hip.y + 6 },
      ], true);
      g.fillStyle(0xe4572e, 1); g.fillCircle(cx - 1.5, chest.y + 7, 1);
      g.fillStyle(0x2d9cdb, 1); g.fillCircle(cx + 2, chest.y + 11, 0.9);
      g.fillStyle(0xf2c14e, 1); g.fillCircle(cx - 2.5, hip.y + 2, 1.1);
      break;
    case 'shirt':
    case 'rolled':
    case 'sweater':
    case 'tee':
    default:
      g.fillStyle(shade(look.skin, 0.95), 1);
      g.fillTriangle(cx - 2, chest.y - 0.6, cx + 2, chest.y - 0.6, cx, chest.y + (s === 'tee' || s === 'sweater' ? 1.8 : 3.5));
      if (s === 'shirt' || s === 'rolled') {
        g.fillStyle(shade(look.top, 1.2), 1);
        g.fillTriangle(cx - 3, chest.y - 0.8, cx - 0.4, chest.y + 1.2, cx - 2.6, chest.y + 1.8);
        g.fillTriangle(cx + 3, chest.y - 0.8, cx + 0.4, chest.y + 1.2, cx + 2.6, chest.y + 1.8);
      }
  }
  if (look.accessories.includes('tie')) {
    g.fillStyle(0x7a1f2b, 1);
    g.fillTriangle(cx - 1, chest.y + 0.5, cx + 1, chest.y + 0.5, cx, chest.y + 10);
  }
  if (look.accessories.includes('lanyard')) {
    g.lineStyle(0.9, look.accent, 1);
    g.lineBetween(cx - 2.5, chest.y - 0.5, cx, chest.y + 8);
    g.lineBetween(cx + 2.5, chest.y - 0.5, cx, chest.y + 8);
    g.fillStyle(0xffffff, 1); g.fillRect(cx - 1.8, chest.y + 7.5, 3.6, 4.4);
    g.fillStyle(look.accent, 1); g.fillRect(cx - 1.8, chest.y + 7.5, 3.6, 1.2);
  }
}

function drawHairBack(g: G, p: Pose, look: CharacterLook) {
  const h = p.head;
  g.fillStyle(look.hair, 1);
  if (look.hairStyle === 'long') {
    if (p.back) g.fillRoundedRect(h.x - 7, h.y - 2, 14, 15, 4);
    else g.fillRoundedRect(h.x - 8, h.y - 3, 9, 15, 4);
  } else if (look.hairStyle === 'ponytail') {
    g.fillEllipse(h.x + (p.back ? 0 : -8), h.y + (p.back ? 7 : 4), 4.5, 11);
  } else if (look.hairStyle === 'bob') {
    g.fillRoundedRect(h.x - (p.back ? 7.5 : 8), h.y - 3, p.back ? 15 : 9, 10, 3);
  }
}

function drawHead(g: G, p: Pose, look: CharacterLook, time: number) {
  const h = p.head;
  const acc = look.accessories;
  // neck
  g.fillStyle(shade(look.skin, 0.9), 1);
  g.fillRect(p.chest.x - 1.8 + (p.back ? 0 : 1), p.chest.y - 4.5, 3.6, 5);
  if (p.back) {
    g.fillStyle(look.skin, 1);
    g.fillCircle(h.x, h.y, HEAD_R);
    g.fillStyle(shade(look.skin, 0.85), 1);
    g.fillCircle(h.x + 6.3, h.y + 1, 1.6); // near ear
    g.fillStyle(shade(look.skin, 0.85), 1);
    g.fillCircle(h.x - 6.6, h.y + 1, 1.4); // far ear
    g.fillStyle(look.hair, 1);
    const short = look.hairStyle === 'buzz' || look.hairStyle === 'short' || look.hairStyle === 'quiff' || look.hairStyle === 'curly' || look.hairStyle === 'bun';
    g.fillCircle(h.x - 0.3, h.y - 2.3, HEAD_R - 0.1);
    if (!short) g.fillRect(h.x - HEAD_R + 0.4, h.y - 2.4, HEAD_R * 2 - 1.6, 6.5);
    // soft highlight so dark hair still reads as a head from behind
    g.fillStyle(shade(look.hair, 1.9), 0.45);
    g.fillEllipse(h.x + 1.8, h.y - 6, 6.5, 2.6);
    hairExtras(g, p, look, true);
  } else {
    // skull + hair cap, then the face over it
    g.fillStyle(look.hairStyle === 'buzz' ? shade(look.hair, 1.25) : look.hair, 1);
    g.fillCircle(h.x - 1.1, h.y - 1.4, HEAD_R + 0.4);
    g.fillStyle(look.skin, 1);
    const faceTop = look.hairStyle === 'buzz' ? 0.2 : 1.3;
    g.fillEllipse(h.x + 1.5, h.y + faceTop, 11.4, 12 - faceTop * 0.6);
    g.fillStyle(shade(look.skin, 0.84), 1);
    g.fillEllipse(h.x - 2.3, h.y + 1.2, 2.8, 3.6); // ear
    if (acc.includes('earring')) { g.fillStyle(0xf3f3f3, 1); g.fillCircle(h.x - 2.2, h.y + 3.2, 0.7); }
    if (acc.includes('stubble')) {
      g.fillStyle(0x3a2a20, 0.2);
      g.fillEllipse(h.x + 3.2, h.y + 4.1, 8, 4.2);
    }
    // eyes
    g.fillStyle(0x241a17, 1);
    if (p.eyesClosed) {
      g.fillRect(h.x + 1.6, h.y - 0.1, 1.9, 0.6);
      g.fillRect(h.x + 4.7, h.y - 0.3, 1.7, 0.6);
    } else {
      const blink = (time * 0.37 + h.x * 0.01) % 4 < 0.08;
      if (blink) { g.fillRect(h.x + 1.6, h.y - 0.1, 1.9, 0.6); g.fillRect(h.x + 4.7, h.y - 0.3, 1.7, 0.6); }
      else { g.fillCircle(h.x + 2.5, h.y - 0.1, 0.95); g.fillCircle(h.x + 5.5, h.y - 0.3, 0.85); }
    }
    // brows
    g.fillStyle(shade(look.hair, 0.9), 1);
    g.fillRect(h.x + 1.4, h.y - 2.3, 2.4, 0.7);
    g.fillRect(h.x + 4.6, h.y - 2.5, 2, 0.7);
    // nose
    g.fillStyle(shade(look.skin, 0.8), 1);
    g.fillTriangle(h.x + 6.2, h.y + 0.2, h.x + 7.6, h.y + 2.3, h.x + 5.9, h.y + 2.4);
    // mouth
    if (p.mouth === 'open' || p.mouth === 'o') {
      g.fillStyle(0x6b2b2b, 1);
      g.fillEllipse(h.x + 4.4, h.y + 4, p.mouth === 'o' ? 1.8 : 2.6, p.mouth === 'o' ? 1.8 : 1.6);
    } else {
      g.lineStyle(0.8, 0x7a3b36, 1);
      if (p.mouth === 'smile') {
        g.beginPath(); g.arc(h.x + 4.3, h.y + 2.9, 1.8, 0.35, Math.PI - 0.35); g.strokePath();
      } else g.lineBetween(h.x + 3.3, h.y + 3.9, h.x + 5.5, h.y + 3.7);
    }
    hairExtras(g, p, look, false);
  }
  headAccessories(g, p, look);
}

function hairExtras(g: G, p: Pose, look: CharacterLook, back: boolean) {
  const h = p.head;
  g.fillStyle(look.hair, 1);
  switch (look.hairStyle) {
    case 'quiff':
      g.fillPoints([
        { x: h.x - 3, y: h.y - 6 }, { x: h.x + 1, y: h.y - 10.2 }, { x: h.x + 6.5, y: h.y - 10.5 },
        { x: h.x + 7.6, y: h.y - 6.5 }, { x: h.x + 4, y: h.y - 4.2 },
      ], true);
      g.lineStyle(0.6, shade(look.hair, 1.5), 0.8); // texture
      g.lineBetween(h.x, h.y - 8.5, h.x + 5, h.y - 9.2);
      g.lineBetween(h.x + 1, h.y - 7, h.x + 6, h.y - 7.6);
      break;
    case 'bun':
      g.fillCircle(h.x + (back ? 0 : -4), h.y - 7, 3.3);
      break;
    case 'curly':
      for (const [dx, dy] of [[-6, -3], [-4, -7], [0, -8.2], [4, -7.2], [-7, 1], [6.5, -4.5]] as const) {
        if (!back && dx > 5) continue;
        g.fillCircle(h.x + dx, h.y + dy, 2.7);
      }
      break;
    case 'short':
    case 'bob':
      if (!back) g.fillEllipse(h.x + 3.5, h.y - 5.2, 8, 3.2); // fringe
      break;
    case 'long':
    case 'ponytail':
      if (!back) g.fillEllipse(h.x + 3, h.y - 5.3, 9, 3.4);
      break;
    default:
      break;
  }
}

function headAccessories(g: G, p: Pose, look: CharacterLook) {
  const h = p.head;
  const acc = look.accessories;
  const cupX = p.back ? h.x + 6.2 : h.x - 2.3;
  if (acc.includes('beanie')) {
    g.fillStyle(shade(look.accent, 0.75), 1);
    g.fillEllipse(h.x - 0.4, h.y - 4.4, 15.6, 10.5);
    g.fillStyle(shade(look.accent, 0.6), 1);
    g.fillRect(h.x - 7.6, h.y - 3.2, 15.2, 2.6);
  }
  if (acc.includes('cap')) {
    g.fillStyle(look.accent, 1);
    g.fillEllipse(h.x - 0.3, h.y - 4.6, 15, 8.5);
    g.fillStyle(shade(look.accent, 0.7), 1);
    g.fillEllipse(h.x + 6.4, h.y - 3.4, 8, 2.6);
  }
  if (acc.includes('beret')) {
    g.fillStyle(0x2c2233, 1);
    g.fillEllipse(h.x - 1.2, h.y - 6.6, 15, 5.2);
    g.fillCircle(h.x - 1, h.y - 9.2, 1);
  }
  if (acc.includes('sunglasses')) {
    g.fillStyle(0x121216, 1);
    g.fillEllipse(h.x + 1.5, h.y - 6.8, 8, 2.4);
  }
  if (acc.includes('glasses')) {
    if (p.back) { g.lineStyle(0.8, 0x2a2a2e, 1); g.lineBetween(h.x + 6.3, h.y - 0.6, h.x + 7.2, h.y - 0.8); }
    else {
      g.lineStyle(0.8, 0x2a2a2e, 1);
      g.strokeCircle(h.x + 2.5, h.y - 0.1, 1.8);
      g.strokeCircle(h.x + 5.6, h.y - 0.3, 1.6);
      g.lineBetween(h.x - 1.5, h.y - 0.6, h.x + 0.7, h.y - 0.2);
    }
  }
  const phones = acc.includes('studio_headphones') ? 2 : acc.includes('headphones') ? 1 : 0;
  if (phones) {
    g.lineStyle(phones === 2 ? 2.4 : 1.7, 0x26262b, 1);
    g.beginPath(); g.arc(h.x - 0.3, h.y - 0.5, HEAD_R + 1.2, Math.PI * 1.05, Math.PI * 1.95); g.strokePath();
    g.fillStyle(0x26262b, 1);
    g.fillEllipse(cupX, h.y + 0.6, phones === 2 ? 5.4 : 3.8, phones === 2 ? 8 : 6);
    g.fillStyle(look.accent, 1);
    g.fillEllipse(cupX, h.y + 0.6, phones === 2 ? 2.4 : 1.6, phones === 2 ? 4 : 3);
  }
  if (acc.includes('headset')) {
    g.lineStyle(1.2, 0x2f2f35, 1);
    g.beginPath(); g.arc(h.x - 0.3, h.y - 0.5, HEAD_R + 0.9, Math.PI * 1.08, Math.PI * 1.92); g.strokePath();
    g.fillStyle(0x2f2f35, 1); g.fillEllipse(cupX, h.y + 0.8, 3, 4.6);
    if (!p.back) { g.lineStyle(0.9, 0x2f2f35, 1); g.lineBetween(cupX, h.y + 2, h.x + 4, h.y + 4.6); g.fillCircle(h.x + 4.2, h.y + 4.6, 0.9); }
  }
}

function drawItem(g: G, item: Pose['itemN'], at: V, p: Pose, time: number, accent: number) {
  if (!item) return;
  const F = p.F;
  switch (item) {
    case 'mug':
      g.fillStyle(0xf5f2ec, 1); g.fillRoundedRect(at.x - 1.2, at.y - 4.2, 3.6, 4.4, 0.8);
      g.lineStyle(0.8, 0xd9d2c6, 1); g.strokeCircle(at.x + 3, at.y - 2.2, 1.1);
      g.fillStyle(0x6b4430, 1); g.fillRect(at.x - 0.9, at.y - 4.1, 3, 0.8);
      if (p.steam) {
        for (let i = 0; i < 2; i++) {
          const k = ((time * 0.8 + i * 0.5) % 1);
          g.fillStyle(0xffffff, 0.35 * (1 - k));
          g.fillCircle(at.x + 0.6 + Math.sin(time * 3 + i) * 0.8, at.y - 5 - k * 7, 0.9 + k);
        }
      }
      break;
    case 'phone':
      g.fillStyle(0x1d1d22, 1); g.fillRoundedRect(at.x - 1.3, at.y - 4, 2.8, 4.8, 0.6);
      g.fillStyle(0x8fd3ff, 0.9); g.fillRect(at.x - 0.9, at.y - 3.5, 2, 3.6);
      break;
    case 'tablet':
      g.fillStyle(0x222228, 1); g.fillRoundedRect(at.x - 4, at.y - 5, 8.5, 6.2, 1);
      g.fillStyle(0xa9c8ff, 0.95); g.fillRect(at.x - 3.3, at.y - 4.3, 7.1, 4.8);
      g.fillStyle(accent, 1); g.fillRect(at.x - 2.8, at.y - 3.6, 3, 1);
      break;
    case 'stylus':
      g.lineStyle(1, 0x333338, 1); g.lineBetween(at.x, at.y, at.x + F.x * 3, at.y + 4.2);
      break;
    case 'marker':
      g.lineStyle(1.6, 0x2a6fdb, 1); g.lineBetween(at.x, at.y, at.x + F.x * 3, at.y - 2);
      break;
    case 'paddle':
      g.lineStyle(1.4, 0x8a5a36, 1); g.lineBetween(at.x, at.y, at.x + F.x * 2.5, at.y - 2.5);
      g.fillStyle(0xd23b3b, 1); g.fillCircle(at.x + F.x * 4.2, at.y - 4.5, 3.3);
      break;
    case 'magnifier': {
      const c = { x: at.x + F.x * 3.2, y: at.y - 3 };
      g.lineStyle(1.2, 0x3a3a40, 1); g.lineBetween(at.x, at.y, c.x - 1, c.y + 1.8);
      g.fillStyle(0xdff4ff, 0.55); g.fillCircle(c.x, c.y, 2.8);
      g.lineStyle(1, 0x3a3a40, 1); g.strokeCircle(c.x, c.y, 2.8);
      break;
    }
    case 'magazine':
      g.fillStyle(0xe8553d, 1); g.fillRect(at.x - 3.5, at.y - 5, 7, 5.5);
      g.fillStyle(0xffffff, 0.9); g.fillRect(at.x - 2.8, at.y - 4.2, 3.5, 1);
      break;
    case 'swatch':
      g.fillStyle(0xf94144, 1); g.fillRect(at.x - 1, at.y - 5, 2.4, 4.5);
      g.fillStyle(0xf9c74f, 1); g.fillRect(at.x + 1.2, at.y - 5.3, 2.4, 4.5);
      g.fillStyle(0x43aa8b, 1); g.fillRect(at.x + 3.4, at.y - 5.1, 2.4, 4.5);
      break;
    case 'clipboard':
      g.fillStyle(0x8a5a36, 1); g.fillRect(at.x - 2.8, at.y - 6, 5.6, 7.2);
      g.fillStyle(0xfafafa, 1); g.fillRect(at.x - 2.2, at.y - 5, 4.4, 5.6);
      break;
    case 'mouse':
    default:
      break;
  }
}

/** Draw the whole person. `time` drives blinks and steam. */
export function drawFigure(g: G, look: CharacterLook, p: Pose, time: number) {
  g.clear();
  // ground shadow
  g.fillStyle(0x000000, 0.2);
  g.fillEllipse(p.F.x * 3 * p.seated, 0.5, 20 + p.seated * 4, 7.5);

  const hipN = { x: p.hip.x + (p.back ? 2.4 : -2.4), y: p.hip.y };
  const hipF = { x: p.hip.x + (p.back ? -2.4 : 2.4), y: p.hip.y };
  const footN = p.crossLegs && p.seated > 0.9 ? { x: p.footF.x - 1, y: p.footF.y - 6 } : p.footN;
  const armForward = (hand: V, sh: V) => (hand.x - sh.x) * p.F.x > 2.5 && hand.y > sh.y - 6;

  if (look.accessories.includes('backpack') && !p.back) {
    g.fillStyle(shade(look.accent, 0.55), 1);
    g.fillRoundedRect(p.chest.x - 11, p.chest.y + 0.5, 6, 13, 2);
  }
  drawHairBack(g, p, look);

  if (p.back) {
    // Seen from behind: legs and forward-reaching arms are behind the torso. Seated legs are hidden
    // under the desk / chair, so they are only drawn while standing or mid sit-down.
    if (p.seated < 0.6) {
      drawLeg(g, hipF, p.footF, look, p.F, 0.85);
      drawLeg(g, hipN, footN, look, p.F);
    }
    const nFwd = armForward(p.handN, p.shoulderN);
    const fFwd = armForward(p.handF, p.shoulderF);
    drawArm(g, p.shoulderF, p.handF, look, p.F, 0.85);
    drawItem(g, p.itemF, p.handF, p, time, look.accent);
    if (nFwd) { drawArm(g, p.shoulderN, p.handN, look, p.F); drawItem(g, p.itemN, p.handN, p, time, look.accent); }
    drawTorso(g, p, look);
    if (look.accessories.includes('backpack')) {
      g.fillStyle(shade(look.accent, 0.55), 1);
      g.fillRoundedRect(p.chest.x - 5.5, p.chest.y + 1.5, 11, 12, 3);
      g.fillStyle(shade(look.accent, 0.45), 1);
      g.fillRoundedRect(p.chest.x - 4, p.chest.y + 7, 8, 5, 2);
    }
    drawHead(g, p, look, time);
    if (!nFwd) { drawArm(g, p.shoulderN, p.handN, look, p.F); drawItem(g, p.itemN, p.handN, p, time, look.accent); }
    if (fFwd && p.itemF) drawItem(g, p.itemF, p.handF, p, time, look.accent);
    return;
  }

  const seatedFront = p.seated > 0.5;
  if (!seatedFront) {
    drawLeg(g, hipF, p.footF, look, p.F, 0.85);
    drawLeg(g, hipN, footN, look, p.F);
  }
  drawArm(g, p.shoulderF, p.handF, look, p.F, 0.85);
  drawItem(g, p.itemF, p.handF, p, time, look.accent);
  drawTorso(g, p, look);
  if (seatedFront) {
    drawLeg(g, hipF, p.footF, look, p.F, 0.85);
    drawLeg(g, hipN, footN, look, p.F);
  }
  drawHead(g, p, look, time);
  drawArm(g, p.shoulderN, p.handN, look, p.F);
  drawItem(g, p.itemN, p.handN, p, time, look.accent);
}
