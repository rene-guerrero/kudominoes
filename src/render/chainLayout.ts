/**
 * Pure snake layout for the domino chain ("la mesa").
 *
 * Works in an abstract cell grid where a tile is 2 cells long and 1 cell wide. The first tile
 * sits at the centre; the two arms grow outward along the longer axis of the bounds, and each arm
 * U-turns (two corner tiles) before reaching the bounds, folding back on its own half of the table
 * (right arm folds toward +lateral, left arm toward -lateral, point-symmetric so they never meet).
 * Doubles are placed crosswise on straight runs. If the result does not fit the bounds at the
 * preferred cell size, the cell size is shrunk until it does (auto-fit), in fine steps so it shrinks
 * as little as possible.
 *
 * Optional keep-out rects (`avoid`: plates, stacks, speech-bubble zones that poke into the bounds) are
 * honoured too: before shrinking, the whole snake may slide a cell or two away from them. A soft
 * readability floor (`softMinCell`) is only crossed when nothing fits above it: first the other
 * orientation is tried at sizes >= the floor, and only then does the cell keep shrinking.
 *
 * Output is in world XZ (y up). `rotY` follows three.js: rotation about +Y; a tile's local +X axis
 * points at its `b` pip half (the renderer maps pip `a` to local -X and `b` to local +X).
 */
import type { PlacedTile } from '../contracts';

export interface ChainBounds {
  /** centre of the chain area in world X / Z */
  cx: number;
  cz: number;
  /** full extents of the chain area along world X (w) and Z (h) */
  w: number;
  h: number;
}

export interface TilePose {
  x: number;
  z: number;
  rotY: number;
  /** true when the tile's long axis runs across the chain direction (crosswise double) */
  crosswise: boolean;
}

export interface ChainLayoutResult {
  poses: TilePose[];
  /** world size of one cell (tile width). Tile length = 2 * cell. */
  cell: number;
  fits: boolean;
  /** true when the primary axis is world Z (portrait-ish bounds) */
  vertical: boolean;
  /** slide applied to dodge `avoid` rects (cell units, primary frame) */
  shift: { x: number; y: number };
}

/** world-XZ keep-out rect */
export interface AvoidRect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export interface ChainLayoutOptions {
  maxCell?: number;
  /** hard floor of the auto-fit */
  minCell?: number;
  /** readability floor: crossed only when nothing (either orientation) fits at or above it */
  softMinCell?: number;
  /** force a cell size (no fitting); used for ghost previews */
  cell?: number;
  /** keep-out rects inside the bounds (world XZ) */
  avoid?: readonly AvoidRect[];
  /** force the primary axis (default: the longer side of the bounds) */
  vertical?: boolean;
  /** with `cell`: reuse this slide (cell units, primary frame) so previews match the live layout */
  shift?: { x: number; y: number };
}

const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];
const ANG = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
const EPS = 1e-6;

interface Arm {
  px: number;
  py: number;
  dir: number; // 0 E, 1 N, 2 W, 3 S
  lat: number; // lateral fold direction
  turned: boolean; // just placed the first corner tile; next one completes the U-turn
  nextDir: number;
}

interface P2 {
  x: number;
  y: number;
  ang: number;
  cw: boolean;
  hx: number; // half extents (cells)
  hy: number;
}

function mk(x: number, y: number, ang: number, cw: boolean, alongX: boolean): P2 {
  return { x, y, ang, cw, hx: alongX ? 1 : 0.5, hy: alongX ? 0.5 : 1 };
}

/** angle so that the `outer` pip half points along direction index d */
function orientAlong(d: number, tileB: number, outer: number): number {
  return ANG[d] + (outer === tileB ? 0 : Math.PI);
}

