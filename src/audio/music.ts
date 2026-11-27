/**
 * Kudominoes music: two generative pieces in one module. Pure WebAudio (oscillators and noise),
 * no asset files, original material only.
 *
 * `setMusicMode('menu')`: "Farolas", the title theme. A night-time habanera in D minor at 80 BPM
 * with a half-time lo-fi feel: soft keys and pad, a bass that walks the habanera cell, a soft kick
 * on 1 and the tresillo push, a brush on 4, and a bell-like key playing an 8-bar hook with a
 * dotted-eighth echo. After a 2-bar intro its 8-bar sections go hook / hook an octave up /
 * relative major with small answering fills, varying the comping, drums and bass.
 *
 * `setMusicMode('game')`: "Son con ganas", the table music. A son in F major (the relative major
 * of the menu's D minor) at 98 BPM: tres guajeos in one register, tumbao bass, a full conga
 * tumbao, maracas, the 2-3 clave as a low wood, flute phrases improvised on the chord with rests
 * between them. Sections are full / peak (adds a soft campana and bongo), 8 bars each, or a
 * 4-bar light one; each picks two of six progressions and ends in a conga fill, so nothing loops
 * literally. It enters with two bars of bass and percussion while the menu's tail fades.
 *
 * Each piece is `{ setup(kit) -> state, step(state, kit, n, t) }`, `step` being called once per
 * 16th note, and plays through its own bus. A mode change lands on the sounding piece's next
 * bar line (half bar for the menu, so a match never waits long): the old piece stops scheduling
 * there and its bus fades, the new one starts on that same line. The mode is remembered while
 * the music is off.
 *
 * Scheduling runs 0.3 s ahead of the context clock. A suspended context freezes that clock, so
 * resuming continues where it stopped; a throttled timer skips ahead instead of bursting. Every
 * source is stopped at a fixed time, so the node count stays bounded.
 */
export type MusicMode = 'menu' | 'game';

// ───────────────────────── shared helpers ─────────────────────────

type Quality = 'maj' | 'min' | 'dom' | 'domb9' | 'hdim';
type Chord = [root: number, q: Quality];
/** [16th step, midi, seconds] */
type Note = [number, number, number];

const rnd = Math.random;
const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
/** fold a pitch into [lo, lo + 12) */
const fold = (m: number, lo: number) => lo + ((((m - lo) % 12) + 12) % 12);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
/** chord tones folded into one octave above `lo`, ascending */
const voice = (rootM: number, ints: readonly number[], lo: number) => ints.map((i) => fold(rootM + i, lo)).sort((a, b) => a - b);

const TRIAD: Record<Quality, number[]> = { maj: [0, 4, 7], min: [0, 3, 7], dom: [0, 4, 7], domb9: [0, 4, 7], hdim: [0, 3, 6] };
/** five-note scale a lead may use over each chord quality */
const PENT: Record<Quality, number[]> = { maj: [0, 2, 4, 7, 9], min: [0, 3, 5, 7, 10], dom: [0, 2, 4, 7, 10], domb9: [0, 2, 4, 7, 10], hdim: [0, 3, 5, 6, 10] };
/** rhythms (16th steps inside one bar) for the improvised one-bar lead phrases */
const PHRASE_RHYTHMS = [[0, 4, 6, 8], [2, 4, 8], [0, 6, 8, 12], [4, 6, 10, 12], [0, 2, 4, 10], [6, 8, 12], [0, 4, 10]];

