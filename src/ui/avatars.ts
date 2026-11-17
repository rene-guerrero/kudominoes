/**
 * Animated 2D avatars: one emoji-like yellow head per seat, drawn as inline SVG.
 *
 * Every moving part is an SVG transform driven through reusable SVGTransform/SVGMatrix objects, and
 * opacities are written from a precomputed string table (the mouth path string is rebuilt only while
 * the mouth is actually changing shape).
 *
 * The seat avatars are built to cost almost nothing at rest: the idle bob / sway / breathing and the
 * sleepers' z's are CSS animations of transform/opacity (the compositor runs them), reactions (hops,
 * shakes, nods) move the whole <svg> with one CSS transform on its own layer, and the face's features
 * are written only when a value actually changed (blink, glance, expression morph). One shared loop
 * drives all four faces: requestAnimationFrame only while something moves, otherwise a slow timer that
 * just checks the schedule (next blink, glance, nod-off); nothing at all while paused, hidden or off.
 * Frame caps and how busy the idle faces are depend on the graphics level (LEVELS).
 *
 * Expressions are parameter vectors (brows, mouth, eyes) that the live face eases toward; motion
 * (bob, sway, hops, shakes, nods, head lean) is layered on top. A tiny scheduler adds blinks,
 * winks and glances at random intervals, and the controller maps game events to short reactions.
 */
import type { GameEvent, Seat, SeatPlate } from '../contracts';
import { character, DEFAULT_LINEUP, type FaceSpec } from '../roster';
import { FACE_COUNT, HUMAN_FACES } from './faces';

const NS = 'http://www.w3.org/2000/svg';

// ───────────────────────── expression parameters ─────────────────────────

const enum P {
  BLY, // left brow y offset
  BLR, // left brow rotation (deg, + = inner end down)
  BRY,
  BRR,
  ARCH, // brow arch (scaleY)
  MLX, // mouth left corner
  MLY,
  MRX, // mouth right corner
  MRY,
  MUX, // mouth control x
  MUY, // upper lip control y
  MDY, // lower lip control y
  HAPPY, // closed happy eyes (∩)
  WIDE, // eye scale
  LID, // baseline eye closure 0..1
  PUPIL, // pupil scale
  TONGUE,
  GX, // gaze baked into the expression (thinking: up/side)
  GY,
  BLUSH,
  DROWSY, // flat drowsy lid over the top half of the eye (0 = hidden, 1 = half)
  N,
}

type Expr = 'idle' | 'perk' | 'happy' | 'sad' | 'angry' | 'amazed' | 'thinking' | 'sleepy' | 'asleep' | 'smug' | 'meh';

//                   BLY  BLR BRY  BRR ARCH MLX MLY MRX MRY MUX  MUY  MDY HAPPY WIDE  LID PUPIL TONG  GX   GY  BLUSH DROWSY
const PRESETS: Record<Expr, number[]> = {
  idle:     [0,    0,   0,   0,  1,   58, 94, 82, 94, 70, 104, 104, 0, 1,    0,   1,    0,   0,   0,   1,   0],
  happy:    [-2.5, 0,  -2.5, 0,  1.25, 54, 91, 86, 91, 70, 92,  112, 1, 1,    0,   1,    1,   0,   0,   1.5, 0],
  perk:     [-4.5, -2, -4.5, -2, 1.3, 56, 93, 84, 93, 70, 106, 106, 0, 1.07, 0,   0.9,  0,   0,   0,   1.3, 0],
  smug:     [-1,  -3,  -1,  -3,  1.1, 57, 93, 84, 91, 71, 105, 105, 0, 1,    0.18, 1,   0,   0,   0,   1.25, 0],
  sad:      [-1,  -15, -1, -15,  0.7, 60, 102, 80, 102, 70, 93, 93, 0, 1,    0.22, 1.05, 0,   0,   1.2, 0.8, 0],
  meh:      [0,   -6,   0,  -6,  0.8, 61, 99, 79, 99, 70, 97,  97,  0, 1,    0.15, 1,   0,   0,   0.6, 0.9, 0],
  angry:    [3,    20,  3,  20,  0.55, 58, 98, 82, 98, 70, 90, 102, 0, 1,    0.2, 0.92, 0,   0,   0,   1.2, 0],
  amazed:   [-7.5, 0,  -7.5, 0,  1.5, 64, 97, 76, 97, 70, 88,  108, 0, 1.16, 0,   0.74, 0,   0,   0,   1.2, 0],
  thinking: [-6,  -8,   1.5, 6,  1.1, 62, 99, 80, 96, 72, 97,  97,  0, 1,    0.08, 1,   0,   2.4, -2.6, 1,  0],
  sleepy:   [1.5, -3,   1.5, -3, 0.8, 63, 99, 77, 99, 70, 97,  101, 0, 1,    0,   1,    0,   0,   2.4, 0.9, 1],
  asleep:   [1.5, -3,   1.5, -3, 0.8, 65, 99, 75, 99, 70, 97,  102, 0, 1,    1,   1,    0,   0,   0,   0.9, 0],
};

// the human's faces live in ./faces (tiny, so the settings code can import them without this module)
export { FACE_COUNT, HUMAN_FACES } from './faces';
const humanSpec = (i: number) => HUMAN_FACES[clamp(Math.round(i) || 0, 0, FACE_COUNT - 1)];

/** the face each seat wears (seat 0 = the human's pick; 1..3 = the seated characters) */
const seatFaces: FaceSpec[] = [HUMAN_FACES[0], character(DEFAULT_LINEUP[1]).face, character(DEFAULT_LINEUP[2]).face, character(DEFAULT_LINEUP[3]).face];
export function setHumanFace(i: number): void {
  seatFaces[0] = humanSpec(i);
}
export const faceOfSeat = (seat: number): FaceSpec => seatFaces[seat] ?? HUMAN_FACES[0];
const asSpec = (f: FaceSpec | number): FaceSpec => (typeof f === 'number' ? humanSpec(f) : f);

/** smirking faces keep a lopsided mouth when idle */
const SMIRK_IDLE: [P, number][] = [
  [P.MLX, 58],
  [P.MLY, 96],
  [P.MRX, 84],
  [P.MRY, 92],
  [P.MUX, 72],
  [P.MUY, 103],
  [P.MDY, 103],
];
const FACE = '#FFCB3D';

// opacity strings 0..1 in 0.02 steps (no per-frame string building)
const OPA: string[] = Array.from({ length: 51 }, (_, i) => String(i / 50));
const opaIdx = (v: number) => (v <= 0 ? 0 : v >= 1 ? 50 : Math.round(v * 50));

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const DEG = Math.PI / 180;

let uidSeq = 0;
// unique clip-path ids even if the module is ever loaded twice (HMR)
const UID_SALT = Math.random().toString(36).slice(2, 6);

// ───────────────────────── the face (SVG + writers) ─────────────────────────

/** Live dynamic values the controller computes each frame (motion on top of the expression). */
export interface FaceMotion {
  y: number; // body offset (viewBox units, + = down)
  rot: number; // degrees
  sx: number;
  sy: number;
  fx: number; // features shift (head turn)
  fy: number;
  gx: number; // pupils
  gy: number;
  blinkL: number; // 0..1
  blinkR: number;
  zzz: number; // 0..1
  t: number; // seconds (for the floating z's)
  breath: number; // asleep mouth breathing -1..1
  wig: number; // moustache twitch (degrees)
  droop: number; // asleep droop 0..1 (aviators sag, antennae wilt)
  glow: number; // antenna tips glowing brighter (thinking) 0..1
  ant: number; // antenna sway (degrees)
  glint: number; // aviator glint sweep 0..1 (<0 = none)
}

export const restMotion = (): FaceMotion => ({ y: 0, rot: 0, sx: 1, sy: 1, fx: 0, fy: 0, gx: 0, gy: 0, blinkL: 0, blinkR: 0, zzz: 0, t: 0, breath: 0, wig: 0, droop: 0, glow: 0, ant: 0, glint: -1 });

class Xf {
  private t: SVGTransform;
  constructor(
    el: SVGGraphicsElement,
    private m: SVGMatrix,
  ) {
    this.t = (el.ownerSVGElement ?? (el as unknown as SVGSVGElement)).createSVGTransform();
    el.transform.baseVal.initialize(this.t);
  }
  set(a: number, b: number, c: number, d: number, e: number, f: number): void {
    const m = this.m;
    m.a = a;
    m.b = b;
    m.c = c;
    m.d = d;
    m.e = e;
    m.f = f;
    this.t.setMatrix(m);
  }
  translate(x: number, y: number): void {
    this.t.setTranslate(x, y);
  }
}

class Opa {
  private last = -1;
  constructor(private el: Element) {}
  set(v: number): void {
    const i = opaIdx(v);
    if (i === this.last) return;
    this.last = i;
    this.el.setAttribute('opacity', OPA[i]);
  }
}

interface EyeRefs {
  eye: Xf;
  open: Opa;
  iris: Xf;
  pupil: Xf;
  lid: Xf;
  dlid: Xf;
  lash: Xf;
  lashO: Opa;
  closed: Opa;
  happy: Opa;
  cx: number;
}

/** brow shapes per face: local path + centre for the left brow and the right brow, stroke width */
function browSpec(f: FaceSpec): { l: string; r: string; lc: [number, number]; rc: [number, number]; w: number } {
  if (f.brows === 'thick') return { l: 'M-12 -0.5 Q1 -7.5 12 0.5', r: 'M12 -0.5 Q-1 -7.5 -12 0.5', lc: [51, 49.5], rc: [89, 49.5], w: 7 };
  if (f.brows === 'raised') {
    const dy = f.glasses ? -4 : 0;
    return { l: 'M-10.5 0.3 Q0 -1.7 10.5 1.3', r: 'M-10.5 0.5 Q-0.5 -7.5 10.5 -0.5', lc: [51.5, 50.5 + dy], rc: [88.5, 44.5 + dy], w: 4.2 };
  }
  // aviators: flatter brows sitting right on the frame
  if (f.brows === 'aviator' || f.aviators) return { l: 'M-11.5 1 Q0.5 -3 11.5 2', r: 'M-11.5 2 Q-0.5 -3 11.5 1', lc: [51.5, 46], rc: [88.5, 46], w: 4.4 };
  const y = f.glasses ? 44.5 : 48.5;
  return { l: 'M-10.5 0.5 Q0 -4.5 10.5 0.5', r: 'M-10.5 0.5 Q0 -4.5 10.5 0.5', lc: [51.5, y], rc: [88.5, y], w: 4.2 };
}