/** keep-out rect in the primary cell frame */
interface Obs {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

function hits(obs: readonly Obs[], x0: number, x1: number, y0: number, y1: number): boolean {
  for (const o of obs) if (x1 > o.x0 + EPS && x0 < o.x1 - EPS && y1 > o.y0 + EPS && y0 < o.y1 - EPS) return true;
  return false;
}

/** does the rect spanning [a0, a1] along direction d and [l0, l1] toward direction lat, from (ox, oy), hit one? */
function spanHits(obs: readonly Obs[], d: number, a0: number, a1: number, lat: number, l0: number, l1: number, ox: number, oy: number): boolean {
  const xa = ox + DX[d] * a0 + DX[lat] * l0;
  const ya = oy + DY[d] * a0 + DY[lat] * l0;
  const xb = ox + DX[d] * a1 + DX[lat] * l1;
  const yb = oy + DY[d] * a1 + DY[lat] * l1;
  return hits(obs, Math.min(xa, xb), Math.max(xa, xb), Math.min(ya, yb), Math.max(ya, yb));
}

function placeOnArm(arm: Arm, a: number, b: number, outer: number, HW: number, HH: number, obs?: readonly Obs[]): P2 {
  const dbl = a === b;
  const d = arm.dir;
  if (arm.turned) {
    arm.turned = false;
    return turn(arm, arm.nextDir, b, outer);
  }
  // straight candidate
  const adv = dbl ? 1 : 2;
  const npx = arm.px + DX[d] * adv;
  const npy = arm.py + DY[d] * adv;
  const along = DX[d] !== 0 ? npx * DX[d] : npy * DY[d];
  const limit = DX[d] !== 0 ? HW : HH;
  // turn early in front of a keep-out rect: the straight tile and the room a corner would need after it
  // (one cell further on, reaching two cells out to the fold side) must be clear
  const cw = dbl ? 1 : 0.5;
  const blocked =
    !!obs &&
    (spanHits(obs, d, 0, adv, arm.lat, -cw, cw, arm.px, arm.py) || spanHits(obs, d, adv, adv + 1, arm.lat, -0.5, 1.5, arm.px, arm.py));
  if (along + 1 <= limit + EPS && !blocked) {
    const cx = arm.px + DX[d] * adv * 0.5;
    const cy = arm.py + DY[d] * adv * 0.5;
    arm.px = npx;
    arm.py = npy;
    const horizontal = DX[d] !== 0;
    if (dbl) return mk(cx, cy, ANG[d] + Math.PI / 2, true, !horizontal);
    return mk(cx, cy, orientAlong(d, b, outer), false, horizontal);
  }
  // first corner of a U-turn
  arm.turned = true;
  arm.nextDir = (d + 2) % 4;
  return turn(arm, arm.lat, b, outer);
}

/** corner tile: perpendicular to the current direction, its inner half touching the open end */
function turn(arm: Arm, nd: number, b: number, outer: number): P2 {
  const d = arm.dir;
  const cx = arm.px + DX[d] * 0.5 + DX[nd] * 0.5;
  const cy = arm.py + DY[d] * 0.5 + DY[nd] * 0.5;
  arm.px = arm.px + DX[d] * 0.5 + DX[nd] * 1.5;
  arm.py = arm.py + DY[d] * 0.5 + DY[nd] * 1.5;
  arm.dir = nd;
  return mk(cx, cy, orientAlong(nd, b, outer), false, DX[nd] !== 0);
}

function rawLayout(chain: PlacedTile[], HW: number, HH: number, obs?: readonly Obs[]): P2[] {
  const out: P2[] = [];
  if (chain.length === 0) return out;
  const first = chain[0];
  const fa = first.tile.a;
  const fb = first.tile.b;
  const right: Arm = { px: 1, py: 0, dir: 0, lat: 1, turned: false, nextDir: 0 };
  const left: Arm = { px: -1, py: 0, dir: 2, lat: 3, turned: false, nextDir: 0 };
  if (fa === fb) {
    out.push(mk(0, 0, Math.PI / 2, true, false));
    right.px = 0.5;
    left.px = -0.5;
  } else {
    // pip a on the west (left end), b on the east (right end)
    out.push(mk(0, 0, first.outer === fb ? 0 : Math.PI, false, true));
  }
  for (let i = 1; i < chain.length; i++) {
    const p = chain[i];
    const arm = p.side === 'left' ? left : right;
    out.push(placeOnArm(arm, p.tile.a, p.tile.b, p.outer, HW, HH, obs));
  }
  return out;
}

/**
 * Minimal re-centre: if the snake overflows on one side but its extent fits, slide the whole chain
 * just enough to fit (no motion at all while it already fits).
 */
function shiftToFit(ps: P2[], HW: number, HH: number): void {
  if (!ps.length) return;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of ps) {
    x0 = Math.min(x0, p.x - p.hx);
    x1 = Math.max(x1, p.x + p.hx);
    y0 = Math.min(y0, p.y - p.hy);
    y1 = Math.max(y1, p.y + p.hy);
  }
  let sx = 0;
  let sy = 0;
  if (x1 - x0 <= 2 * HW + EPS) {
    if (x0 < -HW) sx = -HW - x0;
    else if (x1 > HW) sx = HW - x1;
  }
  if (y1 - y0 <= 2 * HH + EPS) {
    if (y0 < -HH) sy = -HH - y0;
    else if (y1 > HH) sy = HH - y1;
  }
  if (sx === 0 && sy === 0) return;
  for (const p of ps) {
    p.x += sx;
    p.y += sy;
  }
}

