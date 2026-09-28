// Office sound: door swings and a quiet generative lo-fi loop to work to, all synthesised with WebAudio
// (no audio files). Browsers only allow sound after a click or key press, so nothing plays until the
// first interaction; the music toggle is remembered per browser.

type Voice = { stop: (t: number) => void };

const PREF = 'rizehub-hq:music';
// Fmaj7 – Em7 – Dm7 – Cmaj7 (+9ths), a classic lo-fi loop; MIDI notes.
const CHORDS = [
  [53, 57, 60, 64, 67], // F A C E G
  [52, 55, 59, 62, 66], // E G B D F#
  [50, 53, 57, 60, 64], // D F A C E
  [48, 52, 55, 59, 62], // C E G B D
];
const BASS = [41, 40, 38, 36];
const MELODY = [72, 74, 76, 79, 81, 79, 76, 74];
const hz = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

class OfficeAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private music!: GainNode;
  private sfx!: GainNode;
  private lp!: BiquadFilterNode;
  private noise: AudioBuffer | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextBeat = 0;
  private beat = 0;
  private crackle: AudioBufferSourceNode | null = null;
  private listeners = new Set<(on: boolean) => void>();
  musicOn = true;
  private unlocked = false;

  constructor() {
    if (typeof window === 'undefined') return;
    try { const v = window.localStorage.getItem(PREF); if (v !== null) this.musicOn = v === '1'; } catch { /* storage blocked */ }
  }

  /** Call once from the page: starts audio on the first user gesture. */
  arm() {
    if (typeof window === 'undefined' || this.unlocked) return;
    const go = () => {
      this.unlocked = true;
      window.removeEventListener('pointerdown', go);
      window.removeEventListener('keydown', go);
      this.ensure();
      if (this.musicOn) this.startMusic();
    };
    window.addEventListener('pointerdown', go);
    window.addEventListener('keydown', go);
  }

  onChange(fn: (on: boolean) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }

  setMusic(on: boolean) {
    this.musicOn = on;
    try { window.localStorage.setItem(PREF, on ? '1' : '0'); } catch { /* ignore */ }
    this.listeners.forEach((f) => f(on));
    if (!this.unlocked) return;
    this.ensure();
    if (on) this.startMusic(); else this.stopMusic();
  }

  private ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume(); return; }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain(); this.master.gain.value = 0.9; this.master.connect(ctx.destination);
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 2600; this.lp.Q.value = 0.4;
    this.music = ctx.createGain(); this.music.gain.value = 0; this.music.connect(this.lp); this.lp.connect(this.master);
    this.sfx = ctx.createGain(); this.sfx.gain.value = 0.55; this.sfx.connect(this.master);
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  // ------------------------------------------------------------------ doors
  door(kind: 'glass' | 'wood', opening: boolean) {
    const ctx = this.ctx;
    if (!ctx || !this.noise || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    // air "whoosh": band-passed noise sweeping
    const src = ctx.createBufferSource(); src.buffer = this.noise;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.9;
    bp.frequency.setValueAtTime(opening ? 500 : 1400, t);
    bp.frequency.exponentialRampToValueAtTime(opening ? 1600 : 450, t + 0.45);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(kind === 'glass' ? 0.16 : 0.12, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    src.connect(bp).connect(g).connect(this.sfx);
    src.start(t, Math.random()); src.stop(t + 0.55);
    // latch / close click (glass: bright tick; wood: soft thud)
    const at = opening ? t + 0.02 : t + 0.42;
    const o = ctx.createOscillator(); o.type = kind === 'glass' ? 'triangle' : 'sine';
    o.frequency.setValueAtTime(kind === 'glass' ? 2400 : 140, at);
    o.frequency.exponentialRampToValueAtTime(kind === 'glass' ? 900 : 70, at + 0.06);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, at);
    og.gain.exponentialRampToValueAtTime(kind === 'glass' ? 0.08 : 0.22, at + 0.005);
    og.gain.exponentialRampToValueAtTime(0.0001, at + (kind === 'glass' ? 0.08 : 0.14));
    o.connect(og).connect(this.sfx);
    o.start(at); o.stop(at + 0.2);
  }

  // ------------------------------------------------------------------ music
  private startMusic() {
    const ctx = this.ctx;
    if (!ctx || this.timer) return;
    this.music.gain.cancelScheduledValues(ctx.currentTime);
    this.music.gain.setTargetAtTime(0.32, ctx.currentTime, 1.2);
    this.nextBeat = ctx.currentTime + 0.1;
    this.beat = 0;
    this.timer = setInterval(() => this.schedule(), 120);
    this.startCrackle();
  }

  private stopMusic() {
    const ctx = this.ctx;
    if (!ctx) return;
    this.music.gain.setTargetAtTime(0, ctx.currentTime, 0.4);
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const c = this.crackle; this.crackle = null;
    if (c) setTimeout(() => { try { c.stop(); } catch { /* ignore */ } }, 1500);
  }

  private startCrackle() {
    const ctx = this.ctx!;
    const len = ctx.sampleRate * 3;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() < 0.0009 ? (Math.random() * 2 - 1) * 0.6 : (Math.random() * 2 - 1) * 0.012;
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1200;
    const g = ctx.createGain(); g.gain.value = 0.35;
    src.connect(hp).connect(g).connect(this.music);
    src.start();
    this.crackle = src;
  }

  /** Look-ahead scheduler: 72 bpm, swung eighths, 4 beats per chord. */
  private schedule() {
    const ctx = this.ctx;
    if (!ctx) return;
    const spb = 60 / 72;
    while (this.nextBeat < ctx.currentTime + 0.6) {
      const t = this.nextBeat;
      const b = this.beat;
      const bar = Math.floor(b / 4) % CHORDS.length;
      const inBar = b % 4;
      if (inBar === 0) {
        CHORDS[bar].forEach((n, i) => this.keys(hz(n), t + i * 0.018, spb * 3.8, 0.05));
        this.bass(hz(BASS[bar]), t, spb * 1.6);
      }
      if (inBar === 2) this.bass(hz(BASS[bar] + 7), t + spb * 0.5, spb * 0.9);
      // drums: kick 1 & 3 (+ a ghost), snare 2 & 4, swung hats
      if (inBar === 0 || inBar === 2) this.kick(t);
      if (inBar === 2 && b % 8 === 6) this.kick(t + spb * 0.75, 0.5);
      if (inBar === 1 || inBar === 3) this.snare(t);
      this.hat(t, 0.5); this.hat(t + spb * 0.62, 0.3);
      // a sparse melody line, different each time round
      if (Math.random() < 0.38) {
        const n = MELODY[Math.floor(Math.random() * MELODY.length)] - (bar === 1 ? 1 : 0);
        this.keys(hz(n), t + (Math.random() < 0.5 ? 0 : spb * 0.62), spb * 1.2, 0.035);
      }
      this.nextBeat += spb;
      this.beat++;
    }
  }

  private keys(f: number, t: number, dur: number, vol: number): Voice {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.03);
    g.gain.exponentialRampToValueAtTime(vol * 0.45, t + 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1800;
    lp.connect(g).connect(this.music);
    const oscs = [0, 7, -6].map((cents, i) => {
      const o = ctx.createOscillator();
      o.type = i === 0 ? 'triangle' : 'sine';
      o.frequency.value = f * (i === 2 ? 2 : 1);
      o.detune.value = cents;
      const og = ctx.createGain(); og.gain.value = i === 2 ? 0.15 : 0.5;
      o.connect(og).connect(lp);
      o.start(t); o.stop(t + dur + 0.05);
      return o;
    });
    return { stop: (s) => oscs.forEach((o) => o.stop(s)) };
  }

  private bass(f: number, t: number, dur: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.music);
    o.start(t); o.stop(t + dur + 0.05);
  }

  private kick(t: number, v = 1) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.28 * v, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g).connect(this.music); o.start(t); o.stop(t + 0.32);
  }

  private snare(t: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource(); src.buffer = this.noise;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.09, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    src.connect(bp).connect(g).connect(this.music); src.start(t, Math.random()); src.stop(t + 0.2);
  }

  private hat(t: number, v: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource(); src.buffer = this.noise;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.035 * v, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    src.connect(hp).connect(g).connect(this.music); src.start(t, Math.random()); src.stop(t + 0.06);
  }
}

export const officeAudio = new OfficeAudio();