/** A short stepwise phrase over one chord, ending on a chord tone that rings. */
function makePhrase(rootM: number, q: Quality, lo: number, hi: number, s16: number): Note[] {
  const pent = PENT[q];
  const tri = TRIAD[q];
  const pc = (m: number) => (((m - rootM) % 12) + 12) % 12;
  const scale: number[] = [];
  for (let m = lo; m <= hi; m++) if (pent.includes(pc(m))) scale.push(m);
  const rhythm = pick(PHRASE_RHYTHMS);
  let i = 1 + Math.floor(rnd() * (scale.length - 2));
  return rhythm.map((st, j): Note => {
    if (j) i = clamp(i + pick([-2, -1, -1, 1, 1, 2]), 0, scale.length - 1);
    const last = j === rhythm.length - 1;
    if (last) {
      // settle on the nearest chord tone
      for (let d = 0; d < scale.length; d++) {
        if (scale[i - d] !== undefined && tri.includes(pc(scale[i - d]))) { i -= d; break; }
        if (scale[i + d] !== undefined && tri.includes(pc(scale[i + d]))) { i += d; break; }
      }
    }
    return [st, scale[i], last ? 6 * s16 + 0.3 : (rhythm[j + 1] - st) * s16 + 0.1];
  });
}

let noiseBuf: AudioBuffer | null = null;

/** The voices of one piece, all feeding its own output bus. */
function makeKit(ctx: AudioContext, dest: AudioNode) {
  const out = ctx.createGain();
  out.connect(dest);
  if (!noiseBuf || noiseBuf.sampleRate !== ctx.sampleRate) {
    noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = rnd() * 2 - 1;
  }
  const filter = (type: BiquadFilterType, freq: number, q: number, to: AudioNode = out) => {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    if (q) f.Q.value = q;
    f.connect(to);
    return f;
  };

  const k = {
    out,
    lp: (freq: number) => filter('lowpass', freq, 0),
    hp: (freq: number) => filter('highpass', freq, 0),
    bp: (freq: number, q: number) => filter('bandpass', freq, q),
    bus(): GainNode {
      const g = ctx.createGain();
      g.connect(out);
      return g;
    },
    /** feedback delay; returns its input (send a bus to it for a soft repeat) */
    echo(time: number, fb: number, wet: number): GainNode {
      const inp = ctx.createGain();
      inp.gain.value = wet;
      const d = ctx.createDelay(1);
      d.delayTime.value = time;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 1800;
      const g = ctx.createGain();
      g.gain.value = fb;
      inp.connect(d);
      d.connect(f);
      f.connect(out);
      f.connect(g);
      g.connect(d);
      return inp;
    },
    /** one enveloped oscillator, percussive shape (fast attack, exponential decay) */
    tone(to: AudioNode, t: number, freq: number, type: OscillatorType, peak: number, attack: number, dur: number) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(to);
      o.start(t);
      o.stop(t + dur + 0.02);
    },
    /** sustained shape: soft attack, held, released */
    sus(to: AudioNode, t: number, freq: number, type: OscillatorType, peak: number, attack: number, dur: number, release: number) {
      const hold = Math.max(attack + 0.01, dur);
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + attack);
      g.gain.linearRampToValueAtTime(peak * 0.7, t + hold);
      g.gain.linearRampToValueAtTime(0, t + hold + release);
      o.connect(g).connect(to);
      o.start(t);
      o.stop(t + hold + release + 0.02);
    },
    /** plucked string: triangle through a closing low-pass; `oct` adds the tres' octave course */
    pluck(to: AudioNode, t: number, freq: number, peak: number, dur: number, bright: number, oct: number) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(bright, t);
      lp.frequency.exponentialRampToValueAtTime(Math.max(500, freq), t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = freq;
      o.connect(lp);
      if (oct > 0) {
        const o2 = ctx.createOscillator();
        o2.type = 'triangle';
        o2.frequency.value = freq * 2.003;
        const g2 = ctx.createGain();
        g2.gain.value = oct;
        o2.connect(g2).connect(lp);
        o2.start(t);
        o2.stop(t + dur + 0.02);
      }
      lp.connect(g).connect(to);
      o.start(t);
      o.stop(t + dur + 0.02);
    },
    /** round bass: a sine plus quiet harmonics (`h2`, `h3`) so phone speakers still carry it */
    bass(t: number, m: number, peak: number, dur: number, h2 = 0.2, h3 = 0) {
      k.tone(out, t, hz(m), 'sine', peak, 0.015, dur);
      k.tone(out, t, hz(m) * 2, 'sine', peak * h2, 0.012, dur * 0.7);
      if (h3) k.tone(out, t, hz(m) * 3, 'sine', peak * h3, 0.01, dur * 0.4);
    },
    /** breathy wind lead */
    flute(to: AudioNode, t: number, freq: number, peak: number, dur: number) {
      k.sus(to, t, freq, 'sine', peak, 0.06, dur * 0.85, 0.25);
      k.sus(to, t, freq * 2, 'sine', peak * 0.1, 0.06, dur * 0.85, 0.2);
    },
    /** noise burst (maracas, brushes, slaps): send it to a high-pass or band-pass bus */
    shake(to: AudioNode, t: number, peak: number, dur: number) {
      const s = ctx.createBufferSource();
      s.buffer = noiseBuf;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(g).connect(to);
      s.start(t, rnd() * 0.2, dur + 0.02);
    },
    /** skin drum: a sine whose pitch falls (bongo, conga, soft kick) */
    drum(t: number, f0: number, f1: number, peak: number, dur: number) {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.6);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + dur + 0.02);
    },
  };
  return k;
}
type Kit = ReturnType<typeof makeKit>;