const ZZZ = `<g class="zzz" fill="#FFF6E6" stroke="#2A160D" stroke-width="2.6" paint-order="stroke" font-weight="900" font-family="Arial Rounded MT Bold, Arial, sans-serif">
  <text font-size="30" opacity="0">z</text><text font-size="30" opacity="0">z</text><text font-size="30" opacity="0">z</text>
</g>`;

function mouthMarkup(uid: string, color: string, wrap = ''): string {
  return `<g${wrap ? ` transform="${wrap}"` : ''}><path class="mouth" fill="${color}" stroke="${color}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
    <ellipse class="tongue" rx="7" ry="3.6" fill="#F2766B" clip-path="url(#${uid}m)" opacity="0"/></g>`;
}

const AV_L = 'M35 62 Q35 55 44 55 L60 55 Q67 55 67 63 Q66 81 51 82 Q36 80 35 62 Z';
const AV_R = 'M105 62 Q105 55 96 55 L80 55 Q73 55 73 63 Q74 81 89 82 Q104 80 105 62 Z';

function faceMarkup(f: FaceSpec, uid: string): string {
  if (f.alien) return alienMarkup(uid);
  const iris = f.iris;
  const lashes = !!f.lashes;
  const eye = (cx: number, side: -1 | 1) => {
    // side: -1 = left eye (outer corner at -x), 1 = right eye
    const flicks = lashes
      ? `<path d="M${side * 12} -10 L${side * 16} -15 M${side * 7} -13 L${side * 9} -19" stroke="#3A2410" stroke-width="2.2" stroke-linecap="round" fill="none"/>`
      : '';
    return `<g class="eye" data-cx="${cx}">
  <g class="open">
    <g clip-path="url(#${uid}e)">
      <ellipse rx="10" ry="12" fill="#fff"/>
      <ellipse cy="-7" rx="10" ry="6" fill="#E8E2EE" opacity=".55"/>
      <g class="iris">
        <circle cy="1.5" r="7.5" fill="${iris}"/>
        <circle cy="1.5" r="6.9" fill="none" stroke="#000" stroke-opacity=".22" stroke-width="1.3"/>
        <circle cy="3.6" r="4.6" fill="#fff" opacity=".12"/>
        <circle class="pupil" cy="1.5" r="4.2" fill="#1A1210"/>
        <circle cx="-2.8" cy="-2.4" r="2.6" fill="#fff"/>
        <circle cx="3" cy="4" r="1.2" fill="#fff" opacity=".8"/>
      </g>
    </g>
    <g clip-path="url(#${uid}l)"><path class="lid" d="M-15 -36 H15 V-4.5 Q0 -16 -15 -4.5 Z" fill="${FACE}"/></g>
    <g class="lash">
      <path d="M-11 -4 Q0 -15 11 -4" stroke="#3A2410" stroke-width="${lashes ? 3.2 : 2}" stroke-linecap="round" fill="none"/>
      ${flicks}
    </g>
    <g clip-path="url(#${uid}l)"><g class="dlid"><rect x="-15" y="-34" width="30" height="34" fill="#F0B02A"/><path d="M-12 0 H12" stroke="#3A2410" stroke-width="2.2" stroke-linecap="round"/></g></g>
  </g>
  <path class="closed" d="M-10 2.5 Q0 9.5 10 2.5" stroke="#3A2410" stroke-width="3" stroke-linecap="round" fill="none" opacity="0"/>
  <path class="happy" d="M-10 3 Q0 -10 10 3" stroke="#3A2410" stroke-width="3.4" stroke-linecap="round" fill="none" opacity="0"/>
</g>`;
  };
  const freckles = f.freckles
    ? `<g fill="#D98A1E" opacity=".8"><circle cx="34" cy="86" r="1.6"/><circle cx="39.5" cy="82.5" r="1.4"/><circle cx="44" cy="87" r="1.5"/><circle cx="96" cy="87" r="1.5"/><circle cx="100.5" cy="82.5" r="1.4"/><circle cx="106" cy="86" r="1.6"/></g>`
    : '';
  const glasses = f.glasses
    ? `<g fill="none" stroke="#3A2410" stroke-width="3" stroke-linecap="round"><circle cx="53" cy="68" r="16" fill="#fff" fill-opacity=".1"/><circle cx="87" cy="68" r="16" fill="#fff" fill-opacity=".1"/><path d="M66.5 64 Q70 60.5 73.5 64"/><path d="M37 65 L23 61"/><path d="M103 65 L117 61"/></g><path d="M44 58 Q48 55 52 56" stroke="#fff" stroke-width="2" stroke-linecap="round" fill="none" opacity=".55"/>`
    : '';
  // gold aviators: dark lenses with a lighter lower band, double bridge, and a glint that slides across
  const aviators = f.aviators
    ? `<g class="avi">
  <path d="M18 60 L36 62 M122 60 L104 62" stroke="#B8922E" stroke-width="2.6" stroke-linecap="round" fill="none"/>
  <path d="${AV_L}" fill="#232A36"/><path d="${AV_R}" fill="#232A36"/>
  <g clip-path="url(#${uid}v)">
    <path d="M37 68 Q40 80 52 80 Q64 79 65 68 Z" fill="#3B4658"/><path d="M103 68 Q100 80 88 80 Q76 79 75 68 Z" fill="#3B4658"/>
    <g class="glint" opacity="0"><path d="M50 50 L58 50 L46 86 L38 86 Z M62 50 L65 50 L53 86 L50 86 Z" fill="#fff"/></g>
  </g>
  <path d="${AV_L}" fill="none" stroke="#C9A23A" stroke-width="2.6" stroke-linejoin="round"/><path d="${AV_R}" fill="none" stroke="#C9A23A" stroke-width="2.6" stroke-linejoin="round"/>
  <path d="M67 59 H73 M66.5 64 Q70 61 73.5 64" stroke="#C9A23A" stroke-width="2.2" stroke-linecap="round" fill="none"/>
  <path d="M40 59 Q43 57 47 57.2" stroke="#fff" stroke-width="1.6" stroke-linecap="round" fill="none" opacity=".35"/>
</g>`
    : '';
  // handlebar moustache: two bushy lobes with curled, upturned tips (right lobe = mirrored left)
  const grey = f.stache === 'grey';
  const lobe = `<path d="M70 88.5 C66 82 58 80.5 51 83.5 C45.5 86 41 86.5 37.5 82 C35.5 79.5 36.5 76.5 39 76 C35 75.5 31.5 79 32 84 C32.8 92.5 41 98.5 51 99 C59 99.4 65.5 97 70 94 Z" fill="${grey ? '#8C8C86' : '#5A3212'}"/>
<path d="M66 89.5 Q57 86.5 49 89.5 M64 93.5 Q55 93.5 46 92.5 M60 96.5 Q52 97.5 43 95.5" stroke="${grey ? '#C4C4BC' : '#8A5A2E'}" stroke-width="1.2" stroke-linecap="round" fill="none" opacity="${grey ? '.8' : '.6'}"/>`;
  const stache = f.stache
    ? `<g class="stache"><g class="mlobe">${lobe}</g><g class="mlobe"><g transform="matrix(-1 0 0 1 140 0)">${lobe}</g></g><ellipse cx="70" cy="91" rx="4.6" ry="4" fill="${grey ? '#74746E' : '#4A280E'}"/></g>`
    : '';
  const bs = browSpec(f);
  const mouth = f.stache ? '' : mouthMarkup(uid, '#6B2E1A');
  const petals = [0, 72, 144, 216, 288].map((a) => `<ellipse cx="0" cy="-5.2" rx="3.6" ry="4.6" transform="rotate(${a})"/>`).join('');
  const flower = f.flower
    ? `<g transform="translate(103 30) rotate(18)"><g fill="#F2766B" stroke="#C8504A" stroke-width=".8">${petals}</g><circle r="2.8" fill="#FFD84D" stroke="#D9A21E" stroke-width=".7"/></g>`
    : '';
  const mole = f.mole ? `<circle cx="86.5" cy="102" r="1.7" fill="#6B3A1E" opacity=".85"/>` : '';
  return `<svg class="face" viewBox="0 0 140 140" overflow="visible" aria-hidden="true" focusable="false">
<defs>
  <clipPath id="${uid}e"><ellipse rx="10" ry="12"/></clipPath>
  <clipPath id="${uid}l"><ellipse rx="11.4" ry="13.4"/></clipPath>
  <clipPath id="${uid}m"><path class="mclip"/></clipPath>
  ${f.aviators ? `<clipPath id="${uid}v"><path d="${AV_L} ${AV_R}"/></clipPath>` : ''}
  <radialGradient id="${uid}r" cx="70" cy="68" r="51.5" gradientUnits="userSpaceOnUse">
    <stop offset=".72" stop-color="#F2A21F" stop-opacity="0"/>
    <stop offset="1" stop-color="#F2A21F" stop-opacity=".38"/>
  </radialGradient>
</defs>
<ellipse class="shadow" cx="70" cy="132" rx="34" ry="5" fill="#000" opacity=".16"/>
<g class="body">
  <circle cx="70" cy="72" r="54" fill="#EE9D1C"/>
  <circle cx="70" cy="68" r="51.5" fill="${FACE}"/>
  <circle cx="70" cy="68" r="51.5" fill="url(#${uid}r)"/>
  <ellipse cx="52" cy="38" rx="20" ry="9" fill="#FFE28A" opacity=".75" transform="rotate(-24 52 38)"/>
  <ellipse cx="45" cy="31" rx="5" ry="2.6" fill="#FFF6D2" opacity=".7" transform="rotate(-30 45 31)"/>
  <g class="feat">
    <ellipse class="blush" cx="40" cy="90" rx="9" ry="5" fill="#F5924E" opacity=".26"/>
    <ellipse class="blush" cx="100" cy="90" rx="9" ry="5" fill="#F5924E" opacity=".26"/>
    ${freckles}
    ${eye(53, -1)}
    ${eye(87, 1)}
    ${glasses}
    ${aviators}
    <g stroke="${f.browColor ?? '#7A4A16'}" stroke-width="${bs.w}" stroke-linecap="round" fill="none">
      <g class="brow"><path d="${bs.l}"/></g>
      <g class="brow"><path d="${bs.r}"/></g>
    </g>
    ${mouth}
    ${mole}
    ${stache}
  </g>
  ${flower}
</g>
${ZZZ}
</svg>`;
}

