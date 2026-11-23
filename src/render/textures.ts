/** Procedural canvas textures: tile atlas, felt, wood, glows, plates, popups. No external assets. */
import * as THREE from 'three';
import type { TableStyle, TileBack, TileTheme } from '../contracts';
import { MAX_TILE_ID, TILE_BY_ID } from '../engine/tiles';

export const ATLAS_COLS = 11;
export const ATLAS_ROWS = 8;
/** atlas cells (col,row from top) for the back face and the ivory side colour.
 *  Tile ids occupy cells 0..MAX_TILE_ID in id order (last one is row 7, col 5), so the
 *  back/side live in two of the unused cells at the end of the last row. */
export const BACK_CELL = { col: 6, row: 7 };
export const SIDE_CELL = { col: 7, row: 7 };

/** all pips black; the lone pip of the 1 is the only (red) accent */
const PIP_COLORS = ['#141210', '#c8231b', '#141210', '#141210', '#141210', '#141210', '#141210', '#141210', '#141210', '#141210'];

interface FacePalette {
  face0: string;
  face1: string;
  noise: number;
  grooveDark: string;
  grooveLight: string;
  pip: string;
  pipOne: string;
  recess: string;
  pipShade0: string;
  pipShade1: string;
  back0: string;
  back1: string;
  backInk: string;
  backGold: string;
  side0: string;
  side1: string;
  fill: string;
}
const THEMES: Record<TileTheme, FacePalette> = {
  classic: {
    face0: '#fbf5e8',
    face1: '#ecdfc6',
    noise: 0.05,
    grooveDark: 'rgba(70,45,20,0.55)',
    grooveLight: 'rgba(255,255,255,0.7)',
    pip: PIP_COLORS[0],
    pipOne: PIP_COLORS[1],
    recess: 'rgba(60,35,10,0.35)',
    pipShade0: 'rgba(0,0,0,0.45)',
    pipShade1: 'rgba(255,255,255,0.25)',
    back0: '#7a2a20',
    back1: '#3d100c',
    backInk: '#5a1a14',
    backGold: '#d6a64a',
    side0: '#efe3cb',
    side1: '#dccaa8',
    fill: '#e8dcc4',
  },
  dark: {
    face0: '#4f565f',
    face1: '#3e444c',
    noise: 0.07,
    grooveDark: 'rgba(0,0,0,0.6)',
    grooveLight: 'rgba(235,225,205,0.55)',
    pip: '#f4ecdb',
    pipOne: '#e2372b',
    recess: 'rgba(0,0,0,0.55)',
    pipShade0: 'rgba(0,0,0,0.28)',
    pipShade1: 'rgba(255,255,255,0.35)',
    back0: '#2a2623',
    back1: '#0e0d0c',
    backInk: '#151311',
    backGold: '#c99a45',
    side0: '#2b2724',
    side1: '#171513',
    fill: '#1d1b19',
  },
};

/** pip positions on a 3x3 grid (-1..1) */
const PIP_LAYOUT: [number, number][][] = [
  [],
  [[0, 0]],
  [[-1, -1], [1, 1]],
  [[-1, -1], [0, 0], [1, 1]],
  [[-1, -1], [1, -1], [-1, 1], [1, 1]],
  [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]],
  // six: two lines of three running along the tile's long axis (canvas x = long axis)
  [[-1, -1], [0, -1], [1, -1], [-1, 1], [0, 1], [1, 1]],
  // seven/eight/nine fill the 3x3 grid; canvas x = the tile's long axis
  [[-1, -1], [0, -1], [1, -1], [0, 0], [-1, 1], [0, 1], [1, 1]],
  [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]],
  [[-1, -1], [0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]],
];

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

