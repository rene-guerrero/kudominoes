/**
 * Pure snake layout for the domino chain ("la mesa").
 *
 * Works in an abstract cell grid where a tile is 2 cells long and 1 cell wide. The first tile
 * sits at the centre; the two arms grow outward along the longer axis of the bounds, and each arm
 * U-turns (two corner tiles) before reaching the bounds, folding back on its own half of the table
 * (right arm folds toward +lateral, left arm toward -lateral, point-symmetric so they never meet).
 * Doubles are placed crosswise on straight runs. If the result does not fit the bounds at the
 * preferred cell size, the cell size is shrunk until it does (auto-fit).
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
}

export interface ChainLayoutOptions {
  maxCell?: number;
  minCell?: number;
  /** force a cell size (no fitting); used for ghost previews */
  cell?: number;
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

function placeOnArm(arm: Arm, a: number, b: number, outer: number, HW: number, HH: number): P2 {
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
  if (along + 1 <= limit + EPS) {
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

function rawLayout(chain: PlacedTile[], HW: number, HH: number): P2[] {
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
    out.push(placeOnArm(arm, p.tile.a, p.tile.b, p.outer, HW, HH));
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

function valid(ps: P2[], HW: number, HH: number): boolean {
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (p.x - p.hx < -HW - EPS || p.x + p.hx > HW + EPS) return false;
    if (p.y - p.hy < -HH - EPS || p.y + p.hy > HH + EPS) return false;
    for (let j = 0; j < i; j++) {
      const q = ps[j];
      if (Math.abs(p.x - q.x) < p.hx + q.hx - EPS && Math.abs(p.y - q.y) < p.hy + q.hy - EPS) return false;
    }
  }
  return true;
}

export function layoutChain(
  chain: PlacedTile[],
  bounds: ChainBounds,
  opts: ChainLayoutOptions = {},
): ChainLayoutResult {
  const vertical = bounds.h > bounds.w;
  // primary-frame half extents in world units
  const PW = (vertical ? bounds.h : bounds.w) / 2;
  const PH = (vertical ? bounds.w : bounds.h) / 2;
  const maxCell = opts.maxCell ?? 1;
  const minCell = opts.minCell ?? 0.2;

  let cell = opts.cell ?? maxCell;
  let ps = rawLayout(chain, PW / cell, PH / cell);
  shiftToFit(ps, PW / cell, PH / cell);
  let fits = valid(ps, PW / cell, PH / cell);
  if (opts.cell === undefined) {
    while (!fits && cell > minCell) {
      cell = Math.max(minCell, cell * 0.94);
      ps = rawLayout(chain, PW / cell, PH / cell);
      shiftToFit(ps, PW / cell, PH / cell);
      fits = valid(ps, PW / cell, PH / cell);
    }
  }

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
  return { poses, cell, fits, vertical };
}