/** Papi Zorg: green alien head, glowing antennae, big dark almond eyes, no nose. Extra headroom for the antennae. */
function alienMarkup(uid: string): string {
  const eyeL = 'M26 58 Q30 40 50 50 Q66 58 62 76 Q56 90 40 84 Q24 78 26 58 Z';
  const eyeR = 'M114 58 Q110 40 90 50 Q74 58 78 76 Q84 90 100 84 Q116 78 114 58 Z';
  const ant = (x0: number, path: string, tx: number) => `<g class="ant" data-x="${x0}">
    <path d="${path}" stroke="#3E9E3A" stroke-width="4" stroke-linecap="round" fill="none"/>
    <circle class="halo" cx="${tx}" cy="-10" r="11" fill="#C8FF7A" opacity=".28"/>
    <circle cx="${tx}" cy="-10" r="6" fill="#C8FF7A"/>
    <circle cx="${tx - 1.8}" cy="-12" r="1.9" fill="#fff" opacity=".75"/>
  </g>`;
  const aeye = (d: string, cx: number, hx: number, dx: number, dy: number) => `<g class="aeye" data-cx="${cx}">
    <g class="aopen"><path d="${d}" fill="#101418"/>
      <g class="ahi"><ellipse cx="${hx}" cy="${hx < 70 ? 58 : 56}" rx="6" ry="8" fill="#fff" opacity=".9" transform="rotate(-24 ${hx} ${hx < 70 ? 58 : 56})"/><circle cx="${dx}" cy="${dy}" r="2.4" fill="#7FE0FF"/></g>
    </g>
    <path class="aclosed" d="M${cx - 16} 68 Q${cx} 77 ${cx + 16} 68" stroke="#1F5A22" stroke-width="3.4" stroke-linecap="round" fill="none" opacity="0"/>
    <path class="ahappy" d="M${cx - 16} 72 Q${cx} 56 ${cx + 16} 72" stroke="#1F5A22" stroke-width="3.6" stroke-linecap="round" fill="none" opacity="0"/>
  </g>`;
  return `<svg class="face alien" viewBox="-13 -26 166 166" overflow="visible" aria-hidden="true" focusable="false">
<defs><clipPath id="${uid}m"><path class="mclip"/></clipPath></defs>
<ellipse class="shadow" cx="70" cy="136" rx="34" ry="5" fill="#000" opacity=".16"/>
<g class="body">
  ${ant(48, 'M48 24 Q40 6 34 -8', 34)}
  ${ant(92, 'M92 24 Q100 6 106 -8', 106)}
  <path d="M70 16 Q128 16 126 62 Q124 100 94 120 Q70 134 46 120 Q16 100 14 62 Q12 16 70 16 Z" fill="#3E9E3A"/>
  <path d="M70 14 Q125 14 123 58 Q121 96 93 115 Q70 128 47 115 Q19 96 17 58 Q15 14 70 14 Z" fill="#6FD24F"/>
  <ellipse cx="48" cy="34" rx="20" ry="8" fill="#B6F28C" opacity=".7" transform="rotate(-22 48 34)"/>
  <g class="feat">
    <ellipse class="blush" cx="42" cy="95" rx="8" ry="4.5" fill="#2F9B63" opacity=".35"/>
    <ellipse class="blush" cx="98" cy="95" rx="8" ry="4.5" fill="#2F9B63" opacity=".35"/>
    ${aeye(eyeL, 44, 38, 52, 76)}
    ${aeye(eyeR, 96, 94, 106, 74)}
    ${mouthMarkup(uid, '#1F5A22', 'translate(70 103) scale(.9 .85) translate(-70 -94)')}
  </g>
</g>
${ZZZ}
</svg>`;
}

interface AlienEye {
  g: Xf;
  open: Opa;
  hi: Xf;
  closed: Opa;
  happy: Opa;
  cx: number;
}

export class Face {
  readonly svg: SVGSVGElement;
  readonly spec: FaceSpec;
  private m: SVGMatrix;
  private body: Xf;
  private shadow: Xf | null = null;
  private shadowO: Opa | null = null;
  private feat: Xf;
  private brows: Xf[];
  private browC: [number, number][];
  private eyes: EyeRefs[];
  private mouth: SVGPathElement | null;
  private mclip: SVGPathElement;
  private tongue: SVGEllipseElement | null;
  private tongueO: Opa | null;
  private lobes: Xf[];
  private blush: Opa[];
  private blushBase: number;
  private zs: { x: Xf; o: Opa }[];
  private lastMouth = new Float32Array(7).fill(-999);
  // aviators
  private avi: Xf | null = null;
  private glint: Xf | null = null;
  private glintO: Opa | null = null;
  // alien
  private aeyes: AlienEye[] = [];
  private ants: { g: Xf; halo: Opa; x: number }[] = [];
  private shadowY: number;
  /**
   * live = a seat avatar: the body motion (bob, sway, hops) and the floating z's are NOT drawn in the
   * SVG — the avatar moves the whole <svg> with a CSS transform (compositor only) and shows HTML z's;
   * the ground shadow becomes a separate element. apply() then only touches the face's features.
   */
  readonly live: boolean;

  constructor(spec: FaceSpec, live = false) {
    this.spec = spec;
    this.live = live;
    const uid = `av${UID_SALT}${++uidSeq}`;
    const tpl = document.createElement('template');
    tpl.innerHTML = faceMarkup(spec, uid).trim();
    this.svg = tpl.content.firstElementChild as SVGSVGElement;
    const svg = this.svg;
    if (live) {
      svg.querySelector('.shadow')?.remove();
      svg.querySelector('.zzz')?.remove();
    }
    this.m = svg.createSVGMatrix();
    const q = <T extends Element>(sel: string, root: ParentNode = svg) => root.querySelector(sel) as T;
    const qa = <T extends Element>(sel: string, root: ParentNode = svg) => Array.from(root.querySelectorAll(sel)) as T[];
    const xf = (el: Element) => new Xf(el as SVGGraphicsElement, this.m);
    this.body = xf(q('.body'));
    if (!live) {
      const sh = q<SVGEllipseElement>('.shadow');
      this.shadow = xf(sh);
      this.shadowO = new Opa(sh);
    }
    this.shadowY = spec.alien ? 136 : 132;
    this.feat = xf(q('.feat'));
    this.brows = qa('.brow').map(xf);
    const bs = browSpec(spec);
    this.browC = [bs.lc, bs.rc];
    this.eyes = qa<SVGGElement>('.eye').map((g) => ({
      eye: xf(g),
      open: new Opa(q('.open', g)),
      iris: xf(q('.iris', g)),
      pupil: xf(q('.pupil', g)),
      lid: xf(q('.lid', g)),
      dlid: xf(q('.dlid', g)),
      lash: xf(q('.lash', g)),
      lashO: new Opa(q('.lash', g)),
      closed: new Opa(q('.closed', g)),
      happy: new Opa(q('.happy', g)),
      cx: Number(g.dataset.cx),
    }));
    this.mouth = q<SVGPathElement>('.mouth');
    this.mclip = q<SVGPathElement>('.mclip');
    this.tongue = q<SVGEllipseElement>('.tongue');
    this.tongueO = this.tongue ? new Opa(this.tongue) : null;
    this.lobes = qa('.mlobe').map(xf);
    this.blush = qa('.blush').map((e) => new Opa(e));
    this.blushBase = spec.alien ? 0.35 : 0.26;
    this.zs = qa('.zzz text').map((e) => ({ x: xf(e), o: new Opa(e) }));
    const avi = q('.avi');
    if (avi) {
      this.avi = xf(avi);
      const gl = q('.glint');
      this.glint = xf(gl);
      this.glintO = new Opa(gl);
    }
    this.aeyes = qa<SVGGElement>('.aeye').map((g) => ({
      g: xf(q('.aopen', g)),
      open: new Opa(q('.aopen', g)),
      hi: xf(q('.ahi', g)),
      closed: new Opa(q('.aclosed', g)),
      happy: new Opa(q('.ahappy', g)),
      cx: Number(g.dataset.cx),
    }));
    this.ants = qa<SVGGElement>('.ant').map((g) => ({ g: xf(g), halo: new Opa(q('.halo', g)), x: Number(g.dataset.x) }));
  }

  /** Write the expression `p` with the motion `m` into the SVG. */
  apply(p: Float32Array | number[], m: FaceMotion): void {
    if (!this.live) this.applyBody(m);
    this.feat.translate(m.fx, m.fy);
    this.applyFeatures(p, m);
    if (!this.live) this.applyZs(m);
  }

  /** body transform + ground shadow (static / mini faces only; live avatars move the <svg> by CSS) */
  private applyBody(m: FaceMotion): void {
    // body: scale about the chin-bottom, rotate about the neck, then offset
    const cx = 70;
    const sY = 124; // squash pivot
    const rY = 112; // rotation pivot
    const cos = Math.cos(m.rot * DEG);
    const sin = Math.sin(m.rot * DEG);
    const se = cx - cx * m.sx;
    const sf = sY - sY * m.sy;
    const re = cx - cos * cx + sin * rY;
    const rf = rY - sin * cx - cos * rY;
    const a = cos * m.sx;
    const b = sin * m.sx;
    const c = -sin * m.sy;
    const d = cos * m.sy;
    const e = cos * se - sin * sf + re;
    const f = sin * se + cos * sf + rf + m.y;
    this.body.set(a, b, c, d, e, f);
    const lift = clamp(-m.y, 0, 40);
    const ss = 1 - lift * 0.012;
    this.shadow?.set(ss, 0, 0, 1, cx - cx * ss, 0);
    this.shadowO?.set(0.16 * (1 - lift * 0.014));
    void this.shadowY;
  }