interface Frame {
  vertical: boolean;
  cx: number;
  cz: number;
  cell: number;
}

function valid(ps: P2[], HW: number, HH: number, avoid: readonly AvoidRect[] | undefined, f: Frame): boolean {
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (p.x - p.hx < -HW - EPS || p.x + p.hx > HW + EPS) return false;
    if (p.y - p.hy < -HH - EPS || p.y + p.hy > HH + EPS) return false;
    for (let j = 0; j < i; j++) {
      const q = ps[j];
      if (Math.abs(p.x - q.x) < p.hx + q.hx - EPS && Math.abs(p.y - q.y) < p.hy + q.hy - EPS) return false;
    }
    if (avoid && avoid.length) {
      // the tile's AABB in world XZ (same frame mapping as the output poses)
      const c = f.cell;
      const wx = f.vertical ? f.cx - p.y * c : f.cx + p.x * c;
      const wz = f.vertical ? f.cz - p.x * c : f.cz - p.y * c;
      const hx = (f.vertical ? p.hy : p.hx) * c;
      const hz = (f.vertical ? p.hx : p.hy) * c;
      for (const r of avoid) {
        if (wx + hx > r.x0 + EPS && wx - hx < r.x1 - EPS && wz + hz > r.z0 + EPS && wz - hz < r.z1 - EPS) return false;
      }
    }
  }
  return true;
}

/** slides tried in order (cell units, primary frame) before shrinking when keep-out rects are in play */
const SHIFTS: [number, number][] = [
  [0, 0],
  [0, 1],
  [0, -1],
  [1, 0],
  [-1, 0],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
  [0, 2],
  [0, -2],
  [2, 0],
  [-2, 0],
];

interface Trial {
  ps: P2[];
  shift: { x: number; y: number };
}