interface Song<S> {
  bpm: number;
  /** trim of the piece's own bus */
  level: number;
  /** 16ths between the points where the piece may hand over (a bar, or half a bar) */
  yieldEvery: number;
  setup(k: Kit): S;
  step(S: S, k: Kit, n: number, t: number): void;
}

// ───────────────────────── menu: "Farolas" ─────────────────────────

const M_S16 = 60 / 80 / 4;
const M_KEY = 50; // D3
/** rootless colour voicings for the keys and the pad */
const M_COL: Record<Quality, number[]> = { maj: [4, 7, 11, 14], min: [3, 7, 10, 14], dom: [4, 10, 14], domb9: [4, 10, 13], hdim: [3, 6, 10] };
// chords per half bar: [semitones above D, quality]
const M_HOME: Chord[] = [[0, 'min'], [0, 'min'], [5, 'min'], [5, 'min'], [7, 'domb9'], [7, 'domb9'], [0, 'min'], [0, 'min'],
  [8, 'maj'], [8, 'maj'], [5, 'min'], [5, 'min'], [2, 'hdim'], [7, 'domb9'], [0, 'min'], [0, 'min']]; // Dm Gm A7 Dm | Bb Gm Em7b5-A7 Dm
const M_REL: Chord[] = [[3, 'maj'], [3, 'maj'], [10, 'dom'], [10, 'dom'], [8, 'maj'], [8, 'maj'], [7, 'domb9'], [7, 'domb9'],
  [3, 'maj'], [3, 'maj'], [10, 'dom'], [10, 'dom'], [5, 'min'], [5, 'min'], [7, 'domb9'], [7, 'domb9']]; // F C Bb A7 | F C Gm A7
const M_INTRO: Chord[] = [[0, 'min']];
const M_COMPS = [[0, 6, 12], [3, 6, 11], [0, 10]];
/** the hook: [16th step in the 8 bars, midi, beats] */
const M_HOOK = [
  [0, 69, 1.5], [6, 74, 0.5], [8, 77, 1], [12, 76, 0.5], [14, 74, 2], [20, 67, 0.5], [22, 70, 0.5], [24, 74, 2],
  [32, 76, 1.5], [38, 73, 0.5], [40, 76, 1], [44, 79, 0.5], [46, 77, 2], [54, 76, 0.5], [56, 74, 2.5],
  [64, 74, 1.5], [70, 77, 0.5], [72, 81, 1], [76, 79, 0.5], [78, 77, 2], [84, 70, 0.5], [86, 74, 0.5], [88, 79, 2],
  [96, 76, 1.5], [102, 74, 0.5], [104, 73, 1], [108, 76, 0.5], [110, 74, 2.5],
];

