/**
 * Procedural sound effects — everything synthesized with WebAudio, no asset files.
 * Call `initAudio()` once; the context unlocks on the first pointer/key gesture.
 * `playSfx(name)` is what gets passed to the renderer as TableViewOptions.onSfx.
 */
import type { SfxName } from '../contracts';
import { startMusic, stopMusic } from './music';

export { setMusicMode } from './music';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let sfxBus: GainNode | null = null;
let musicBus: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;

const state = { sound: true, music: false, vibration: true, musicWanted: false, suspended: false };
const lastPlayed = new Map<SfxName, number>();

export function initAudio(opts: { sound: boolean; music: boolean; vibration: boolean }): void {
  Object.assign(state, opts);
  const unlock = () => {
    ensureCtx();
    if (ctx && ctx.state === 'suspended' && !state.suspended) void ctx.resume();
    syncMusic();
  };
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock);
}

function ensureCtx(): AudioContext | null {
  if (ctx) return ctx;
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  ctx = new AC({ latencyHint: 'interactive' });
  master = ctx.createGain();
  master.gain.value = 0.9;
  // gentle glue compressor so stacked clacks don't clip
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 4;
  comp.attack.value = 0.002;
  comp.release.value = 0.15;
  master.connect(comp).connect(ctx.destination);
  sfxBus = ctx.createGain();
  sfxBus.connect(master);
  musicBus = ctx.createGain();
  musicBus.gain.value = 0.32;
  musicBus.connect(master);
  // 1s of white noise reused by every noisy sound
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return ctx;
}

export function setAudioPrefs(p: Partial<{ sound: boolean; music: boolean; vibration: boolean }>): void {
  Object.assign(state, p);
  syncMusic();
}

/** Pause/resume all audio (app hidden, game paused for music). */
export function setAudioSuspended(s: boolean): void {
  state.suspended = s;
  if (!ctx) return;
  if (s) void ctx.suspend();
  else void ctx.resume();
}

function syncMusic() {
  if (!ctx || !musicBus) return;
  if (state.music) startMusic(ctx, musicBus);
  else stopMusic();
}

// ───────────────────────── building blocks ─────────────────────────

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

function noise(t: number, dur: number, opts: { type: BiquadFilterType; freq: number; q?: number; gain: number; attack?: number; dest?: AudioNode }) {
  const c = ctx!;
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  src.playbackRate.value = rnd(0.9, 1.1);
  const f = c.createBiquadFilter();
  f.type = opts.type;
  f.frequency.value = opts.freq;
  f.Q.value = opts.q ?? 1;
  const g = c.createGain();
  const a = opts.attack ?? 0.001;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(opts.gain, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + dur);
  src.connect(f).connect(g).connect(opts.dest ?? sfxBus!);
  src.start(t, Math.random() * 0.5);
  src.stop(t + a + dur + 0.02);
}

function tone(
  t: number,
  dur: number,
  opts: { type?: OscillatorType; f0: number; f1?: number; gain: number; attack?: number; dest?: AudioNode; sweep?: number },
) {
  const c = ctx!;
  const o = c.createOscillator();
  o.type = opts.type ?? 'sine';
  o.frequency.setValueAtTime(opts.f0, t);
  if (opts.f1) o.frequency.exponentialRampToValueAtTime(opts.f1, t + (opts.sweep ?? dur));
  const g = c.createGain();
  const a = opts.attack ?? 0.002;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(opts.gain, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + dur);
  o.connect(g).connect(opts.dest ?? sfxBus!);
  o.start(t);
  o.stop(t + a + dur + 0.02);
}