  /** brows, eyes, glasses, antennae, mouth, moustache, blush */
  private applyFeatures(p: Float32Array | number[], m: FaceMotion): void {
    // brows (right rotation mirrored)
    const arch = p[P.ARCH];
    for (let i = 0; i < this.brows.length; i++) {
      const r = (i === 0 ? p[P.BLR] : -p[P.BRR]) * DEG;
      const y = i === 0 ? p[P.BLY] : p[P.BRY];
      const co = Math.cos(r);
      const si = Math.sin(r);
      const bc = this.browC[i];
      this.brows[i].set(co, si, -si * arch, co * arch, bc[0], bc[1] + y);
    }

    // eyes
    const wide = p[P.WIDE];
    const happy = p[P.HAPPY];
    const gx = clamp(p[P.GX] + m.gx, -3.4, 3.4);
    const gy = clamp(p[P.GY] + m.gy, -3.2, 3);
    const ps = p[P.PUPIL];
    const dz = clamp(p[P.DROWSY], 0, 1.2);
    for (let i = 0; i < this.eyes.length; i++) {
      const E = this.eyes[i];
      const cl = clamp(Math.max(p[P.LID], i === 0 ? m.blinkL : m.blinkR), 0, 1);
      E.eye.set(wide, 0, 0, wide, E.cx, 68);
      const lidOpen = -(wide - 1) * 22;
      const lidY = lidOpen + (23 - lidOpen) * cl;
      E.lid.translate(0, lidY);
      E.lash.translate(0, Math.min(lidY, 15));
      // drowsy: a flat, slightly darker lid with a straight edge over the top half
      E.dlid.translate(0, -30 + 30 * dz + Math.max(0, cl - 0.2) * 14);
      const shut = smooth(0.7, 0.93, cl);
      E.lashO.set((1 - shut) * (1 - smooth(0.3, 0.8, dz)));
      E.open.set((1 - happy) * (cl > 0.97 ? 0 : 1));
      E.closed.set(shut * (1 - happy));
      E.happy.set(happy);
      E.iris.translate(gx, gy);
      E.pupil.set(ps, 0, 0, ps, 0, 1.5 - 1.5 * ps);
    }

    // aviators: the glasses carry the eyes' job — they lift with the brows, slide down the nose to peek
    // over the rims when amazed, droop when asleep, and a glint slides across now and then
    if (this.avi) {
      const peek = smooth(1.03, 1.14, wide);
      const browLift = Math.max(0, -(p[P.BLY] + p[P.BRY]) / 2);
      const dy = 10.5 * peek - browLift * 0.35 * (1 - peek) + 3.2 * m.droop + 1.2 * dz;
      const rot = (p[P.BLR] - p[P.BRR]) * 0.12 + 4 * m.droop;
      const r = rot * DEG;
      const co = Math.cos(r);
      const si = Math.sin(r);
      // rotate about the bridge (70, 62), then shift down
      this.avi.set(co, si, -si, co, 70 - co * 70 + si * 62, 62 - si * 70 - co * 62 + dy);
      if (this.glint && this.glintO) {
        const u = m.glint;
        if (u < 0 || u > 1) this.glintO.set(0);
        else {
          this.glint.translate(-28 + u * 96, 0);
          this.glintO.set(0.35 * Math.sin(Math.PI * u) + 0.05);
        }
      }
    }

    // alien eyes: squash to blink, tilt for anger/sorrow, highlights follow the gaze
    for (let i = 0; i < this.aeyes.length; i++) {
      const E = this.aeyes[i];
      const cl = clamp(Math.max(p[P.LID], i === 0 ? m.blinkL : m.blinkR), 0, 1);
      const sq = Math.max(0.06, (1 - 0.94 * cl) * (1 - 0.42 * dz));
      const tilt = (i === 0 ? p[P.BLR] : -p[P.BRR]) * 0.42 * DEG;
      const yy = (i === 0 ? p[P.BLY] : p[P.BRY]) * 0.3;
      const sx = wide;
      const sy = wide * sq;
      const co = Math.cos(tilt);
      const si = Math.sin(tilt);
      // scale about (cx, 66), then rotate about the same point
      const A = co * sx;
      const B = si * sx;
      const C = -si * sy;
      const D = co * sy;
      const px = E.cx;
      const py = 66;
      E.g.set(A, B, C, D, px - (A * px + C * py), py - (B * px + D * py) + yy);
      E.hi.translate(gx * 0.9, gy * 0.9);
      const shut = smooth(0.75, 0.95, cl);
      E.open.set((1 - happy) * (cl > 0.97 ? 0 : 1));
      E.closed.set(shut * (1 - happy));
      E.happy.set(happy);
    }
    if (this.ants.length) {
      const perk = smooth(1.02, 1.14, wide);
      const sad = clamp((-p[P.BLR] - 5) / 10, 0, 1) * 0.35;
      const droop = Math.max(m.droop, sad);
      for (let i = 0; i < 2; i++) {
        const A = this.ants[i];
        const dir = i === 0 ? 1 : -1; // + = towards upright for the left antenna
        const deg = dir * (perk * 9 - droop * 30) + m.ant * (i === 0 ? 1 : 0.8);
        const sc = 1 + perk * 0.08 - droop * 0.06;
        const r = deg * DEG;
        const co = Math.cos(r) * sc;
        const si = Math.sin(r) * sc;
        const bx = A.x;
        const by = 24;
        A.g.set(co, si, -si, co, bx - (co * bx - si * by), by - (si * bx + co * by));
        A.halo.set(clamp(0.22 + 0.1 * Math.sin(m.t * 2.6 + i * 1.3) + 0.5 * m.glow + 0.3 * perk - 0.2 * m.droop, 0, 1));
      }
    }

    if (this.mouth && this.tongue && this.tongueO) {
      // mouth (path rebuilt only when it changed)
      const mdy = p[P.MDY] + m.breath * 1.2;
      const lm = this.lastMouth;
      let changed = false;
      for (let i = 0; i < 7; i++) {
        const v = i === 6 ? mdy : p[P.MLX + i];
        if (Math.abs(v - lm[i]) > 0.06) changed = true;
      }
      if (changed) {
        for (let i = 0; i < 7; i++) lm[i] = i === 6 ? mdy : p[P.MLX + i];
        const lx = p[P.MLX].toFixed(1);
        const ly = p[P.MLY].toFixed(1);
        const rx = p[P.MRX].toFixed(1);
        const ry = p[P.MRY].toFixed(1);
        const ux = p[P.MUX].toFixed(1);
        const dPath = `M${lx} ${ly}Q${ux} ${p[P.MUY].toFixed(1)} ${rx} ${ry}Q${ux} ${mdy.toFixed(1)} ${lx} ${ly}Z`;
        this.mouth.setAttribute('d', dPath);
        this.mclip.setAttribute('d', dPath);
        this.tongue.setAttribute('cx', ux);
        this.tongue.setAttribute('cy', (0.25 * p[P.MLY] + 0.25 * p[P.MRY] + 0.5 * mdy - 0.8).toFixed(1));
      }
      this.tongueO.set(p[P.TONGUE]);
    }
    if (this.lobes.length) {
      // the moustache carries the mouth's expression: it lifts when happy, droops when sad,
      // puffs out when amazed or slamming, twitches now and then, flutters with sleepy breaths
      const smile = (p[P.MUY] + p[P.MDY]) / 2 - (p[P.MLY] + p[P.MRY]) / 2;
      const open = p[P.MDY] - p[P.MUY];
      const liftDeg = (smile - 4) * 1.1 + happy * 7 + m.wig;
      const puff = clamp((open - 5) / 15, 0, 1);
      const sxp = 1 + 0.16 * puff;
      const syp = (1 + 0.2 * puff) * (1 + 0.05 * m.breath);
      const dyp = (smile < 0 ? -smile * 0.35 : 0) + 1.2 * m.breath; // a sad moustache sags a little
      for (let i = 0; i < 2; i++) {
        // rotate about the centre knot: + lifts the left tip, mirrored for the right
        const r = (i === 0 ? liftDeg : -liftDeg + m.wig * 2) * DEG;
        const co = Math.cos(r);
        const si = Math.sin(r);
        const A = co * sxp;
        const B = si * sxp;
        const C = -si * syp;
        const D = co * syp;
        const px = 70;
        const py = 91;
        this.lobes[i].set(A, B, C, D, px - (A * px + C * py), py - (B * px + D * py) + dyp);
      }
    }
    const bl = this.blushBase * p[P.BLUSH];
    this.blush[0].set(bl);
    this.blush[1].set(bl);
  }

  /** floating z's (static / mini faces; live avatars use HTML z's) */
  private applyZs(m: FaceMotion): void {
    for (let i = 0; i < 3 && i < this.zs.length; i++) {
      const z = this.zs[i];
      if (m.zzz <= 0.01) {
        z.o.set(0);
        continue;
      }
      const u = (m.t / 2.6 + i / 3) % 1;
      const s = 0.5 + u * 0.65;
      z.x.set(s, 0, 0, s, 100 + u * 26 + Math.sin(u * 7 + i) * 3, 48 - u * 46);
      z.o.set(m.zzz * Math.sin(Math.PI * u) * 1.1);
    }
  }
}

/** expression target for a face: the preset plus that face's own tweaks */
function exprTarget(face: FaceSpec, e: Expr, out: Float32Array | number[]): void {
  const src = PRESETS[e];
  for (let i = 0; i < P.N; i++) out[i] = src[i];
  if (face.smirk && e === 'idle') for (const [k, v] of SMIRK_IDLE) out[k] = v;
  if (face.cool && (e === 'idle' || e === 'smug' || e === 'thinking')) out[P.LID] = Math.max(out[P.LID], 0.24);
}

/** Static face for summaries and pickers: an expression without the live loop. A number = a human face. */
export function staticFace(face: FaceSpec | number, expr: Expr = 'idle', look: { gx?: number; gy?: number } = {}): SVGSVGElement {
  const spec = asSpec(face);
  const f = new Face(spec);
  const m = restMotion();
  m.gx = look.gx ?? 0;
  m.gy = look.gy ?? 0;
  const p = new Float32Array(P.N);
  exprTarget(spec, expr, p);
  f.apply(p, m);
  return f.svg;
}
export type { Expr as AvatarExpr };

// ───────────────────────── one live avatar ─────────────────────────

interface Hop {
  t0: number;
  dur: number;
  h: number;
  n: number; // number of hops
}
interface Shake {
  t0: number;
  dur: number;
  amp: number;
  freq: number;
}

/** body transform write thresholds (viewBox units / degrees / scale) */
const EPS_Y = 0.02;
const EPS_ROT = 0.03;
const EPS_S = 0.0006;
/** a feature value counts as changed above this (viewBox units; invisible below) */
const EPS_F = 0.01;