type MenuType = 'intro' | 'H' | 'H2' | 'R';
interface MenuState {
  count: number;
  last: MenuType;
  secStart: number;
  secEnd: number;
  sec: { prog: Chord[]; comp: number[]; drums: boolean; hab: boolean; hook: boolean; up: boolean; fills: boolean };
  pad: AudioNode;
  ep: AudioNode;
  shk: AudioNode;
  brush: AudioNode;
  lead: AudioNode;
}

function menuNext(S: MenuState, n: number) {
  let type: MenuType;
  if (S.count === 0) type = 'intro';
  else if (S.count === 1) type = 'H';
  else if (S.last === 'R') type = 'H';
  else if (S.last === 'H2') type = 'R';
  else type = rnd() < 0.55 ? 'H2' : 'R';
  S.count++;
  S.last = type;
  S.secStart = n;
  S.secEnd = n + (type === 'intro' ? 2 : 8) * 16;
  S.sec = {
    prog: type === 'intro' ? M_INTRO : type === 'R' ? M_REL : M_HOME,
    comp: type === 'intro' ? [0] : pick(M_COMPS),
    drums: type !== 'intro' && !(type === 'H2' && rnd() < 0.3), // an occasional breakdown
    hab: type !== 'intro' && rnd() < 0.7,
    hook: type === 'H' || type === 'H2',
    up: type === 'H2',
    fills: type === 'R',
  };
}

function bell(k: Kit, to: AudioNode, t: number, m: number, v: number, dur: number) {
  k.tone(to, t, hz(m), 'sine', v, 0.008, Math.max(0.8, dur * 1.5));
  k.tone(to, t, hz(m) * 2, 'sine', v * 0.12, 0.006, 0.5);
  k.tone(to, t, hz(m) * 3, 'sine', v * 0.05, 0.004, 0.3);
}

const MENU: Song<MenuState> = {
  bpm: 80,
  level: 1.15,
  yieldEvery: 8,
  setup(k) {
    const lead = k.bus();
    lead.connect(k.echo(3 * M_S16, 0.3, 0.35));
    return {
      count: 0, last: 'intro', secStart: 0, secEnd: 0,
      sec: { prog: M_INTRO, comp: [0], drums: false, hab: false, hook: false, up: false, fills: false },
      pad: k.lp(900), ep: k.lp(1300), shk: k.hp(6500), brush: k.bp(2000, 0.7), lead,
    };
  },
  step(S, k, n, t) {
    if (n >= S.secEnd) menuNext(S, n);
    const sec = S.sec;
    const ls = n - S.secStart;
    const bar = ls >> 4;
    const s = ls & 15;
    const half = ls >> 3;
    const P = sec.prog;
    const [root, q] = P[half % P.length];
    const rootM = M_KEY + root;
    const th = t + (s % 2 ? M_S16 * 0.1 : 0) + rnd() * 0.007; // a touch of swing

    // pad swell on every half bar
    if (s % 8 === 0) for (const m of voice(rootM, M_COL[q], 55).slice(0, 3)) k.sus(S.pad, th, hz(m), 'sawtooth', 0.012, 0.4, 8 * M_S16, 0.6);

    // soft keys
    if (sec.comp.includes(s) && (s === 0 || rnd() > 0.1)) {
      const v = 0.032 + rnd() * 0.008;
      for (const m of voice(rootM, M_COL[q], 58)) k.tone(S.ep, th, hz(m), 'triangle', v, 0.015, s === 0 ? 1.2 : 0.6);
    }

    // bass: the habanera cell in the first half of the bar, a long note in the second
    const bm = (m: number) => fold(m, 38);
    if (s === 0) k.bass(th, bm(rootM), 0.26, sec.hab ? 0.5 : 1.1);
    else if (s === 8) k.bass(th, bm(rootM), 0.22, 0.9);
    else if (sec.hab && s === 3) k.bass(th, bm(rootM + 7), 0.12, 0.2);
    else if (sec.hab && s === 4) k.bass(th, bm(rootM), 0.17, 0.3);
    else if (sec.hab && s === 6) k.bass(th, bm(rootM + 7), 0.15, 0.3);
    else if (s === 14 && rnd() < 0.5) k.bass(th, bm(M_KEY + P[(half + 1) % P.length][0]) - 1, 0.12, 0.2);

    // half-time kit: soft kick on 1 and the tresillo push, brush on 4, off-beat shaker
    if (sec.drums) {
      if (s === 0) k.drum(th, 120, 50, 0.2, 0.17);
      else if (s === 6) k.drum(th, 120, 50, 0.11, 0.15);
      if (s === 12) k.shake(S.brush, th, 0.075, 0.18);
    }
    if (s % 4 === 2) k.shake(S.shk, th, 0.026, 0.06);
    else if (sec.drums && s % 4 === 0) k.shake(S.shk, th, 0.011, 0.05);

    // the hook
    if (sec.hook) {
      for (const [at, m, beats] of M_HOOK) {
        if (at === ls) bell(k, S.lead, th, m + (sec.up ? 12 : 0), sec.up ? 0.05 : 0.075, beats * 4 * M_S16);
      }
    }
    // answering fills in the relative-major section: three rising chord tones
    if (sec.fills && bar % 2 === 1 && (s === 8 || s === 11 || s === 14)) {
      const v = voice(rootM, TRIAD[q], 69);
      bell(k, S.lead, th, s === 8 ? v[0] : s === 11 ? v[1] : v[2], 0.045, 0.5);
    }
  },
};