/** Bone/resin tile striking a wooden table: bright click + short hollow thock + tiny bounce. */
function clack(t: number, intensity = 1) {
  const p = rnd(0.92, 1.1);
  noise(t, 0.028, { type: 'bandpass', freq: 3200 * p, q: 1.4, gain: 0.55 * intensity });
  noise(t, 0.012, { type: 'highpass', freq: 6000, gain: 0.25 * intensity });
  tone(t, 0.07, { f0: 1900 * p, f1: 1500 * p, gain: 0.12 * intensity, type: 'triangle' }); // tile body ring
  tone(t, 0.09, { f0: 240 * p, f1: 150 * p, gain: 0.38 * intensity }); // table thock
  // small settle bounce
  const b = t + rnd(0.028, 0.045);
  noise(b, 0.014, { type: 'bandpass', freq: 3600 * p, q: 2, gain: 0.16 * intensity });
}

function knock(t: number, gain = 0.6) {
  noise(t, 0.05, { type: 'lowpass', freq: 900, q: 0.8, gain: gain * 0.7 });
  tone(t, 0.11, { f0: 170, f1: 95, gain });
  noise(t, 0.01, { type: 'bandpass', freq: 2200, q: 1, gain: gain * 0.2 });
}

function clave(t: number, gain = 0.32) {
  tone(t, 0.06, { f0: 2500, gain, type: 'sine' });
  tone(t, 0.04, { f0: 5000, gain: gain * 0.25, type: 'sine' });
}

/** Marimba-ish note: sine fundamental + quick 4x partial. */
function mallet(t: number, freq: number, gain = 0.22, dur = 0.5) {
  tone(t, dur, { f0: freq, gain });
  tone(t, dur * 0.25, { f0: freq * 4, gain: gain * 0.25 });
  tone(t, dur * 0.6, { f0: freq * 2, gain: gain * 0.2, type: 'triangle' });
}

const N = (semi: number) => 261.63 * Math.pow(2, semi / 12); // semitones from C4

// ───────────────────────── public ─────────────────────────