class Avatar {
  face: Face;
  /** the plate mounts this: [shadow, idle wrapper > svg, z's] */
  readonly el: HTMLElement;
  /** carries the idle bob / sway / breathing as CSS animations (run by the compositor) */
  private idleEl: HTMLElement;
  private shadowEl: HTMLElement;
  cur = new Float32Array(P.N);
  motion = restMotion();
  // positions (CSS px), for gaze vectors
  x = 0;
  y = 0;
  // expression timeline
  expr: Expr = 'idle';
  exprUntil = 0;
  next: { expr: Expr; at: number; dur: number } | null = null;
  // sleep: 0 awake, 1 drowsy, 2 asleep
  stage = 0;
  stageAt = 0;
  sleepAt = Infinity;
  nodAt = 0;
  tilt = 0;
  tiltCur = 0;
  // blink
  blinkT0 = -1;
  blinkDur = 0.2;
  blinkEye = 0; // 0 both, 1 left, 2 right
  blinkAgain = false;
  nextBlink = rand(1, 4);
  nextWink = rand(18, 40);
  // gaze: current pupil target and head lean
  gazeX = 0;
  gazeY = 0;
  gazeUntil = 0;
  nextGlance = rand(1, 3);
  lookX = 0;
  lookY = 0;
  // motion
  bobT = rand(1.7, 2.35);
  bobP = rand(0, Math.PI * 2);
  swayT = rand(3.1, 4.5);
  swayP = rand(0, Math.PI * 2);
  hop: Hop | null = null;
  shake: Shake | null = null;
  nod: { t0: number; dur: number } | null = null;
  stretchT0 = -10;
  wigT0 = -10;
  nextWig = rand(4, 9);
  glintT0 = -10;
  nextGlint = rand(3, 8);
  /** when the asleep breathing started (keeps the mouth's breath in step with the CSS breathing) */
  asleepAt = 0;
  // what was last written, so unchanged frames write nothing
  private idleState = '';
  private lastBody = new Float32Array([0, 0, 1, 1]);
  private lastLift = 0;
  private lastP = new Float32Array(P.N).fill(NaN);
  private lastM = new Float32Array(13).fill(NaN);
  private mv = new Float32Array(13);

  constructor(readonly seat: Seat) {
    this.face = new Face(faceOfSeat(seat), true);
    this.shadowEl = document.createElement('div');
    this.shadowEl.className = 'av-shadow';
    this.idleEl = document.createElement('div');
    this.idleEl.className = 'av-idle';
    this.idleEl.append(this.face.svg);
    const zzz = document.createElement('div');
    zzz.className = 'av-zzz';
    zzz.innerHTML = '<span>z</span><span>z</span><span>z</span>';
    this.el = document.createElement('div');
    this.el.className = 'av-face';
    this.el.append(this.shadowEl, this.idleEl, zzz);
    // each face bobs and sways at its own pace (negative delays = a random phase)
    const st = this.el.style;
    st.setProperty('--bob-t', `${this.bobT.toFixed(2)}s`);
    st.setProperty('--bob-d', `${(-(this.bobP / (Math.PI * 2)) * this.bobT).toFixed(2)}s`);
    st.setProperty('--sway-t', `${this.swayT.toFixed(2)}s`);
    st.setProperty('--sway-d', `${(-(this.swayP / (Math.PI * 2)) * this.swayT).toFixed(2)}s`);
    this.el.classList.toggle('alien', !!this.face.spec.alien);
    exprTarget(this.face.spec, 'idle', this.cur);
  }

  /** swap to another face (the human's pick, or the character seated here) */
  setFace(spec: FaceSpec): void {
    if (this.face.spec === spec) return;
    this.face = new Face(spec, true);
    this.idleEl.replaceChildren(this.face.svg);
    this.el.classList.toggle('alien', !!spec.alien);
    this.motion = restMotion();
    this.lastP.fill(NaN);
    this.lastBody.set([0, 0, 1, 1]);
  }

  /** aliens rarely sleep */
  get sleepDelay(): number {
    return this.face.spec.alien ? 32 : 0;
  }

  baseExpr(): Expr {
    return this.stage === 2 ? 'asleep' : this.stage === 1 ? 'sleepy' : 'idle';
  }

  /** which CSS idle motion runs: 'awake' bob, 'drowsy' (smaller bob), 'asleep' breathing, 'still' */
  setIdle(state: 'awake' | 'drowsy' | 'asleep' | 'still'): void {
    if (state === this.idleState) return;
    const cl = this.el.classList;
    if (this.idleState) cl.remove(`av-${this.idleState}`);
    cl.add(`av-${state}`);
    this.idleState = state;
  }

  /** reaction motion (hops, shakes, nods, lean) as one CSS transform on the <svg>; false = unchanged */
  writeBody(y: number, rot: number, sx: number, sy: number): boolean {
    const L = this.lastBody;
    if (Math.abs(y - L[0]) < EPS_Y && Math.abs(rot - L[1]) < EPS_ROT && Math.abs(sx - L[2]) < EPS_S && Math.abs(sy - L[3]) < EPS_S) return false;
    L[0] = y;
    L[1] = rot;
    L[2] = sx;
    L[3] = sy;
    const rest = Math.abs(y) < EPS_Y && Math.abs(rot) < EPS_ROT && Math.abs(sx - 1) < EPS_S && Math.abs(sy - 1) < EPS_S;
    // translate in % of the face box (viewBox 140 wide; Papi Zorg's 166)
    const u = this.face.spec.alien ? 100 / 166 : 100 / 140;
    this.face.svg.style.transform = rest ? '' : `translate(0,${(y * u).toFixed(2)}%) rotate(${rot.toFixed(2)}deg) scale(${sx.toFixed(4)},${sy.toFixed(4)})`;
    return true;
  }

  /** the ground shadow shrinks and fades while the head is in the air (hops only) */
  writeShadow(lift: number): void {
    if (Math.abs(lift - this.lastLift) < 0.05) return;
    this.lastLift = lift;
    const st = this.shadowEl.style;
    if (lift < 0.05) {
      st.transform = '';
      st.opacity = '';
      return;
    }
    st.transform = `scaleX(${(1 - lift * 0.012).toFixed(3)})`;
    st.opacity = (1 - lift * 0.014).toFixed(3);
  }

  /** write the face's features only when the expression or a feature motion actually changed */
  applyFace(alienT: boolean): boolean {
    const p = this.cur;
    const m = this.motion;
    const lp = this.lastP;
    const lm = this.lastM;
    // gaze/feature shift, blinks, breath, moustache, droop, antenna glow/sway, glint, (alien: halo clock)
    const mv = this.mv;
    mv[0] = m.fx;
    mv[1] = m.fy;
    mv[2] = m.gx;
    mv[3] = m.gy;
    mv[4] = m.blinkL;
    mv[5] = m.blinkR;
    mv[6] = m.breath;
    mv[7] = m.wig;
    mv[8] = m.droop;
    mv[9] = m.glow;
    mv[10] = m.ant;
    mv[11] = m.glint;
    mv[12] = alienT ? m.t : 0;
    let changed = false;
    for (let i = 0; i < P.N && !changed; i++) if (!(Math.abs(p[i] - lp[i]) <= EPS_F)) changed = true;
    for (let i = 0; i < 13 && !changed; i++) if (!(Math.abs(mv[i] - lm[i]) <= EPS_F)) changed = true;
    if (!changed) return false;
    lp.set(p);
    lm.set(mv);
    this.face.apply(p, m);
    return true;
  }
}

// ───────────────────────── controller ─────────────────────────

/**
 * Cost knobs per graphics level. Idle motion (bob, sway, breathing, z's) is CSS — the compositor runs
 * it — so the script only works while something actually changes on a face:
 * - activeFps: frame cap while a reaction plays (hop, shake, expression morph)
 * - idleFps: frame cap for idle micro-behaviours (blinks, glances, head lean, twitches, nods)
 * - ambientFps: continuous feature motion that cannot be CSS (antenna sway, a sleeper's breathing
 *   mouth); 0 = those parts hold still
 * - pollMs: with nothing moving, the loop leaves requestAnimationFrame and only checks its schedule
 *   (next blink, glance, nod-off…) this often
 * - lazy / blinkLazy: idle micro-behaviours (glances, winks, twitches, glints / blinks) come this many
 *   times less often
 * - react: reaction expressions last this fraction of their normal time
 */
const LEVELS = {
  high: { activeFps: 60, idleFps: 60, ambientFps: 30, pollMs: 100, lazy: 1, blinkLazy: 1, react: 1 },
  medium: { activeFps: 60, idleFps: 30, ambientFps: 15, pollMs: 120, lazy: 1.3, blinkLazy: 1.1, react: 1 },
  low: { activeFps: 30, idleFps: 15, ambientFps: 0, pollMs: 200, lazy: 2, blinkLazy: 1.4, react: 0.75 },
} as const;
type Level = keyof typeof LEVELS;

/** dev measurement: main-thread ms spent in avatar updates, ticks, face (SVG) writes, CSS writes */
export const AV_STATS = { ms: 0, frames: 0, applies: 0, css: 0 };
if (import.meta.env?.DEV && typeof window !== 'undefined') {
  (window as unknown as { __avStats: typeof AV_STATS }).__avStats = AV_STATS;
  // ?avperf: log the avatars' cost every 5 s
  if (new URLSearchParams(location.search).has('avperf')) {
    let last = { ...AV_STATS };
    setInterval(() => {
      const d = (k: keyof typeof AV_STATS) => (AV_STATS[k] - last[k]) / 5;
      console.debug(
        `[avatars] ${d('ms').toFixed(2)} ms/s · ${d('frames').toFixed(1)} ticks/s · ${d('applies').toFixed(1)} face writes/s · ${d('css').toFixed(1)} css writes/s · ${document.documentElement.dataset.quality}`,
      );
      last = { ...AV_STATS };
    }, 5000);
  }
}

type HandEnd = Extract<GameEvent, { type: 'handEnd' }>;

export class AvatarController {
  private av: Avatar[];
  private time = 0;
  private raf = 0;
  private lastNow = 0;
  private enabled = true;
  private visible = false;
  private paused = false;
  private reduced = false;
  private quiet = false;
  private turn: Seat | null = null;
  private center = { x: 0, y: 0 };
  private lastEvent: GameEvent | null = null;
  private tgt = new Float32Array(P.N);

  constructor() {
    this.av = ([0, 1, 2, 3] as Seat[]).map((s) => new Avatar(s));
    document.addEventListener('visibilitychange', () => this.kick());
  }

  /** the human's chosen face (Ajustes → Avatares) */
  setHumanFace(i: number): void {
    setHumanFace(i);
    this.av[0].setFace(faceOfSeat(0));
    this.kick();
  }

  /** the character seated at a CPU seat */
  setSeatFace(seat: 1 | 2 | 3, spec: FaceSpec): void {
    seatFaces[seat] = spec;
    this.av[seat].setFace(spec);
    this.kick();
  }

  /** the face element for a seat (mounted by the name plates) */
  faceEl(seat: Seat): HTMLElement {
    return this.av[seat].el;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.kick();
  }
  setReducedMotion(r: boolean): void {
    this.reduced = r;
    this.kick();
  }
  setPaused(p: boolean): void {
    this.paused = p;
    this.kick();
  }
  /** replaying a saved hand: keep the state right but do not react */
  setQuiet(q: boolean): void {
    this.quiet = q;
  }
  setVisible(v: boolean): void {
    if (v === this.visible) return;
    this.visible = v;
    this.kick();
  }