// ───────────────────────── game: "Son con ganas" ─────────────────────────

const G_S16 = 60 / 98 / 4;
const G_KEY = 53; // F3
const G_PROGS: Chord[][] = [
  [[0, 'maj'], [5, 'maj'], [7, 'dom'], [5, 'maj']], // F Bb C7 Bb
  [[0, 'maj'], [9, 'min'], [2, 'min'], [7, 'dom']], // F Dm Gm C7
  [[5, 'maj'], [7, 'dom'], [4, 'min'], [9, 'min']], // Bb C7 Am Dm
  [[2, 'min'], [7, 'dom'], [0, 'maj'], [0, 'maj']], // Gm C7 F F
  [[9, 'min'], [5, 'maj'], [2, 'min'], [7, 'dom']], // Dm Bb Gm C7
  [[0, 'maj'], [4, 'dom'], [9, 'min'], [7, 'dom']], // F A7 Dm C7
];
/** what the tres plays of each chord (the dominant goes rootless: 3rd, 5th, 7th) */
const G_TRES: Record<Quality, number[]> = { maj: [0, 4, 7], min: [0, 3, 7], dom: [4, 7, 10], domb9: [4, 7, 10], hdim: [0, 3, 6] };
/** two-bar guajeos: [16th step, voicing index, optional second note] */
const G_GUA: Record<'A' | 'B' | 'C', number[][]> = {
  A: [[0, 0], [2, 2], [3, 1], [6, 2], [8, 3], [10, 2], [11, 1], [14, 2], [16, 0], [18, 2], [19, 1], [22, 2], [24, 3], [26, 1], [28, 2], [30, 1]],
  B: [[0, 0, 2], [3, 1], [4, 2], [6, 3], [10, 2], [11, 1], [12, 2], [14, 0], [18, 1], [19, 2], [22, 3], [24, 2], [26, 1], [27, 2], [30, 0, 2]],
  C: [[0, 1, 3], [4, 2], [6, 1], [10, 2], [12, 3], [18, 2], [20, 1], [22, 2], [26, 3], [28, 2]],
};
const SON_CLAVE = [4, 8, 16, 22, 28]; // 2-3 son clave over two bars
const FILL: Record<number, number> = { 8: 265, 10: 265, 12: 190, 13: 190, 14: 150 }; // the conga fill closing a section