export function playSfx(name: SfxName): void {
  if (import.meta.env.DEV) {
    const w = window as unknown as { __sfx?: Record<string, number> };
    (w.__sfx ??= {})[name] = (w.__sfx[name] ?? 0) + 1;
  }
  haptic(name);
  if (!state.sound) return;
  const c = ensureCtx();
  if (!c || c.state !== 'running' || !sfxBus || !noiseBuf) return;
  // dedupe identical sounds fired twice by different layers within 120ms
  const now = performance.now();
  if ((name === 'winHand' || name === 'loseHand' || name === 'winMatch' || name === 'loseMatch' || name === 'tranque') && now - (lastPlayed.get(name) ?? 0) < 1500) return;
  if (now - (lastPlayed.get(name) ?? 0) < 25) return;
  lastPlayed.set(name, now);

  const t = c.currentTime + 0.005;
  switch (name) {
    case 'clack':
      clack(t);
      break;
    case 'slam': {
      // a hand slamming a tile on a wooden table: heavy low body with a fast pitch drop,
      // a sharp woody crack on top, then the other tiles rattling as they land ~80 ms later
      tone(t, 0.34, { f0: 92, f1: 44, gain: 1.0, sweep: 0.14 });
      tone(t, 0.18, { f0: 150, f1: 70, gain: 0.55, type: 'triangle', sweep: 0.08 });
      noise(t, 0.22, { type: 'lowpass', freq: 320, q: 0.7, gain: 0.9 });
      noise(t, 0.035, { type: 'bandpass', freq: 1700, q: 0.9, gain: 0.95 });
      noise(t, 0.016, { type: 'highpass', freq: 5200, gain: 0.45 });
      clack(t, 1.7);
      for (let i = 0; i < 9; i++) {
        const tt = t + 0.08 + i * rnd(0.012, 0.026);
        noise(tt, 0.012, { type: 'bandpass', freq: rnd(2600, 4400), q: 2.2, gain: rnd(0.12, 0.26) * (1 - i * 0.07) });
      }
      break;
    }
    case 'charge':
      tone(t, 0.07, { f0: 420, f1: 860, gain: 0.14, sweep: 0.06, type: 'triangle' });
      break;
    case 'pass':
      knock(t);
      knock(t + 0.15, 0.5);
      break;
    case 'shuffle': {
      // "dar agua": tiles swirled face down
      noise(t, 0.9, { type: 'bandpass', freq: 1800, q: 0.6, gain: 0.06, attack: 0.25 });
      for (let i = 0; i < 26; i++) {
        const tt = t + rnd(0, 1.0);
        noise(tt, 0.012, { type: 'bandpass', freq: rnd(2600, 4200), q: 2, gain: rnd(0.08, 0.22) });
      }
      break;
    }
    case 'deal':
      noise(t, 0.09, { type: 'highpass', freq: 2500, gain: 0.08, attack: 0.03 });
      noise(t + 0.1, 0.015, { type: 'bandpass', freq: 3000, q: 2, gain: 0.18 });
      break;
    case 'select':
      tone(t, 0.06, { f0: 700, f1: 1100, gain: 0.12, sweep: 0.04 });
      noise(t, 0.008, { type: 'bandpass', freq: 4000, q: 2, gain: 0.08 });
      break;
    case 'invalid':
      tone(t, 0.09, { f0: 190, f1: 150, gain: 0.16, type: 'square' });
      tone(t + 0.1, 0.12, { f0: 160, f1: 120, gain: 0.14, type: 'square' });
      break;
    case 'winHand':
      // son clave flourish + major arpeggio
      [0, 0.12, 0.3].forEach((d) => clave(t + d));
      [0, 4, 7, 12].forEach((s, i) => mallet(t + 0.36 + i * 0.08, N(s + 12), 0.2));
      break;
    case 'loseHand':
      [7, 3, 0].forEach((s, i) => mallet(t + i * 0.14, N(s), 0.2, 0.6));
      break;
    case 'winMatch': {
      const clv = [0, 0.18, 0.36, 0.6, 0.78]; // 3-2 son clave
      clv.forEach((d) => clave(t + d));
      [0, 4, 7, 12, 16, 19, 24].forEach((s, i) => mallet(t + 0.2 + i * 0.07, N(s), 0.18));
      [0, 4, 7, 12].forEach((s) => mallet(t + 0.95, N(s), 0.14, 1.4));
      break;
    }
    case 'loseMatch':
      [12, 10, 7, 3, 0].forEach((s, i) => mallet(t + i * 0.18, N(s - 5), 0.18, 0.7));
      tone(t + 0.9, 0.9, { f0: N(-17), gain: 0.18 });
      break;
    case 'tranque':
      knock(t, 0.8);
      knock(t + 0.18, 0.8);
      knock(t + 0.36, 0.9);
      [0, 6].forEach((s) => mallet(t + 0.5, N(s - 12), 0.14, 0.8));
      break;
  }
}

/** UI button press: a soft tick. */
export function uiClick(): void {
  if (!state.sound) return;
  const c = ensureCtx();
  if (!c || c.state !== 'running' || !sfxBus) return;
  const t = c.currentTime + 0.003;
  tone(t, 0.035, { f0: 520, f1: 760, gain: 0.08, sweep: 0.02, type: 'triangle' });
}

/** a light tick (it is your turn), when vibration is enabled */
export function hapticTick(): void {
  if (!state.vibration || !('vibrate' in navigator)) return;
  try {
    navigator.vibrate(10);
  } catch {
    /* ignore */
  }
}

function haptic(name: SfxName) {
  if (!state.vibration || !('vibrate' in navigator)) return;
  const pattern: Partial<Record<SfxName, number | number[]>> = {
    clack: 12,
    slam: [90, 30, 140, 40, 70], // a slam: a strong double thump
    charge: 15,
    tranque: [20, 60, 20, 60, 40],
    winMatch: [40, 60, 40, 60, 120],
    invalid: [15, 40, 15],
  };
  const p = pattern[name];
  if (p !== undefined) {
    try {
      navigator.vibrate(p);
    } catch {
      /* ignore */
    }
  }
}