  /** plate centres (CSS px) and the table centre, for glances */
  setPositions(plates: readonly SeatPlate[], center: { x: number; y: number }): void {
    for (let s = 0; s < 4; s++) {
      const p = plates[s];
      const a = this.av[s];
      // the face sits at the left of a row plate, at the top of a stack plate
      a.x = p.layout === 'row' ? p.x - p.w / 2 + p.d / 2 : p.x;
      a.y = p.layout === 'row' ? p.y : p.y - p.h / 2 + p.d / 2;
    }
    this.center.x = center.x;
    this.center.y = center.y;
  }

  /** back to calm, awake faces (new match / menu) */
  reset(): void {
    this.turn = null;
    this.lastEvent = null;
    for (const a of this.av) {
      a.stage = 0;
      a.sleepAt = Infinity;
      a.expr = 'idle';
      a.exprUntil = 0;
      a.next = null;
      a.hop = a.shake = a.nod = null;
      a.tilt = 0;
    }
    this.kick();
  }

  // ───────── game hooks ─────────

  onTurn(seat: Seat | null): void {
    this.turn = seat;
    const t = this.time;
    if (seat === null) {
      for (const a of this.av) a.sleepAt = Infinity;
      return;
    }
    // fresh sleep schedule: the waiting seats nod off one after another, in a random order
    const order = this.av.filter((a) => a.seat !== seat).sort(() => Math.random() - 0.5);
    order.forEach((a, k) => {
      if (a.stage === 0) a.sleepAt = t + 11 + k * 4 + rand(0, 1.4) + a.sleepDelay;
    });
    const me = this.av[seat];
    me.sleepAt = Infinity;
    if (this.quiet) return;
    if (me.stage > 0) this.wake(me, 'gentle');
    if (seat !== 0) this.setExpr(me, 'thinking', 8, rand(0.15, 0.35));
    else this.glance(me, 0, 0.9, rand(0.9, 1.6)); // the human's face peeks down at the hand
    for (const a of this.av) {
      if (a === me || a.stage > 0) continue;
      if (Math.random() < 0.6) this.lookAtSeat(a, seat, rand(0.12, 0.6), rand(0.9, 2));
    }
    this.kick();
  }

  /** a seat's own turn begins (the human): brows up, a bright look and a tiny hop */
  perk(seat: Seat): void {
    if (this.quiet) return;
    const a = this.av[seat];
    if (a.stage > 0) this.wake(a, 'gentle');
    this.setExpr(a, 'perk', 0.9);
    this.hopOnce(a, 4.5, 0.4, this.time + 0.02);
    this.kick();
  }

  onEvent(ev: GameEvent, replay: boolean): void {
    const prev = this.lastEvent;
    this.lastEvent = ev;
    if (replay || this.quiet) {
      if (ev.type === 'handStart') for (const a of this.av) this.calm(a);
      return;
    }
    const t = this.time;
    switch (ev.type) {
      case 'handStart':
        for (const a of this.av) {
          if (a.stage > 0) this.wake(a, 'gentle');
          else this.calm(a);
          this.lookAtCenter(a, rand(0.1, 0.5), rand(0.8, 1.6));
        }
        break;
      case 'play': {
        const me = this.av[ev.seat];
        if (me.expr === 'thinking') this.setExpr(me, 'idle', 0);
        if (ev.slam || ev.finishing) this.setExpr(me, 'angry', 2.2);
        for (const a of this.av) if (a !== me && a.stage === 0) this.lookAtSeat(a, ev.seat, rand(0, 0.15), rand(0.3, 0.5));
        break;
      }
      case 'pass': {
        const me = this.av[ev.seat];
        if (me.stage > 0) this.wake(me, 'gentle');
        this.setExpr(me, 'sad', 1.5);
        if (!this.reduced) me.shake = { t0: t + 0.1, dur: 0.75, amp: 6, freq: 3.2 };
        // the player who forced it (previous seat, an opponent) is pleased; everyone else is impressed
        const forcer = prev && prev.type === 'play' && prev.seat === ((ev.seat + 3) % 4) ? this.av[prev.seat] : null;
        for (const a of this.av) {
          if (a === me) continue;
          if (a.stage > 0) continue;
          if (a === forcer) this.setExpr(a, 'smug', 1.4, 0.15);
          else if (forcer) {
            this.setExpr(a, 'amazed', 0.8, rand(0.05, 0.25));
            this.hopOnce(a, 4, 0.42, t + 0.1);
          }
          this.lookAtSeat(a, ev.seat, rand(0, 0.2), rand(0.8, 1.4));
        }
        break;
      }
      case 'handEnd':
        this.onHandEnd(ev);
        break;
      case 'matchEnd':
        for (const a of this.av) {
          if (a.stage > 0) this.wake(a, 'gentle');
          const won = a.seat % 2 === ev.winner;
          a.next = null;
          this.setExpr(a, won ? 'happy' : 'sad', 5, rand(0, 0.2));
          if (won) this.hopOnce(a, 9, 0.5, t + rand(0.05, 0.25), 3);
          a.gazeX = 0;
          a.gazeY = won ? -0.3 : 0.7;
          a.gazeUntil = t + 4;
        }
        break;
    }
    this.kick();
  }

  private onHandEnd(ev: HandEnd): void {
    const t = this.time;
    const big = ev.reason === 'blocked' || ev.bonuses.length > 0;
    for (const a of this.av) {
      if (a.stage > 0) this.wake(a, big ? 'startle' : 'gentle');
      a.sleepAt = Infinity;
      const team = a.seat % 2;
      const res: Expr = ev.winnerTeam === null ? 'meh' : team === ev.winnerTeam ? 'happy' : 'sad';
      const lead = big ? 0.9 : 0.25;
      if (big) {
        this.setExpr(a, 'amazed', lead, rand(0, 0.12));
        this.hopOnce(a, 6, 0.45, t + rand(0.02, 0.15));
      }
      // the result follows the surprise
      a.next = { expr: res, at: t + lead + rand(0, 0.25), dur: 2.6 };
      if (res === 'happy') this.hopOnce(a, 8, 0.5, t + lead + 0.1, 2);
      this.lookAtCenter(a, rand(0, 0.2), lead + 0.6);
    }
  }

  /** a tile hit the table (from the renderer, at the moment of impact) */
  onImpact(seat: Seat, kind: 'clack' | 'slam' | 'finish'): void {
    if (this.quiet) return;
    const t = this.time;
    for (const a of this.av) {
      if (a.seat === seat) {
        if (kind !== 'clack') {
          // the slammer stays determined a beat, then a pleased look
          this.setExpr(a, 'angry', 0.45);
          a.next = { expr: kind === 'finish' ? 'happy' : 'smug', at: t + 0.45, dur: kind === 'finish' ? 1.6 : 0.9 };
          if (!this.reduced) a.hop = { t0: t, dur: 0.3, h: 2.5, n: 1 };
        }
        continue;
      }
      if (kind === 'clack') {
        // the click wakes sleepers gently; awake ones glance at the table
        if (a.stage > 0) this.wake(a, 'gentle', rand(0.05, 0.6));
        else if (Math.random() < 0.55) this.lookAtCenter(a, rand(0, 0.12), rand(0.5, 1.1));
        continue;
      }
      if (a.stage > 0) this.wake(a, 'startle');
      else {
        this.setExpr(a, 'amazed', kind === 'finish' ? 1.1 : 0.85, rand(0, 0.08));
        this.hopOnce(a, kind === 'finish' ? 8 : 6, 0.42, t + rand(0, 0.08));
        this.lookAtCenter(a, 0, 1.1);
      }
    }
    this.kick();
  }

  // ───────── behaviours ─────────

  private setExpr(a: Avatar, e: Expr, dur: number, delay = 0): void {
    // low quality: reactions are kept but shorter (the 'thinking' hold lasts the whole CPU turn)
    if (e !== 'thinking') dur *= this.cfg.react;
    if (delay > 0) {
      a.next = { expr: e, at: this.time + delay, dur };
      return;
    }
    a.next = null;
    a.expr = e;
    a.exprUntil = this.time + dur;
  }

  private calm(a: Avatar): void {
    a.stage = 0;
    a.expr = 'idle';
    a.exprUntil = 0;
    a.next = null;
    a.tilt = 0;
  }

  private hopOnce(a: Avatar, h: number, dur: number, t0: number, n = 1): void {
    if (this.reduced) return;
    a.hop = { t0, dur, h, n: this.cfg.react < 1 ? Math.min(n, 2) : n };
  }

  private wake(a: Avatar, how: 'gentle' | 'startle', delay = 0): void {
    const t = this.time;
    a.stage = 0;
    a.tilt = 0;
    a.nod = null;
    a.sleepAt = this.turn !== null && this.turn !== a.seat ? t + rand(10, 14) + a.sleepDelay : Infinity;
    if (how === 'startle') {
      a.next = null;
      a.expr = 'amazed';
      a.exprUntil = t + 1.15;
      if (!this.reduced) {
        a.hop = { t0: t, dur: 0.5, h: 15, n: 1 };
        a.shake = { t0: t + 0.42, dur: 0.5, amp: 7, freq: 8 };
      }
      a.gazeX = 0;
      a.gazeY = 0;
      a.gazeUntil = t + 1;
      a.blinkT0 = -1;
    } else {
      // open the eyes, a little stretch and a double blink
      a.expr = 'idle';
      a.exprUntil = 0;
      a.stretchT0 = t + delay;
      a.blinkT0 = t + delay + 0.35;
      a.blinkDur = 0.22;
      a.blinkEye = 0;
      a.blinkAgain = true;
    }
  }

  private dirTo(a: Avatar, x: number, y: number, out: { x: number; y: number }): void {
    const dx = x - a.x;
    const dy = y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const k = Math.min(1, len / 90);
    out.x = (dx / len) * k;
    out.y = (dy / len) * k;
  }
  private tmp = { x: 0, y: 0 };