/** layout at one cell size; with keep-out rects, the first slide that clears them */
function tryCell(
  chain: PlacedTile[],
  PW: number,
  PH: number,
  cell: number,
  vertical: boolean,
  bounds: ChainBounds,
  avoid: readonly AvoidRect[] | undefined,
  fixedShift?: { x: number; y: number },
): { trial: Trial; fits: boolean } {
  const HW = PW / cell;
  const HH = PH / cell;
  const f: Frame = { vertical, cx: bounds.cx, cz: bounds.cz, cell };
  // keep-out rects in the primary cell frame (inverse of the output mapping)
  let obs: Obs[] | undefined;
  if (avoid && avoid.length) {
    obs = avoid.map((r) => ({
      x0: vertical ? (bounds.cz - r.z1) / cell : (r.x0 - bounds.cx) / cell,
      x1: vertical ? (bounds.cz - r.z0) / cell : (r.x1 - bounds.cx) / cell,
      y0: vertical ? (bounds.cx - r.x1) / cell : (bounds.cz - r.z1) / cell,
      y1: vertical ? (bounds.cx - r.x0) / cell : (bounds.cz - r.z0) / cell,
    }));
  }
  const base = rawLayout(chain, HW, HH, obs);
  shiftToFit(base, HW, HH);
  const shifts: [number, number][] = fixedShift ? [[fixedShift.x, fixedShift.y]] : avoid && avoid.length ? SHIFTS : [[0, 0]];
  let first: Trial | null = null;
  for (const [sx, sy] of shifts) {
    const ps = sx === 0 && sy === 0 ? base : base.map((p) => ({ ...p, x: p.x + sx, y: p.y + sy }));
    const trial = { ps, shift: { x: sx, y: sy } };
    first ??= trial;
    if (valid(ps, HW, HH, avoid, f)) return { trial, fits: true };
  }
  return { trial: first!, fits: false };
}

export function layoutChain(
  chain: PlacedTile[],
  bounds: ChainBounds,
  opts: ChainLayoutOptions = {},
): ChainLayoutResult {
  const prefVertical = opts.vertical ?? bounds.h > bounds.w;
  const maxCell = opts.maxCell ?? 1;
  const minCell = Math.min(maxCell, opts.minCell ?? 0.2);
  const softMin = Math.min(maxCell, Math.max(minCell, opts.softMinCell ?? minCell));
  const avoid = opts.avoid;
  const half = (v: boolean) => ({ PW: (v ? bounds.h : bounds.w) / 2, PH: (v ? bounds.w : bounds.h) / 2 });

  /** the largest cell in [lo, hi] (scanning down in fine steps) that fits; null when none does */
  const scan = (v: boolean, hi: number, lo: number) => {
    const { PW, PH } = half(v);
    let cell = hi;
    for (;;) {
      const r = tryCell(chain, PW, PH, cell, v, bounds, avoid);
      if (r.fits) return { trial: r.trial, cell };
      if (cell <= lo + 1e-9) return null;
      cell = Math.max(lo, cell * 0.97);
    }
  };

  let vertical = prefVertical;
  let cell: number;
  let trial: Trial;
  let fits: boolean;
  if (opts.cell !== undefined) {
    cell = opts.cell;
    const { PW, PH } = half(vertical);
    const r = tryCell(chain, PW, PH, cell, vertical, bounds, avoid, opts.shift);
    trial = r.trial;
    fits = r.fits;
  } else {
    let best = scan(prefVertical, maxCell, softMin);
    if (!best && softMin > minCell) {
      // readability first: the other orientation, still at or above the soft floor
      const alt = scan(!prefVertical, maxCell, softMin);
      if (alt) {
        best = alt;
        vertical = !prefVertical;
      } else best = scan(prefVertical, softMin, minCell);
    }
    if (best) {
      cell = best.cell;
      trial = best.trial;
      fits = true;
    } else {
      cell = minCell;
      const { PW, PH } = half(vertical);
      trial = tryCell(chain, PW, PH, cell, vertical, bounds, avoid).trial;
      fits = false;
    }
  }

  const ps = trial.ps;
  const poses: TilePose[] = new Array(ps.length);
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    let x = p.x;
    let y = p.y;
    let ang = p.ang;
    if (vertical) {
      // rotate the primary frame +90deg: east arm grows toward the partner (north)
      const t = x;
      x = -y;
      y = t;
      ang += Math.PI / 2;
    }
    // 2D frame: y = north = world -Z
    poses[i] = { x: bounds.cx + x * cell, z: bounds.cz - y * cell, rotY: ang, crosswise: p.cw };
  }
  return { poses, cell, fits, vertical, shift: trial.shift };
}