type GameType = 'full' | 'peak' | 'light';
interface GameState {
  count: number;
  last: GameType;
  lastProg: number;
  /** the next section's progressions, chosen a section ahead so the bass can anticipate into it */
  pending: Chord[][];
  bars: number;
  secStart: number;
  secEnd: number;
  sec: { type: GameType; progs: Chord[][]; entrada: boolean; gua: number[][]; flute: boolean };
  phrase: Note[] | null;
  tres: AudioNode;
  pad: AudioNode;
  shk: AudioNode;
  wood: AudioNode;
  bell: AudioNode;
  slap: AudioNode;
  lead: AudioNode;
}

function gameProgs(S: GameState): Chord[][] {
  const other = (a: number) => (a + 1 + Math.floor(rnd() * (G_PROGS.length - 1))) % G_PROGS.length;
  let a = Math.floor(rnd() * G_PROGS.length);
  if (a === S.lastProg) a = other(a);
  S.lastProg = a;
  return [G_PROGS[a], G_PROGS[rnd() < 0.5 ? other(a) : a]];
}

function gameNext(S: GameState, n: number) {
  const first = S.count === 0;
  let type: GameType;
  if (first) type = 'full';
  else if (S.last === 'full') type = pick<GameType>(['peak', 'peak', 'full', 'light']);
  else if (S.last === 'peak') type = pick<GameType>(['full', 'full', 'light']);
  else type = pick<GameType>(['full', 'peak']);
  S.count++;
  S.last = type;
  S.bars = type === 'light' ? 4 : 8;
  S.secStart = n;
  S.secEnd = n + S.bars * 16;
  const progs = first ? [G_PROGS[0], G_PROGS[1]] : S.pending;
  S.pending = gameProgs(S);
  S.sec = {
    type,
    progs,
    entrada: first,
    gua: type === 'light' ? G_GUA.C : pick([G_GUA.A, G_GUA.B]),
    flute: rnd() < (type === 'light' ? 0.6 : 0.85),
  };
  S.phrase = null;
}

/** conga tumbao: heel-toe taps on the 8ths, slap on 2, two open tones closing the bar */
function congaBar(k: Kit, slap: AudioNode, s: number, t: number) {
  if (s === 12) k.drum(t, 185, 150, 0.11, 0.2);
  else if (s === 14) k.drum(t, 185, 150, 0.085, 0.2);
  else if (s === 4) {
    k.shake(slap, t, 0.05, 0.05);
    k.drum(t, 340, 300, 0.04, 0.05);
  } else if (s % 2 === 0) k.drum(t, 235, 205, 0.028, 0.07);
  else if (s === 11 && rnd() < 0.3) k.drum(t, 235, 205, 0.02, 0.06);
}