  private lookAtSeat(a: Avatar, seat: number, delay: number, hold: number): void {
    const o = this.av[seat];
    this.dirTo(a, o.x, o.y, this.tmp);
    this.glance(a, this.tmp.x, this.tmp.y, hold, delay);
  }
  private lookAtCenter(a: Avatar, delay: number, hold: number): void {
    this.dirTo(a, this.center.x, this.center.y, this.tmp);
    this.glance(a, this.tmp.x, this.tmp.y, hold, delay);
  }
  private pending: { a: Avatar; x: number; y: number; at: number; hold: number }[] = [];
  private glance(a: Avatar, x: number, y: number, hold: number, delay = 0): void {
    if (delay > 0) {
      const i = this.pending.findIndex((p) => p.a === a);
      const item = { a, x, y, at: this.time + delay, hold };
      if (i >= 0) this.pending[i] = item;
      else this.pending.push(item);
      return;
    }
    a.gazeX = x;
    a.gazeY = y;
    a.gazeUntil = this.time + hold;
    a.nextGlance = this.time + hold + rand(0.6, 2.4) * this.cfg.lazy;
  }

  // ───────── loop ─────────

  /** freeze while a summary card covers the table */
  setHold(h: boolean): void {
    this.hold = h;
    this.kick();
  }
  private hold = false;

  private get running(): boolean {
    return this.enabled && this.visible && !this.paused && !this.hold && !document.hidden;
  }

  /** graphics level: frame caps and how busy the idle faces are (see LEVELS) */
  setQuality(q: Level): void {
    if (!LEVELS[q]) return;
    setMiniQuality(q);
    if (q === this.level) return;
    this.level = q;
    this.cfg = LEVELS[q];
    this.kick();
  }
  private level: Level = 'high';
  private cfg: (typeof LEVELS)[Level] = LEVELS.high;
  private timer = 0;
  private reacting = false;

  private kick(): void {
    const run = this.running;
    // CSS idle motion pauses with the loop (pause menu, summary card, hidden)
    for (const a of this.av) a.el.classList.toggle('av-paused', !run);
    if (!run) {
      if (this.raf) cancelAnimationFrame(this.raf);
      if (this.timer) clearTimeout(this.timer);
      this.raf = this.timer = 0;
      this.lastNow = 0;
      return;
    }
    if (this.raf) return;
    // an event while the loop only polls: switch to frames right away
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = 0;
    }
    this.raf = requestAnimationFrame(this.tick);
  }

  private onTimer = (): void => {
    this.timer = 0;
    this.tick(performance.now());
  };

  private tick = (now: number): void => {
    this.raf = 0;
    if (!this.running) return;
    const cfg = this.cfg;
    // frame cap: reactions at activeFps, idle micro-behaviours at idleFps
    const fps = this.reacting ? cfg.activeFps : cfg.idleFps;
    if (this.lastNow && fps < 60 && now - this.lastNow < 1000 / fps - 4) {
      this.raf = requestAnimationFrame(this.tick);
      return;
    }
    const t0 = performance.now();
    let dt = this.lastNow ? (now - this.lastNow) / 1000 : 1 / 60;
    this.lastNow = now;
    if (dt > 0.25) dt = 0.25;
    if (dt < 0) dt = 0;
    this.time += dt;
    let active = false;
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i];
      if (p.at <= this.time) {
        this.pending.splice(i--, 1);
        this.glance(p.a, p.x, p.y, p.hold);
      } else if (p.at - this.time < 0.3) active = true;
    }
    let ambient = false;
    let micro = false;
    for (const a of this.av) {
      const r = this.step(a, dt);
      if (r & 1) active = true;
      if (r & 2) ambient = true;
      if (r & 4) micro = true;
    }
    this.reacting = active;
    active ||= micro;
    AV_STATS.frames++;
    AV_STATS.ms += performance.now() - t0;
    if (active) this.raf = requestAnimationFrame(this.tick);
    else this.timer = window.setTimeout(this.onTimer, ambient && cfg.ambientFps ? 1000 / cfg.ambientFps : cfg.pollMs);
  };

  /**
   * One avatar's update. Returns bit 1 = a reaction plays (activeFps), bit 4 = an idle micro-behaviour
   * plays (blink, glance, twitch: idleFps), bit 2 = ambient feature motion (ambientFps). Writes to the
   * DOM only what changed.
   */
  private step(a: Avatar, dt: number): number {
    const t = this.time;
    const m = a.motion;
    const rm = this.reduced;
    const cfg = this.cfg;
    let active = false; // a reaction plays (full frame rate)
    let micro = false; // a blink / glance / twitch plays (idle frame rate)
    const ease = (v: number, target: number, kk: number, eps: number, idle = false): number => {
      const d = target - v;
      if (Math.abs(d) < eps) return target;
      if (idle) micro = true;
      else active = true;
      return v + d * kk;
    };

    // sleep progression (only while the game waits on someone else)
    if (!this.quiet && this.turn !== null && a.seat !== this.turn) {
      if (a.stage === 0 && t >= a.sleepAt && a.expr === 'idle' && !a.next) {
        a.stage = 1;
        a.stageAt = t;
        a.nodAt = t + rand(1.2, 2);
      } else if (a.stage === 1 && t >= a.stageAt + 5.2) {
        a.stage = 2;
        a.stageAt = t;
        a.asleepAt = t;
        a.tilt = (Math.random() < 0.5 ? -1 : 1) * rand(5, 8);
      }
    }

    // expression timeline
    if (a.next && t >= a.next.at) {
      a.expr = a.next.expr;
      a.exprUntil = t + a.next.dur;
      a.next = null;
    }
    if (a.next && a.next.at - t < 0.3) active = true;
    if (a.expr !== a.baseExpr() && t >= a.exprUntil && !a.next) a.expr = a.baseExpr();
    const tg = this.tgt;
    exprTarget(a.face.spec, a.expr, tg);
    if (a.stage === 1 && a.expr === 'sleepy') {
      // lids get heavier through the drowsy phase; after each nod they pop open a little
      const k = clamp((t - a.stageAt) / 5, 0, 1);
      let lid = 0.85 + 0.25 * k;
      if (a.nod) {
        const u = (t - a.nod.t0) / a.nod.dur;
        if (u > 0.55 && u < 1) lid -= 0.45 * Math.sin(((u - 0.55) / 0.45) * Math.PI);
      }
      tg[P.DROWSY] = lid;
    }
    // moustache twitch now and then (idle only)
    if (!rm && a.face.spec.stache) {
      if (t >= a.nextWig && a.stage === 0 && a.expr === 'idle') {
        a.wigT0 = t;
        a.nextWig = t + rand(4, 10) * cfg.lazy;
      }
      const wu = (t - a.wigT0) / 0.7;
      const on = wu >= 0 && wu < 1;
      m.wig = on ? Math.sin(wu * Math.PI * 5) * (1 - wu) * 6 : 0;
      if (on) micro = true;
    } else m.wig = 0;
    // aviator glint now and then (and on demand, see glintNow); antennae sway and glow
    const spec = a.face.spec;
    if (spec.aviators) {
      if (!rm && t >= a.nextGlint && a.stage === 0) {
        a.glintT0 = t;
        a.nextGlint = t + rand(5, 11) * cfg.lazy;
      }
      const gu = (t - a.glintT0) / 0.65;
      m.glint = gu >= 0 && gu <= 1 ? gu : -1;
      if (m.glint >= 0) micro = true;
    }
    const droopT = a.stage === 2 ? 1 : a.stage === 1 ? 0.35 : 0;
    m.droop = ease(m.droop, droopT, 1 - Math.exp(-dt * 2.2), 0.004, true);
    const ambientOn = cfg.ambientFps > 0 && !rm;
    let ambient = false;
    if (spec.alien) {
      m.glow = ease(m.glow, a.expr === 'thinking' ? 1 : 0, 1 - Math.exp(-dt * 4), 0.004, true);
      m.ant = ambientOn ? Math.sin(t * 1.9 + a.bobP) * 3.2 + Math.sin(t * 3.1 + a.swayP) * 1.2 : 0;
      if (ambientOn) ambient = true;
    }
    // ease toward the target (expression changes read as quick, soft morphs); snap when close
    const k = 1 - Math.exp(-dt * (rm ? 18 : 13));
    const cur = a.cur;
    for (let i = 0; i < P.N; i++) cur[i] = ease(cur[i], tg[i], k, EPS_F);

    // blink / wink scheduler
    if (a.blinkT0 < 0 && t >= a.nextBlink && a.stage < 2 && a.expr !== 'happy') {
      a.blinkT0 = t;
      a.blinkEye = 0;
      a.blinkDur = a.stage === 1 ? 0.42 : rand(0.17, 0.23);
      a.blinkAgain = a.stage === 0 && Math.random() < 0.16;
    }
    if (a.blinkT0 < 0 && t >= a.nextWink && a.stage === 0 && a.expr === 'idle' && !rm) {
      a.blinkT0 = t;
      a.blinkEye = Math.random() < 0.5 ? 1 : 2;
      a.blinkDur = 0.5;
      a.blinkAgain = false;
      a.nextWink = t + rand(25, 55) * cfg.lazy;
      a.next = { expr: 'smug', at: t, dur: 0.55 };
    }
    let b = 0;
    if (a.blinkT0 >= 0) {
      micro = true;
      if (t >= a.blinkT0) {
        const u = (t - a.blinkT0) / a.blinkDur;
        // fast close, short hold, slower open
        b = u < 0.32 ? smooth(0, 0.32, u) : u < 0.45 ? 1 : 1 - smooth(0.45, 1, u);
        if (u >= 1) {
          b = 0;
          if (a.blinkAgain) {
            a.blinkAgain = false;
            a.blinkT0 = t + 0.07;
          } else {
            a.blinkT0 = -1;
            a.nextBlink = t + (a.stage === 1 ? rand(1.2, 2.2) : rand(2.2, 6.2) * cfg.blinkLazy);
          }
        }
      }
    }
    m.blinkL = a.blinkEye === 2 ? 0 : b;
    m.blinkR = a.blinkEye === 1 ? 0 : b;

    // glances
    if (!rm) {
      if (t >= a.gazeUntil && a.gazeUntil > 0) {
        a.gazeX = a.gazeY = 0;
        a.gazeUntil = 0;
      }
      if (t >= a.nextGlance && a.stage === 0 && a.expr === 'idle') {
        const r = Math.random();
        if (r < 0.38 && this.turn !== null && this.turn !== a.seat) this.lookAtSeat(a, this.turn, 0, rand(0.9, 2));
        else if (r < 0.52) this.lookAtCenter(a, 0, rand(0.8, 1.6));
        else if (r < 0.78) this.glance(a, rand(-0.6, 0.6), rand(-0.45, 0.45), rand(0.5, 1.3));
        else this.glance(a, 0, 0, rand(0.8, 2)); // at the viewer
      }
    } else a.gazeX = a.gazeY = 0;
    const asleep = a.stage === 2;
    const gTargetX = asleep || rm ? 0 : a.gazeX;
    const gTargetY = asleep || rm ? 0 : a.gazeY;
    const ks = 1 - Math.exp(-dt * 24); // saccade
    const kh = 1 - Math.exp(-dt * 4.5); // head follows slowly
    m.gx = ease(m.gx, gTargetX * 3.3, ks, EPS_F, true);
    m.gy = ease(m.gy, gTargetY * 2.8, ks, EPS_F, true);
    // the head lean's long tail is invisible below ~0.015 (0.08° / 0.05 units): snap there
    a.lookX = ease(a.lookX, gTargetX, kh, 0.015, true);
    a.lookY = ease(a.lookY, gTargetY, kh, 0.015, true);

    // idle motion is CSS (bob / drowsy bob / breathing / z's); the script adds reactions on top
    a.setIdle(rm ? 'still' : asleep ? 'asleep' : a.stage === 1 ? 'drowsy' : 'awake');
    if (rm) {
      m.fx = m.fy = 0;
      m.breath = 0;
      m.t = 0.35;
      if (a.writeBody(0, 0, 1, 1)) AV_STATS.css++;
      a.writeShadow(0);
      if (a.applyFace(false)) AV_STATS.applies++;
      return (active ? 1 : 0) | (micro ? 4 : 0);
    }
    let y = 0;
    let rot = 0;
    let sx = 1;
    let sy = 1;
    let fy = 0;
    if (asleep) {
      // the mouth breathes with the body (CSS breathing: 3.6 s cycle starting with the out-breath)
      m.breath = ambientOn ? -Math.cos(((t - a.asleepAt) / 3.6) * Math.PI * 2) : 0;
      if (ambientOn) ambient = true;
      fy = 2;
    } else m.breath = 0;
    a.tiltCur = ease(a.tiltCur, a.tilt, 1 - Math.exp(-dt * 2.5), 0.02, true);
    rot += a.tiltCur + a.lookX * 5;
    // drowsy nods
    if (a.stage === 1) {
      if (!a.nod && t >= a.nodAt) a.nod = { t0: t, dur: 1.15 };
      if (a.nod) {
        const u = (t - a.nod.t0) / a.nod.dur;
        if (u >= 1) {
          a.nod = null;
          a.nodAt = t + rand(1.3, 2.3);
        } else {
          // slow sink, quick jerk back up
          const s = u < 0.65 ? smooth(0, 0.65, u) : 1 - smooth(0.65, 0.85, u);
          fy += 4.5 * s;
          y += 2.2 * s;
          rot += 3 * s * (a.seat % 2 ? 1 : -1);
          micro = true;
        }
      }
    }
    // stretch on a gentle wake-up
    const su = (t - a.stretchT0) / 0.7;
    if (su >= -0.5 && su < 1) {
      active = true;
      if (su >= 0) {
        const s = Math.sin(su * Math.PI);
        sy *= 1 + 0.07 * s;
        sx *= 1 - 0.04 * s;
        y -= 2 * s;
      }
    }
    // hops (anticipation squash, flight with stretch, landing squash)
    const hp = a.hop;
    if (hp) {
      active = true;
      if (t >= hp.t0) {
        const total = hp.dur * hp.n;
        const ut = (t - hp.t0) / hp.dur;
        if (t - hp.t0 >= total) a.hop = null;
        else {
          const i = Math.floor(ut);
          const u = ut - i;
          const h = hp.h * (i === 0 ? 1 : 0.7);
          if (u < 0.16) {
            const s = Math.sin((u / 0.16) * Math.PI);
            sy *= 1 - 0.09 * s;
            sx *= 1 + 0.07 * s;
          } else if (u < 0.86) {
            const v = (u - 0.16) / 0.7;
            y -= h * Math.sin(v * Math.PI);
            const st = Math.cos(v * Math.PI) * 0.05;
            sy *= 1 + Math.abs(st);
            sx *= 1 - Math.abs(st) * 0.6;
          } else {
            const s = Math.sin(((u - 0.86) / 0.14) * Math.PI);
            sy *= 1 - 0.07 * s;
            sx *= 1 + 0.05 * s;
          }
        }
      }
    }
    // head shakes
    const sk = a.shake;
    if (sk) {
      active = true;
      if (t >= sk.t0) {
        const u = (t - sk.t0) / sk.dur;
        if (u >= 1) a.shake = null;
        else rot += Math.sin(u * Math.PI * 2 * sk.freq * sk.dur) * sk.amp * (1 - u);
      }
    }
    if (a.writeBody(y, rot, sx, sy)) AV_STATS.css++;
    a.writeShadow(clamp(-y, 0, 40));
    m.fx = a.lookX * 3.6;
    m.fy = fy + a.lookY * 2.6;
    m.t = ambientOn ? t : 0;
    if (a.applyFace(!!spec.alien && ambientOn)) AV_STATS.applies++;
    return (active ? 1 : 0) | (ambient ? 2 : 0) | (micro ? 4 : 0);
  }
}