let noiseCanvas: HTMLCanvasElement | null = null;
function noiseTile(): HTMLCanvasElement {
  if (noiseCanvas) return noiseCanvas;
  const [c, g] = canvas(128, 128);
  const img = g.createImageData(128, 128);
  let s = 1234567;
  for (let i = 0; i < img.data.length; i += 4) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const v = (s >> 16) & 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  noiseCanvas = c;
  return c;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function star(g: CanvasRenderingContext2D, cx: number, cy: number, r1: number, r2: number, n: number) {
  g.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? r2 : r1;
    const a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2;
    g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  g.closePath();
}

function drawFace(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, a: number, b: number, P: FacePalette) {
  // body
  const grd = g.createLinearGradient(x, y, x + w * 0.3, y + h);
  grd.addColorStop(0, P.face0);
  grd.addColorStop(1, P.face1);
  g.fillStyle = grd;
  g.fillRect(x, y, w, h);
  g.globalAlpha = P.noise;
  g.drawImage(noiseTile(), x, y, w, h);
  g.globalAlpha = 1;
  // engraved centre groove
  const cx = x + w / 2;
  g.fillStyle = P.grooveDark;
  g.fillRect(cx - w * 0.006, y + h * 0.12, w * 0.012, h * 0.76);
  g.fillStyle = P.grooveLight;
  g.fillRect(cx + w * 0.006, y + h * 0.12, w * 0.005, h * 0.76);
  // pips
  const half = w / 2;
  for (let side = 0; side < 2; side++) {
    const v = side === 0 ? a : b;
    const ox = x + side * half + half / 2;
    const oy = y + h / 2;
    const sp = h * 0.27;
    const r = h * 0.085;
    for (const [px, py] of PIP_LAYOUT[v]) {
      const X = ox + px * sp;
      const Y = oy + py * sp;
      // recess shadow
      g.fillStyle = P.recess;
      g.beginPath();
      g.arc(X + r * 0.08, Y + r * 0.12, r * 1.18, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = v === 1 ? P.pipOne : P.pip;
      g.beginPath();
      g.arc(X, Y, r, 0, Math.PI * 2);
      g.fill();
      // inner shading (concave)
      const pg = g.createRadialGradient(X - r * 0.35, Y - r * 0.4, r * 0.1, X, Y, r);
      pg.addColorStop(0, P.pipShade0);
      pg.addColorStop(0.7, 'rgba(0,0,0,0)');
      pg.addColorStop(1, P.pipShade1);
      g.fillStyle = pg;
      g.beginPath();
      g.arc(X, Y, r, 0, Math.PI * 2);
      g.fill();
    }
  }
  // brass spinner pin
  const pr = h * 0.075;
  const bg = g.createRadialGradient(cx - pr * 0.4, y + h / 2 - pr * 0.4, pr * 0.1, cx, y + h / 2, pr);
  bg.addColorStop(0, '#fff2b8');
  bg.addColorStop(0.45, '#d9a640');
  bg.addColorStop(1, '#7a5212');
  g.fillStyle = 'rgba(60,35,10,0.4)';
  g.beginPath();
  g.arc(cx + 1, y + h / 2 + 1.5, pr * 1.1, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = bg;
  g.beginPath();
  g.arc(cx, y + h / 2, pr, 0, Math.PI * 2);
  g.fill();
}

// ───────────────────────── wood grain (shared by frame, wood tabletop, wood tile back) ─────────────────────────

interface GrainOpts {
  /** base vertical gradient (top, middle, bottom) */
  base: [string, string, string];
  /** 'r,g,b' of the dark / light grain lines */
  dark: string;
  light: string;
  lines: number;
  seed: number;
  /** grain line width multiplier (relative to a 512 px canvas) */
  scale?: number;
}

function paintGrain(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, o: GrainOpts): void {
  const grd = g.createLinearGradient(0, y, 0, y + h);
  grd.addColorStop(0, o.base[0]);
  grd.addColorStop(0.5, o.base[1]);
  grd.addColorStop(1, o.base[2]);
  g.fillStyle = grd;
  g.fillRect(x, y, w, h);
  let s = o.seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const k0 = o.scale ?? Math.max(w, h) / 512;
  for (let i = 0; i < o.lines; i++) {
    const y0 = y + rnd() * h;
    const amp = (2 + rnd() * 6) * k0;
    const ph = rnd() * Math.PI * 2;
    // whole periods across the width keep the texture tileable horizontally
    const k = (Math.PI * 2 * (1 + Math.floor(rnd() * 3))) / w;
    g.strokeStyle = rnd() < 0.5 ? `rgba(${o.dark},${0.15 + rnd() * 0.25})` : `rgba(${o.light},${0.08 + rnd() * 0.12})`;
    g.lineWidth = (0.6 + rnd() * 2.2) * k0;
    g.beginPath();
    const step = Math.max(2, w / 128);
    for (let px = 0; px <= w + 0.01; px += step) {
      const py = y0 + Math.sin(px * k + ph) * amp;
      if (px === 0) g.moveTo(x + px, py);
      else g.lineTo(x + px, py);
    }
    g.stroke();
  }
  g.globalAlpha = 0.06;
  g.drawImage(noiseTile(), x, y, w, h);
  g.globalAlpha = 1;
}

// ───────────────────────── tile backs ─────────────────────────

const GOLD = '#c99a45';

/** draws one tile back into the (landscape, w = 2h) rect; clipped to it so atlas cells never bleed */
function drawBack(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, back: TileBack) {
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  const cx = x + w / 2;
  const cy = y + h / 2;
  const base = (c0: string, c1: string, noise = 0.08) => {
    const grd = g.createLinearGradient(x, y, x + w, y + h);
    grd.addColorStop(0, c0);
    grd.addColorStop(1, c1);
    g.fillStyle = grd;
    g.fillRect(x, y, w, h);
    g.globalAlpha = noise;
    g.drawImage(noiseTile(), x, y, w, h);
    g.globalAlpha = 1;
  };
  const border = (col: string, lw: number, inset = 0.07, inner?: string) => {
    g.strokeStyle = col;
    g.lineWidth = h * lw;
    roundRect(g, x + h * inset, y + h * inset, w - 2 * h * inset, h - 2 * h * inset, h * 0.1);
    g.stroke();
    if (inner) {
      g.strokeStyle = inner;
      g.lineWidth = h * 0.012;
      roundRect(g, x + h * (inset + 0.07), y + h * (inset + 0.07), w - 2 * h * (inset + 0.07), h - 2 * h * (inset + 0.07), h * 0.07);
      g.stroke();
    }
  };
  /** clip further to the area inside a border (for repeating patterns) */
  const clipInner = (inset: number) => {
    g.beginPath();
    roundRect(g, x + h * inset, y + h * inset, w - 2 * h * inset, h - 2 * h * inset, h * 0.07);
    g.clip();
  };
  switch (back) {
    case 'ivory': {
      base('#e2d7bf', '#cdbd9c', 0.06);
      border('rgba(120,98,64,0.75)', 0.022, 0.08);
      border('rgba(120,98,64,0.3)', 0.01, 0.14);
      break;
    }
    case 'red': {
      base('#741d18', '#3e0e0b');
      border(GOLD, 0.026, 0.07, 'rgba(201,154,69,0.55)');
      // sun: rays alternating long / short around a disc
      g.fillStyle = 'rgba(214,166,74,0.9)';
      star(g, cx, cy, h * 0.27, h * 0.13, 12);
      g.fill();
      g.fillStyle = '#5a1511';
      g.beginPath();
      g.arc(cx, cy, h * 0.13, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = 'rgba(214,166,74,0.95)';
      g.beginPath();
      g.arc(cx, cy, h * 0.085, 0, Math.PI * 2);
      g.fill();
      for (const s of [-1, 1]) {
        g.fillStyle = 'rgba(214,166,74,0.8)';
        star(g, cx + s * w * 0.3, cy, h * 0.075, h * 0.03, 4);
        g.fill();
      }
      break;
    }
    case 'navy': {
      base('#1f3152', '#0f192c');
      g.save();
      clipInner(0.12);
      // geometric lattice: two diagonal families + small knots at the crossings
      const sp = h * 0.19;
      g.strokeStyle = 'rgba(165,185,220,0.32)';
      g.lineWidth = h * 0.016;
      for (let d = -h; d < w + h; d += sp) {
        g.beginPath();
        g.moveTo(x + d, y);
        g.lineTo(x + d + h, y + h);
        g.moveTo(x + d + h, y);
        g.lineTo(x + d, y + h);
        g.stroke();
      }
      g.fillStyle = 'rgba(190,205,235,0.45)';
      const ks = Math.ceil((w + 2 * h) / sp);
      for (let k1 = 0; k1 <= ks; k1++)
        for (let k2 = 0; k2 <= ks; k2++) {
          // line A starts at x-h+k1*sp going down-right, line B at x+k2*sp going down-left
          const t = (h + (k2 - k1) * sp) / 2;
          if (t < 0 || t > h) continue;
          g.beginPath();
          g.arc(x - h + k1 * sp + t, y + t, h * 0.018, 0, Math.PI * 2);
          g.fill();
        }
      g.restore();
      border('rgba(185,200,228,0.75)', 0.024, 0.07);
      break;
    }
    case 'green': {
      base('#1d4a36', '#0d281c');
      g.save();
      clipInner(0.12);
      // diamond grid: alternating filled rhombi
      const dw = h * 0.22;
      const dh = h * 0.22;
      let n = 0;
      for (let j = -1; j <= Math.ceil(h / (dh / 2)) + 1; j++) {
        for (let i = -1; i <= Math.ceil(w / dw) + 1; i++) {
          const px = x + i * dw + (j & 1 ? dw / 2 : 0);
          const py = y + (j * dh) / 2;
          g.beginPath();
          g.moveTo(px, py - dh / 2);
          g.lineTo(px + dw / 2, py);
          g.lineTo(px, py + dh / 2);
          g.lineTo(px - dw / 2, py);
          g.closePath();
          g.fillStyle = (i + j + n) & 1 ? 'rgba(201,183,122,0.16)' : 'rgba(0,0,0,0.08)';
          g.fill();
          g.strokeStyle = 'rgba(201,183,122,0.3)';
          g.lineWidth = h * 0.01;
          g.stroke();
        }
        n++;
      }
      g.restore();
      border('rgba(201,170,100,0.85)', 0.024, 0.07);
      break;
    }
    case 'wood': {
      paintGrain(g, x, y, w, h, { base: ['#5a3a20', '#6e4828', '#4c2f18'], dark: '30,14,4', light: '180,120,70', lines: 26, seed: 4242, scale: h / 180 });
      border('rgba(30,14,4,0.55)', 0.03, 0.07);
      border('rgba(200,150,95,0.25)', 0.012, 0.1);
      break;
    }
    case 'ornate':
    default: {
      base('#2a2623', '#0e0d0c');
      g.strokeStyle = GOLD;
      g.lineWidth = h * 0.035;
      roundRect(g, x + w * 0.07, y + h * 0.14, w * 0.86, h * 0.72, h * 0.1);
      g.stroke();
      g.lineWidth = h * 0.012;
      roundRect(g, x + w * 0.1, y + h * 0.22, w * 0.8, h * 0.56, h * 0.07);
      g.stroke();
      g.fillStyle = '#e2b55a';
      star(g, cx, cy, h * 0.2, h * 0.08, 8);
      g.fill();
      g.fillStyle = '#151311';
      g.beginPath();
      g.arc(cx, cy, h * 0.06, 0, Math.PI * 2);
      g.fill();
      for (const s of [-1, 1]) {
        g.fillStyle = '#d6a64a';
        star(g, cx + s * w * 0.27, cy, h * 0.07, h * 0.03, 4);
        g.fill();
      }
    }
  }
  g.restore();
}

export function makeTileAtlas(cellW: number, theme: TileTheme = 'classic', back: TileBack = 'ornate'): THREE.CanvasTexture {
  const P = THEMES[theme] ?? THEMES.classic;
  const cellH = cellW / 2;
  const [c, g] = canvas(cellW * ATLAS_COLS, cellH * ATLAS_ROWS);
  g.fillStyle = P.fill;
  g.fillRect(0, 0, c.width, c.height);
  // One face per global tile id, in id order, so the shader can use gl_InstanceID directly.
  for (let id = 0; id <= MAX_TILE_ID; id++) {
    const t = TILE_BY_ID[id];
    const col = id % ATLAS_COLS;
    const row = Math.floor(id / ATLAS_COLS);
    drawFace(g, col * cellW, row * cellH, cellW, cellH, t.a, t.b, P);
  }
  drawBack(g, BACK_CELL.col * cellW, BACK_CELL.row * cellH, cellW, cellH, back);
  const sg = g.createLinearGradient(0, SIDE_CELL.row * cellH, 0, (SIDE_CELL.row + 1) * cellH);
  sg.addColorStop(0, P.side0);
  sg.addColorStop(1, P.side1);
  g.fillStyle = sg;
  g.fillRect(SIDE_CELL.col * cellW, SIDE_CELL.row * cellH, cellW, cellH);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ───────────────────────── table styles ─────────────────────────

/** Everything a table look defines: felt, frame wood, inlay/emblem tint and the matching ambient. */
export interface TableStyleDef {
  /** felt base + light pool stops (centre, mid, edge) */
  felt: [string, string, string, string];
  /** bare polished wood play area instead of felt */
  woodTop?: GrainOpts;
  /** fine linen weave over the felt */
  weave?: boolean;
  fibre: number;
  /** 'r,g,b' of the inlay lines / corner suns, and its strength (1 = the classic look) */
  inlay: string;
  inlayA: number;
  emblem: string;
  emblemA: number;
  vignette: number;
  /** frame wood */
  wood: GrainOpts;
  roughness: number;
  metalness: number;
  /** canvas CSS background (the room behind the table) */
  bg: string;
  hemiSky: number;
  hemiGround: number;
  hemi: number;
  keyColor: number;
  key: number;
  rimColor: number;
  rim: number;
  /** felt material multiplier (dims bright styles without touching the tiles) */
  feltTint: number;
}

const BG_GREEN = 'radial-gradient(120% 80% at 50% 0%, #4a2340 0%, #241330 45%, #0e0a18 100%)';

export const TABLE_STYLE_DEFS: Record<TableStyle, TableStyleDef> = {
  green: {
    felt: ['#0d4f45', '#1c7a63', '#136352', '#082f2c'],
    fibre: 0.07,
    inlay: '226,181,90',
    inlayA: 1,
    emblem: '#f3d58c',
    emblemA: 0.07,
    vignette: 0.45,
    wood: { base: ['#6b2f17', '#8a4320', '#5e2812'], dark: '40,12,4', light: '190,110,60', lines: 70, seed: 99 },
    roughness: 0.42,
    metalness: 0.05,
    bg: BG_GREEN,
    hemiSky: 0xffe6c4,
    hemiGround: 0x1d2a44,
    hemi: 1.15,
    keyColor: 0xffd29c,
    key: 2.5,
    rimColor: 0x6fd6ff,
    rim: 0.7,
    feltTint: 1,
  },
  navy: {
    felt: ['#0f2136', '#22436a', '#193454', '#0a1626'],
    fibre: 0.07,
    inlay: '214,182,116',
    inlayA: 0.9,
    emblem: '#e6d3a4',
    emblemA: 0.07,
    vignette: 0.48,
    wood: { base: ['#3a2517', '#4d3320', '#2f1d10'], dark: '18,9,3', light: '150,105,70', lines: 70, seed: 311 },
    roughness: 0.62,
    metalness: 0.04,
    bg: 'radial-gradient(120% 80% at 50% 0%, #22304c 0%, #121b2e 45%, #070a12 100%)',
    hemiSky: 0xf2e6d6,
    hemiGround: 0x1a2438,
    hemi: 1.1,
    keyColor: 0xffe0b8,
    key: 2.35,
    rimColor: 0x8fb4ff,
    rim: 0.5,
    feltTint: 1,
  },
  burgundy: {
    felt: ['#3a0e15', '#6a2331', '#531a26', '#26090e'],
    fibre: 0.07,
    inlay: '222,186,118',
    inlayA: 0.9,
    emblem: '#f0d49a',
    emblemA: 0.07,
    vignette: 0.48,
    wood: { base: ['#5a3d22', '#6a4a28', '#4c331b'], dark: '40,22,8', light: '190,150,100', lines: 64, seed: 517 },
    roughness: 0.62,
    metalness: 0.04,
    bg: 'radial-gradient(120% 80% at 50% 0%, #3d2220 0%, #22120f 45%, #0d0706 100%)',
    hemiSky: 0xffe6cc,
    hemiGround: 0x2a1a1e,
    hemi: 1.1,
    keyColor: 0xffd6a8,
    key: 2.35,
    rimColor: 0xffb08a,
    rim: 0.4,
    feltTint: 1,
  },
  charcoal: {
    felt: ['#161514', '#363230', '#282523', '#0f0e0d'],
    fibre: 0.08,
    inlay: '205,165,88',
    inlayA: 1,
    emblem: '#d9b46a',
    emblemA: 0.08,
    vignette: 0.42,
    wood: { base: ['#1d1a18', '#282421', '#151311'], dark: '0,0,0', light: '110,95,80', lines: 60, seed: 733 },
    roughness: 0.55,
    metalness: 0.06,
    bg: 'radial-gradient(120% 80% at 50% 0%, #2a282d 0%, #17161a 45%, #08080a 100%)',
    hemiSky: 0xf4e8d8,
    hemiGround: 0x1c1c22,
    hemi: 1.12,
    keyColor: 0xffdcb0,
    key: 2.45,
    rimColor: 0xb0bccc,
    rim: 0.45,
    feltTint: 1,
  },
  wood: {
    felt: ['#5a3b22', '#6c4a2c', '#5d3f24', '#3a2414'],
    woodTop: { base: ['#6a4628', '#76502e', '#62411f'], dark: '40,20,6', light: '190,140,90', lines: 0, seed: 907 },
    fibre: 0.04,
    inlay: '214,172,104',
    inlayA: 0.75,
    emblem: '#2a1608',
    emblemA: 0.16,
    vignette: 0.5,
    wood: { base: ['#35200f', '#432914', '#2b190b'], dark: '15,7,2', light: '150,100,60', lines: 70, seed: 1201 },
    roughness: 0.62,
    metalness: 0.03,
    bg: 'radial-gradient(120% 80% at 50% 0%, #3a2618 0%, #20140c 45%, #0c0805 100%)',
    hemiSky: 0xffe6c8,
    hemiGround: 0x2a1c14,
    hemi: 1.05,
    keyColor: 0xffd8a8,
    key: 2.2,
    rimColor: 0xffc890,
    rim: 0.35,
    feltTint: 0.92,
  },
  sand: {
    felt: ['#5a5143', '#968a74', '#7e7360', '#4a4235'],
    weave: true,
    fibre: 0.06,
    inlay: '110,82,46',
    inlayA: 1.1,
    emblem: '#3e3020',
    emblemA: 0.09,
    vignette: 0.5,
    wood: { base: ['#7c6a52', '#8a775c', '#6c5b45'], dark: '60,42,22', light: '200,178,140', lines: 64, seed: 1409 },
    roughness: 0.68,
    metalness: 0.02,
    bg: 'radial-gradient(120% 80% at 50% 0%, #463c32 0%, #29221c 45%, #12100c 100%)',
    hemiSky: 0xf6ead8,
    hemiGround: 0x2a241e,
    hemi: 0.98,
    keyColor: 0xffe2c0,
    key: 2.05,
    rimColor: 0xffe0b0,
    rim: 0.28,
    feltTint: 0.86,
  },
};

export function tableStyleDef(style: TableStyle | undefined): TableStyleDef {
  return TABLE_STYLE_DEFS[style ?? 'green'] ?? TABLE_STYLE_DEFS.green;
}

/** horizontal planks of polished wood (the 'wood' table's play area) */
function paintWoodTop(g: CanvasRenderingContext2D, w: number, h: number, o: GrainOpts): void {
  const planks = Math.max(4, Math.round(h / (Math.min(w, h) * 0.16)));
  const ph = h / planks;
  for (let i = 0; i < planks; i++) {
    const y = i * ph;
    // tiny per-plank tone shift so the boards read
    paintGrain(g, 0, y, w, ph + 1, { ...o, lines: Math.round(ph / 4) + 8, seed: o.seed + i * 131, scale: Math.min(w, h) / 700 });
    g.fillStyle = i % 2 ? 'rgba(255,230,190,0.025)' : 'rgba(0,0,0,0.05)';
    g.fillRect(0, y, w, ph);
    // seam
    g.fillStyle = 'rgba(20,10,3,0.45)';
    g.fillRect(0, y, w, Math.max(1, ph * 0.02));
    g.fillStyle = 'rgba(255,220,170,0.06)';
    g.fillRect(0, y + Math.max(1, ph * 0.02), w, Math.max(1, ph * 0.012));
  }
}

/** felt (or bare wood) with baked warm light pool, inlay and a faint emblem. aspect = width/height. */
export function drawFelt(target: HTMLCanvasElement | null, aspect: number, maxSide: number, centerV = 0.5, style: TableStyle = 'green'): HTMLCanvasElement {
  const S = tableStyleDef(style);
  const w = aspect >= 1 ? maxSide : Math.round(maxSide * aspect);
  const h = aspect >= 1 ? Math.round(maxSide / aspect) : maxSide;
  const c = target ?? document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = S.felt[0];
  g.fillRect(0, 0, w, h);
  if (S.woodTop) {
    paintWoodTop(g, w, h, S.woodTop);
    // soft light pool on the wood (no hot spot)
    const pool = g.createRadialGradient(w / 2, h * centerV, 0, w / 2, h * centerV, Math.max(w, h) * 0.65);
    pool.addColorStop(0, 'rgba(255,225,180,0.07)');
    pool.addColorStop(0.55, 'rgba(0,0,0,0)');
    pool.addColorStop(1, 'rgba(0,0,0,0.3)');
    g.fillStyle = pool;
    g.fillRect(0, 0, w, h);
  } else {
    const pool = g.createRadialGradient(w / 2, h * centerV, 0, w / 2, h * centerV, Math.max(w, h) * 0.65);
    pool.addColorStop(0, S.felt[1]);
    pool.addColorStop(0.5, S.felt[2]);
    pool.addColorStop(1, S.felt[3]);
    g.fillStyle = pool;
    g.fillRect(0, 0, w, h);
    if (S.weave) {
      // fine linen weave: faint alternating threads both ways
      const step = Math.max(2, Math.round(Math.min(w, h) / 260));
      g.fillStyle = 'rgba(0,0,0,0.05)';
      for (let x = 0; x < w; x += step * 2) g.fillRect(x, 0, step, h);
      g.fillStyle = 'rgba(255,240,215,0.025)';
      for (let y = 0; y < h; y += step * 2) g.fillRect(0, y, w, step);
    }
  }
  // fibre noise
  g.globalAlpha = S.fibre;
  g.globalCompositeOperation = 'overlay';
  const pat = g.createPattern(noiseTile(), 'repeat');
  if (pat) {
    g.fillStyle = pat;
    g.fillRect(0, 0, w, h);
  }
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
  const u = Math.min(w, h);
  const ia = S.inlayA;
  // inlay double line
  g.strokeStyle = `rgba(${S.inlay},${0.55 * ia})`;
  g.lineWidth = u * 0.006;
  roundRect(g, u * 0.035, u * 0.035, w - u * 0.07, h - u * 0.07, u * 0.05);
  g.stroke();
  g.strokeStyle = `rgba(${S.inlay},${0.25 * ia})`;
  g.lineWidth = u * 0.003;
  roundRect(g, u * 0.05, u * 0.05, w - u * 0.1, h - u * 0.1, u * 0.04);
  g.stroke();
  // corner suns
  g.fillStyle = `rgba(${S.inlay},${0.35 * ia})`;
  for (const [cx, cy] of [
    [u * 0.035, u * 0.035],
    [w - u * 0.035, u * 0.035],
    [u * 0.035, h - u * 0.035],
    [w - u * 0.035, h - u * 0.035],
  ]) {
    star(g, cx, cy, u * 0.025, u * 0.01, 8);
    g.fill();
  }
  // faint central compass emblem
  g.save();
  g.globalAlpha = S.emblemA;
  g.strokeStyle = S.emblem;
  g.fillStyle = S.emblem;
  g.lineWidth = u * 0.004;
  const R = u * 0.22;
  g.beginPath();
  g.arc(w / 2, h * centerV, R, 0, Math.PI * 2);
  g.stroke();
  g.beginPath();
  g.arc(w / 2, h * centerV, R * 0.86, 0, Math.PI * 2);
  g.stroke();
  star(g, w / 2, h * centerV, R * 0.8, R * 0.18, 8);
  g.fill();
  g.restore();
  // vignette
  const vg = g.createRadialGradient(w / 2, h * centerV, Math.min(w, h) * 0.35, w / 2, h * centerV, Math.max(w, h) * 0.75);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, `rgba(0,0,0,${S.vignette})`);
  g.fillStyle = vg;
  g.fillRect(0, 0, w, h);
  return c;
}

function woodCanvas(size: number, style: TableStyle): HTMLCanvasElement {
  const [c, g] = canvas(size, size);
  paintGrain(g, 0, 0, size, size, tableStyleDef(style).wood);
  return c;
}

export function makeWood(size: number, style: TableStyle = 'green'): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(woodCanvas(size, style));
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

// ───────────────────────── settings thumbnails (2D canvas only, cached) ─────────────────────────

const thumbCache = new Map<string, string>();

/** top-down swatch: wood frame + felt (or wood top) with its inlay and emblem */
export function tableThumb(style: TableStyle, w: number, h: number): string {
  w = Math.max(8, Math.round(w));
  h = Math.max(8, Math.round(h));
  const key = `t|${style}|${w}|${h}`;
  const hit = thumbCache.get(key);
  if (hit) return hit;
  const S = tableStyleDef(style);
  const [c, g] = canvas(w, h);
  const u = Math.min(w, h);
  const fr = Math.max(3, Math.round(u * 0.1));
  const r = u * 0.12;
  // frame
  g.save();
  roundRect(g, 0, 0, w, h, r);
  g.clip();
  const wc = canvas(Math.max(w, h), Math.max(w, h));
  paintGrain(wc[1], 0, 0, wc[0].width, wc[0].height, { ...S.wood, lines: Math.round(S.wood.lines * 0.5), scale: Math.max(0.35, u / 300) });
  g.drawImage(wc[0], 0, 0, w, h);
  // bevel: soft top light, bottom shade
  const bv = g.createLinearGradient(0, 0, 0, h);
  bv.addColorStop(0, 'rgba(255,235,200,0.12)');
  bv.addColorStop(0.5, 'rgba(0,0,0,0)');
  bv.addColorStop(1, 'rgba(0,0,0,0.25)');
  g.fillStyle = bv;
  g.fillRect(0, 0, w, h);
  g.restore();
  // felt
  const iw = w - fr * 2;
  const ih = h - fr * 2;
  const felt = drawFelt(null, iw / ih, Math.max(iw, ih), 0.5, style);
  g.save();
  roundRect(g, fr, fr, iw, ih, r * 0.5);
  g.clip();
  g.drawImage(felt, fr, fr, iw, ih);
  // inner rim shadow where the felt meets the frame
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.lineWidth = Math.max(1, u * 0.02);
  roundRect(g, fr, fr, iw, ih, r * 0.5);
  g.stroke();
  g.restore();
  const url = c.toDataURL('image/png');
  thumbCache.set(key, url);
  return url;
}

/** a single tile back seen from above, portrait (long side vertical) */
export function tileBackThumb(back: TileBack, w: number, h: number): string {
  w = Math.max(8, Math.round(w));
  h = Math.max(8, Math.round(h));
  const key = `b|${back}|${w}|${h}`;
  const hit = thumbCache.get(key);
  if (hit) return hit;
  const [c, g] = canvas(w, h);
  // fit a 1:2 portrait tile inside, with a little room for the shadow
  const th = Math.min(h * 0.94, w * 0.94 * 2);
  const tw = th / 2;
  const x0 = (w - tw) / 2;
  const y0 = (h - th) / 2 - th * 0.01;
  const rr = tw * 0.12;
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.45)';
  g.shadowBlur = Math.max(2, tw * 0.08);
  g.shadowOffsetY = Math.max(1, tw * 0.03);
  g.fillStyle = '#1a1714';
  roundRect(g, x0, y0, tw, th, rr);
  g.fill();
  g.restore();
  g.save();
  roundRect(g, x0, y0, tw, th, rr);
  g.clip();
  // the back is drawn landscape (2:1): rotate it into the portrait tile
  g.translate(x0 + tw / 2, y0 + th / 2);
  g.rotate(Math.PI / 2);
  drawBack(g, -th / 2, -tw / 2, th, tw, back);
  g.restore();
  // a hairline edge so light backs stay crisp on light UI
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.lineWidth = Math.max(1, tw * 0.015);
  roundRect(g, x0 + 0.5, y0 + 0.5, tw - 1, th - 1, rr);
  g.stroke();
  const url = c.toDataURL('image/png');
  thumbCache.set(key, url);
  return url;
}

/** soft rounded-rect glow (aspect 1:1 texture, stretched per instance) */
export function makeGlow(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128);
  g.shadowColor = '#fff';
  g.shadowBlur = 18;
  g.strokeStyle = 'rgba(255,255,255,0.95)';
  g.lineWidth = 6;
  roundRect(g, 22, 22, 84, 84, 14);
  g.stroke();
  g.shadowBlur = 0;
  g.fillStyle = 'rgba(255,255,255,0.22)';
  roundRect(g, 25, 25, 78, 78, 12);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Drop-slot outline shaped exactly like a tile face (TL x TW), with the tile's own small corner
 * radius. The tile rect fills GHOST_INNER of the canvas; the rest is padding for the soft glow.
 */
export const GHOST_PAD = 16;
export const GHOST_IN_W = 261; // 128 * TL / TW
export const GHOST_IN_H = 128;
export function makeGhostSlot(): THREE.CanvasTexture {
  const W = GHOST_IN_W + GHOST_PAD * 2;
  const H = GHOST_IN_H + GHOST_PAD * 2;
  const [c, g] = canvas(W, H);
  const r = 10; // 0.075 / 0.94 of the tile's short side
  g.shadowColor = '#fff';
  g.shadowBlur = 10;
  g.strokeStyle = 'rgba(255,255,255,0.95)';
  g.lineWidth = 5;
  roundRect(g, GHOST_PAD + 2.5, GHOST_PAD + 2.5, GHOST_IN_W - 5, GHOST_IN_H - 5, r);
  g.stroke();
  g.shadowBlur = 0;
  g.fillStyle = 'rgba(255,255,255,0.2)';
  roundRect(g, GHOST_PAD + 5, GHOST_PAD + 5, GHOST_IN_W - 10, GHOST_IN_H - 10, r - 2);
  g.fill();
  // centre groove hint so it reads as a tile
  g.fillStyle = 'rgba(255,255,255,0.35)';
  g.fillRect(GHOST_PAD + GHOST_IN_W / 2 - 1.5, GHOST_PAD + GHOST_IN_H * 0.18, 3, GHOST_IN_H * 0.64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function makeBlob(): THREE.CanvasTexture {
  const [c, g] = canvas(64, 64);
  g.shadowColor = 'rgba(0,0,0,1)';
  g.shadowBlur = 12;
  g.fillStyle = 'rgba(0,0,0,0.9)';
  roundRect(g, 16, 16, 32, 32, 6);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  return t;
}

export function makeRadial(inner: string, outer: string): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128);
  const rg = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  rg.addColorStop(0, inner);
  rg.addColorStop(1, outer);
  g.fillStyle = rg;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const FONT = '"Trebuchet MS", "Segoe UI", system-ui, sans-serif';
const DISPLAY = '"Arial Black", "Segoe UI Black", Impact, system-ui, sans-serif';

export interface PlateInfo {
  name: string;
  count: number;
  team: 0 | 1;
  active: boolean;
  pips: number | null;
  winner: boolean;
}

export const PLATE_W = 320;
export const PLATE_H = 96;

export function drawPlate(c: HTMLCanvasElement, p: PlateInfo): void {
  c.width = PLATE_W;
  c.height = PLATE_H;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, PLATE_W, PLATE_H);
  const x = 10;
  const y = 14;
  const w = PLATE_W - 20;
  const h = PLATE_H - 28;
  g.shadowColor = 'rgba(0,0,0,0.6)';
  g.shadowBlur = 8;
  g.shadowOffsetY = 3;
  const bg = g.createLinearGradient(0, y, 0, y + h);
  bg.addColorStop(0, p.active ? 'rgba(70,40,20,0.95)' : 'rgba(30,18,22,0.85)');
  bg.addColorStop(1, p.active ? 'rgba(40,20,12,0.95)' : 'rgba(14,8,12,0.85)');
  g.fillStyle = bg;
  roundRect(g, x, y, w, h, h / 2);
  g.fill();
  g.shadowBlur = 0;
  g.shadowOffsetY = 0;
  g.lineWidth = p.active ? 3 : 2;
  g.strokeStyle = p.winner ? '#f0cf6a' : p.active ? '#e8b450' : 'rgba(214,166,74,0.55)';
  roundRect(g, x, y, w, h, h / 2);
  g.stroke();
  // team dot
  g.fillStyle = p.team === 0 ? '#3fc7b5' : '#ef7a5a';
  g.beginPath();
  g.arc(x + h / 2, y + h / 2, h * 0.2, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#fff6e0';
  g.font = `bold ${Math.round(h * 0.42)}px ${FONT}`;
  g.textBaseline = 'middle';
  let name = p.name;
  const maxNameW = w - h * 0.9 - 92;
  while (name.length > 1 && g.measureText(name).width > maxNameW) name = name.slice(0, -1);
  if (name !== p.name) name = name.slice(0, -1) + '…';
  g.fillText(name, x + h * 0.9, y + h / 2 + 1);
  if (p.active) {
    // turn indicator: thin warm-gold underline under the name (text itself stays unglowed)
    g.fillStyle = 'rgba(232,180,80,0.9)';
    g.fillRect(x + h * 0.9, y + h * 0.8, Math.min(g.measureText(name).width, maxNameW), 2.5);
  }
  // right badge: tile count or pip total
  const bx = x + w - 84;
  g.fillStyle = p.pips !== null ? 'rgba(239,122,90,0.9)' : 'rgba(255,255,255,0.12)';
  roundRect(g, bx, y + 10, 72, h - 20, (h - 20) / 2);
  g.fill();
  g.fillStyle = '#fff6e0';
  g.font = `bold ${Math.round(h * 0.38)}px ${FONT}`;
  g.textAlign = 'center';
  if (p.pips !== null) {
    g.fillText(String(p.pips), bx + 36, y + h / 2 + 1);
  } else {
    // little tile icon + count
    g.fillStyle = '#f2e6cc';
    roundRect(g, bx + 10, y + h / 2 - 11, 12, 22, 3);
    g.fill();
    g.fillStyle = '#fff6e0';
    g.fillText(String(p.count), bx + 46, y + h / 2 + 1);
  }
  g.textAlign = 'left';
}

/** big juicy popup word */
export function drawPopup(c: HTMLCanvasElement, text: string, palette: 'gold' | 'red' | 'teal'): void {
  c.width = 640;
  c.height = 200;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, c.width, c.height);
  let size = 120;
  g.font = `900 ${size}px ${DISPLAY}`;
  while (g.measureText(text).width > 590 && size > 40) {
    size -= 6;
    g.font = `900 ${size}px ${DISPLAY}`;
  }
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const cx = 320;
  const cy = 104;
  g.lineJoin = 'round';
  g.shadowColor = 'rgba(0,0,0,0.6)';
  g.shadowBlur = 18;
  g.shadowOffsetY = 8;
  g.strokeStyle = palette === 'red' ? '#3b0707' : palette === 'teal' ? '#06302c' : '#3a1a04';
  g.lineWidth = size * 0.22;
  g.strokeText(text, cx, cy);
  g.shadowColor = 'transparent';
  const grd = g.createLinearGradient(0, cy - size / 2, 0, cy + size / 2);
  if (palette === 'red') {
    grd.addColorStop(0, '#ffd1b8');
    grd.addColorStop(0.5, '#ff6a4a');
    grd.addColorStop(1, '#c2201a');
  } else if (palette === 'teal') {
    grd.addColorStop(0, '#e8fff8');
    grd.addColorStop(0.5, '#59e0c8');
    grd.addColorStop(1, '#14907f');
  } else {
    grd.addColorStop(0, '#fffbe0');
    grd.addColorStop(0.5, '#ffd34d');
    grd.addColorStop(1, '#e8861c');
  }
  g.fillStyle = grd;
  g.fillText(text, cx, cy);
  g.lineWidth = 3;
  g.strokeStyle = 'rgba(255,255,255,0.6)';
  g.strokeText(text, cx, cy - 2);
}

export function canvasTexture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  return t;
}