const GAME: Song<GameState> = {
  bpm: 98,
  level: 1.15,
  yieldEvery: 16,
  setup(k) {
    const lead = k.bus();
    lead.connect(k.echo(3 * G_S16, 0.25, 0.28));
    return {
      count: 0, last: 'full', lastProg: 0, pending: [G_PROGS[0], G_PROGS[1]], bars: 8, secStart: 0, secEnd: 0,
      sec: { type: 'full', progs: [G_PROGS[0], G_PROGS[1]], entrada: true, gua: G_GUA.A, flute: false },
      phrase: null,
      tres: k.lp(2600), pad: k.lp(750), shk: k.hp(6500), wood: k.lp(1800), bell: k.lp(2400), slap: k.bp(1800, 1), lead,
    };
  },
  step(S, k, n, t) {
    if (n >= S.secEnd) gameNext(S, n);
    const sec = S.sec;
    const ls = n - S.secStart;
    const bar = ls >> 4;
    const s = ls & 15;
    const s32 = ls & 31;
    const lastBar = bar === S.bars - 1;
    const chordAt = (b: number) => sec.progs[(b >> 2) % 2][b & 3];
    const [root, q] = chordAt(bar);
    const nextRoot = lastBar ? S.pending[0][0][0] : chordAt(bar + 1)[0];
    const rootM = G_KEY + root;
    const th = t + rnd() * 0.004;
    const tune = !(sec.entrada && bar < 2); // the first two bars are bass and percussion only
    const peak = sec.type === 'peak';
    const light = sec.type === 'light';

    // tres
    if (tune) {
      for (const [at, i, j] of sec.gua) {
        if (at !== s32 || (at !== 0 && rnd() < 0.04)) continue;
        const v = voice(rootM, G_TRES[q], 58);
        v.push(v[0] + 12);
        k.pluck(S.tres, th, hz(v[i]), 0.07 + rnd() * 0.014, 0.3, 2800, 0.32);
        if (j !== undefined) k.pluck(S.tres, th + 0.01, hz(v[j]), 0.05, 0.3, 2800, 0.32);
      }
      if (light && s === 0) for (const m of voice(rootM, TRIAD[q], 55)) k.sus(S.pad, th, hz(m), 'sawtooth', 0.009, 0.5, 16 * G_S16, 0.5);
    }

    // bass tumbao: root on the downbeat of every other bar, and-of-2, then 4 into the next chord
    const bm = (m: number) => fold(m, 38);
    if (s === 6) k.bass(th, bm(rootM), 0.3, 0.32, 0.35, 0.08);
    else if (s === 12) k.bass(th, bm(G_KEY + nextRoot), 0.34, 0.55, 0.35, 0.08);
    else if (s === 0 && (bar & 1) === 0) k.bass(th, bm(rootM), 0.26, 0.35, 0.35, 0.08);
    else if (s === 10 && !light && rnd() < 0.4) k.bass(th, bm(rootM + 7), 0.17, 0.2, 0.35, 0.08);

    // percussion: maracas, conga (a fill closes the section), bongo martillo, clave, campana
    if (s % 2 === 0) k.shake(S.shk, th, s % 4 === 2 ? 0.04 : 0.02, 0.06);
    else if (!light) k.shake(S.shk, th, 0.01, 0.04);
    if (lastBar && s >= 8) {
      const f = FILL[s];
      if (f) k.drum(th, f, f * 0.82, s === 14 ? 0.11 : 0.085, 0.16);
    } else if (!light) congaBar(k, S.slap, s, th);
    if (light || peak) {
      if (s % 4 === 0) k.drum(th, 410, 350, light ? 0.04 : 0.03, 0.07);
      else if (s === 14 || (s === 6 && rnd() < 0.5)) k.drum(th, 300, 260, 0.045, 0.1);
    }
    if (SON_CLAVE.includes(s32)) k.tone(S.wood, th, 720, 'triangle', light ? 0.03 : 0.045, 0.002, 0.07);
    if (peak && s % 4 === 0) {
      const v = s % 8 === 0 ? 0.03 : 0.018;
      k.tone(S.bell, th, 587, 'triangle', v, 0.003, 0.13);
      k.tone(S.bell, th, 880, 'sine', v * 0.45, 0.003, 0.09);
    }

    // flute: a phrase on even bars; in the peak sections it sometimes answers itself
    if (sec.flute && tune && s === 0) {
      const p = (bar & 1) === 0 ? 0.85 : peak ? 0.4 : 0;
      S.phrase = rnd() < p ? makePhrase(rootM, q, 69, 84, G_S16) : null;
    }
    if (S.phrase) for (const [at, m, dur] of S.phrase) if (at === s) k.flute(S.lead, th, hz(m), 0.062, dur);
  },
};

// ───────────────────────── player ─────────────────────────

/** one piece playing through its own bus */
interface Voice {
  mode: MusicMode;
  out: GainNode;
  s16: number;
  yieldEvery: number;
  step: number;
  nextTime: number;
  /** stop scheduling at this time (a hand-over); Infinity while it is the current piece */
  endTime: number;
  /** once the context clock passes this, the faded bus is disconnected */
  deadAt: number;
  advance(): void;
}