// ───────────────────────── small live faces (pickers / cards) ─────────────────────────

interface Mini {
  face: Face;
  p: Float32Array;
  tg: Float32Array;
  m: FaceMotion;
  expr: Expr;
  phase: number;
  nextBlink: number;
  blinkT0: number;
  nextGlance: number;
  gx: number;
  gy: number;
  glintT0: number;
  nextGlint: number;
  born: number;
}
const minis = new Set<Mini>();
let miniRaf = 0;
let miniT = 0;
let miniLast = 0;
/** frame cap of the small live faces per graphics level */
const MINI_FPS = { low: 20, medium: 30, high: 60 };
let miniFps = 60;
function setMiniQuality(q: Level): void {
  miniFps = MINI_FPS[q] ?? 60;
}

function miniTick(now: number): void {
  miniRaf = 0;
  if (miniLast && miniFps < 60 && now - miniLast < 1000 / miniFps - 4) {
    if (minis.size && !document.hidden) miniRaf = requestAnimationFrame(miniTick);
    return;
  }
  const dt = miniLast ? Math.min(0.05, (now - miniLast) / 1000) : 1 / 60;
  miniLast = now;
  miniT += dt;
  const t = miniT;
  const reduced = document.documentElement.classList.contains('reduce-motion');
  for (const s of minis) {
    if (!s.face.svg.isConnected) {
      if (t - s.born > 1) minis.delete(s);
      continue;
    }
    exprTarget(s.face.spec, s.expr, s.tg);
    const k = 1 - Math.exp(-dt * 12);
    for (let i = 0; i < P.N; i++) s.p[i] += (s.tg[i] - s.p[i]) * k;
    const m = s.m;
    // blink
    if (s.blinkT0 < 0 && t >= s.nextBlink) s.blinkT0 = t;
    let b = 0;
    if (s.blinkT0 >= 0) {
      const u = (t - s.blinkT0) / 0.2;
      b = u < 0.32 ? smooth(0, 0.32, u) : u < 0.45 ? 1 : 1 - smooth(0.45, 1, u);
      if (u >= 1) {
        s.blinkT0 = -1;
        s.nextBlink = t + rand(2.4, 5.5);
        b = 0;
      }
    }
    m.blinkL = m.blinkR = b;
    // glances
    if (!reduced && t >= s.nextGlance) {
      const r = Math.random();
      s.gx = r < 0.6 ? rand(-0.7, 0.7) : 0;
      s.gy = r < 0.6 ? rand(-0.4, 0.4) : 0;
      s.nextGlance = t + rand(1, 2.6);
    }
    const ks = 1 - Math.exp(-dt * 18);
    m.gx += (s.gx * 3.2 - m.gx) * ks;
    m.gy += (s.gy * 2.6 - m.gy) * ks;
    m.fx = m.gx * 0.9;
    m.fy = m.gy * 0.8;
    // idle bob + sway
    if (!reduced) {
      const kk = 0.5 - 0.5 * Math.cos((t / 2) * Math.PI * 2 + s.phase);
      m.y = -2.2 * kk;
      m.sy = 1 - 0.022 * (1 - kk) + 0.01 * kk;
      m.sx = 1 + 0.018 * (1 - kk) - 0.007 * kk;
      m.rot = Math.sin((t / 3.6) * Math.PI * 2 + s.phase) * 1.6;
    } else {
      m.y = m.rot = 0;
      m.sx = m.sy = 1;
    }
    if (s.face.spec.aviators) {
      if (!reduced && t >= s.nextGlint) {
        s.glintT0 = t;
        s.nextGlint = t + rand(3.5, 7);
      }
      const gu = (t - s.glintT0) / 0.65;
      m.glint = gu >= 0 && gu <= 1 ? gu : -1;
    }
    if (s.face.spec.alien) {
      m.ant = reduced ? 0 : Math.sin(t * 1.9 + s.phase) * 3.2 + Math.sin(t * 3.1) * 1.2;
      m.glow = 0.15 + 0.15 * Math.sin(t * 1.3 + s.phase);
    }
    m.t = t;
    s.face.apply(s.p, m);
  }
  if (minis.size && !document.hidden) miniRaf = requestAnimationFrame(miniTick);
}

/**
 * A small live face (blinks, glances, bobs; aviator glints, antennae sway) for cards and pickers. It
 * runs on one shared frame loop and drops out by itself once its element leaves the document.
 */
export function liveFace(face: FaceSpec | number, expr: Expr = 'idle'): { el: SVGSVGElement; setExpr(e: Expr): void; glint(): void } {
  const spec = asSpec(face);
  const s: Mini = {
    face: new Face(spec),
    p: new Float32Array(P.N),
    tg: new Float32Array(P.N),
    m: restMotion(),
    expr,
    phase: rand(0, Math.PI * 2),
    nextBlink: miniT + rand(0.6, 3),
    blinkT0: -1,
    nextGlance: miniT + rand(0.5, 2),
    gx: 0,
    gy: 0,
    glintT0: -10,
    nextGlint: miniT + rand(1, 4),
    born: miniT,
  };
  exprTarget(spec, expr, s.p);
  s.face.apply(s.p, s.m);
  minis.add(s);
  if (!miniRaf) {
    miniLast = 0;
    miniRaf = requestAnimationFrame(miniTick);
  }
  return {
    el: s.face.svg,
    setExpr: (e) => {
      s.expr = e;
      if (!miniRaf) miniRaf = requestAnimationFrame(miniTick);
    },
    glint: () => {
      s.glintT0 = miniT;
    },
  };
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && minis.size && !miniRaf) {
      miniLast = 0;
      miniRaf = requestAnimationFrame(miniTick);
    }
  });
}
