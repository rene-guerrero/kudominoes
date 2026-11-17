/**
 * Subtle generative background loop: a laid-back son montuno (tres-like plucks, tumbao bass,
 * soft 2-3 clave) over I–IV–V–IV, with small random variations every bar. Pure WebAudio.
 */
let timer: number | null = null;
let out: GainNode | null = null;
let nextTime = 0;
let step = 0;

const BPM = 92;
const S16 = 60 / BPM / 4; // sixteenth note
const ROOT = 196; // G3
const f = (semi: number) => ROOT * Math.pow(2, semi / 12);
// I IV V IV in G: G C D C (semitones from G)
const PROG = [
  { root: 0, chord: [0, 4, 7] },
  { root: 5, chord: [5, 9, 12] },
  { root: 7, chord: [7, 11, 14] },
  { root: 5, chord: [5, 9, 12] },
];
// montuno rhythm on 8th-note grid (16 per bar of 16ths -> use even steps), 1 = play
const MONTUNO = [1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0];
const CLAVE_23 = [0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0];

function pluck(ctx: AudioContext, t: number, freq: number, gain: number, dur = 0.28) {
  const o = ctx.createOscillator();
  o.type = 'triangle';
  o.frequency.value = freq;
  const o2 = ctx.createOscillator(); // doubled string, slightly detuned (tres has paired courses)
  o2.type = 'triangle';
  o2.frequency.value = freq * 2.003;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(3200, t);
  lp.frequency.exponentialRampToValueAtTime(600, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  const g2 = ctx.createGain();
  g2.gain.value = 0.35;
  o.connect(lp);
  o2.connect(g2).connect(lp);
  lp.connect(g).connect(out!);
  o.start(t);
  o2.start(t);
  o.stop(t + dur + 0.02);
  o2.stop(t + dur + 0.02);
}

function bass(ctx: AudioContext, t: number, freq: number) {
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
  o.connect(g).connect(out!);
  o.start(t);
  o.stop(t + 0.55);
}

function clave(ctx: AudioContext, t: number) {
  const o = ctx.createOscillator();
  o.frequency.value = 2400;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.08, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  o.connect(g).connect(out!);
  o.start(t);
  o.stop(t + 0.07);
}

function schedule(ctx: AudioContext) {
  while (nextTime < ctx.currentTime + 0.25) {
    const bar = Math.floor(step / 16) % PROG.length;
    const s = step % 16;
    const { root, chord } = PROG[bar];
    const swing = s % 2 === 1 ? S16 * 0.12 : 0;
    const t = nextTime + swing;
    if (MONTUNO[s] && Math.random() > 0.08) {
      const i = (s + Math.floor(step / 32)) % chord.length;
      const note = chord[i] + (Math.random() < 0.15 ? 12 : 0);
      pluck(ctx, t, f(note + 12), 0.07 + Math.random() * 0.02);
      if (s === 0 || s === 8) pluck(ctx, t, f(chord[(i + 1) % 3] + 12), 0.04);
    }
    // tumbao: "and" of 2 (s=6) and beat 4 (s=12), anticipating next chord
    if (s === 6) bass(ctx, t, f(root - 12) / 2);
    if (s === 12) bass(ctx, t, f(PROG[(bar + 1) % PROG.length].root - 12) / 2);
    const cs = step % 32;
    if (CLAVE_23[cs]) clave(ctx, t);
    nextTime += S16;
    step++;
  }
}

export function startMusic(ctx: AudioContext, dest: AudioNode): void {
  if (timer !== null) return;
  out = ctx.createGain();
  out.gain.setValueAtTime(0.0001, ctx.currentTime);
  out.gain.exponentialRampToValueAtTime(0.8, ctx.currentTime + 2);
  out.connect(dest);
  nextTime = ctx.currentTime + 0.1;
  step = 0;
  timer = window.setInterval(() => schedule(ctx), 90);
}

export function stopMusic(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
  const o = out;
  if (o) {
    const c = o.context;
    o.gain.cancelScheduledValues(c.currentTime);
    o.gain.setValueAtTime(o.gain.value, c.currentTime);
    o.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.4);
    setTimeout(() => o.disconnect(), 600);
  }
  out = null;
}