let timer: number | null = null;
let ctxRef: AudioContext | null = null;
let root: GainNode | null = null;
let cur: Voice | null = null;
let voices: Voice[] = [];
let want: MusicMode = 'menu';

function createVoice<S>(song: Song<S>, mode: MusicMode, ctx: AudioContext, dest: AudioNode, startAt: number, fadeIn: number): Voice {
  const kit = makeKit(ctx, dest);
  kit.out.gain.setValueAtTime(0.0001, Math.max(0, startAt - 0.01));
  kit.out.gain.exponentialRampToValueAtTime(song.level, startAt + fadeIn);
  const S = song.setup(kit);
  const v: Voice = {
    mode,
    out: kit.out,
    s16: 60 / song.bpm / 4,
    yieldEvery: song.yieldEvery,
    step: 0,
    nextTime: startAt,
    endTime: Infinity,
    deadAt: Infinity,
    advance() {
      song.step(S, kit, v.step, v.nextTime);
      v.nextTime += v.s16;
      v.step++;
    },
  };
  return v;
}

const newVoice = (mode: MusicMode, ctx: AudioContext, dest: AudioNode, startAt: number, fadeIn: number): Voice =>
  mode === 'menu' ? createVoice(MENU, mode, ctx, dest, startAt, fadeIn) : createVoice(GAME, mode, ctx, dest, startAt, fadeIn);

/** the piece stops scheduling at `at` and its bus (pad, echo and note tails) fades from there */
function retire(v: Voice, at: number, fade: number) {
  v.endTime = Math.min(v.endTime, at);
  v.deadAt = at + fade + 1.5;
  const g = v.out.gain;
  if (typeof g.cancelAndHoldAtTime === 'function') g.cancelAndHoldAtTime(at);
  else {
    g.cancelScheduledValues(at);
    g.setValueAtTime(g.value, at);
  }
  g.setTargetAtTime(0, at, fade / 4);
}

function schedule() {
  const ctx = ctxRef;
  if (!ctx || !root || !cur) return;
  const now = ctx.currentTime; // frozen while the context is suspended, so nothing piles up
  if (cur.mode !== want) {
    // hand over on the sounding piece's next bar line (or half bar) that is not scheduled yet
    const at = cur.nextTime + ((cur.yieldEvery - (cur.step % cur.yieldEvery)) % cur.yieldEvery) * cur.s16;
    retire(cur, at, 0.8);
    cur = newVoice(want, ctx, root, at, 0.4);
    voices.push(cur);
  }
  for (const v of voices) {
    if (v.step > 0 && v.nextTime < now - 0.2) v.nextTime = now + 0.05; // the timer was throttled: skip ahead, don't burst
    while (v.nextTime < now + 0.3 && v.nextTime < v.endTime - 1e-6) v.advance();
  }
  voices = voices.filter((v) => {
    if (now < v.deadAt) return true;
    v.out.disconnect();
    return false;
  });
}

/** Which piece plays. Remembered while the music is off; applied at the next bar line while it plays. */
export function setMusicMode(m: MusicMode): void {
  want = m;
}

export function startMusic(ctx: AudioContext, dest: AudioNode): void {
  if (timer !== null) return;
  ctxRef = ctx;
  root = ctx.createGain();
  root.gain.setValueAtTime(0.0001, ctx.currentTime);
  root.gain.exponentialRampToValueAtTime(0.8, ctx.currentTime + 2);
  root.connect(dest);
  cur = newVoice(want, ctx, root, ctx.currentTime + 0.1, 0.05);
  voices = [cur];
  timer = window.setInterval(schedule, 90);
}

export function stopMusic(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
  const o = root;
  if (o) {
    const c = o.context;
    o.gain.cancelScheduledValues(c.currentTime);
    o.gain.setValueAtTime(o.gain.value, c.currentTime);
    o.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.4);
    setTimeout(() => o.disconnect(), 600);
  }
  root = null;
  cur = null;
  voices = [];
  ctxRef = null;
}
