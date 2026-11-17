/**
 * Pure geometry for the main-menu falling dominoes (no three.js, no DOM): domino-chain paths, the 2D
 * footprint checks that keep standing / fallen tiles apart and oriented-box (OBB) intersection.
 *
 * Units: tile scale 1 (a tile is TL long, TW wide, TH thick — must match tableView.ts). 2D paths use
 * y up (screen up = world -Z); the scenes convert with z = -y.
 */

export const TL = 1.92;
export const TW = 0.94;
export const TH = 0.3;

/** domino spacing (centre to centre, chord) along a path */
export const DOM_D = 1.25;
/** largest heading change between neighbouring dominoes (radians) */
export const MAX_TURN = 0.55;
/** smallest arc radius a path may use so neighbours stay within MAX_TURN */
export const RMIN = DOM_D / (2 * Math.sin(MAX_TURN / 2));

export type Rnd = () => number;

// ───────────────────────── paths ─────────────────────────

export type PathShape = 'arc' | 'scurve' | 'zigzag' | 'spiral' | 'heart' | 'ku';
export const ALL_SHAPES: PathShape[] = ['arc', 'scurve', 'zigzag', 'spiral', 'heart', 'ku'];
/** "simpler paths" for the low quality level */
export const LOW_SHAPES: PathShape[] = ['arc', 'scurve', 'zigzag'];

/** one turtle step: travel `len` along an arc that turns by `turn` radians (+ = left / CCW; 0 = straight) */
export type Cmd = [len: number, turn: number];

export interface DomLine {
  x: number[];
  y: number[];
  /** heading (radians, 2D, y up): the direction the tile faces and falls */
  h: number[];
}

export interface DomLayout {
  shape: PathShape;
  lines: DomLine[];
  /** when tile `from` of line `fl` reaches its neighbour, tile `to` of line `tl` is knocked (both ways) */
  triggers: { fl: number; from: number; tl: number; to: number }[];
}

interface Poly {
  x: number[];
  y: number[];
  h: number[];
}

/** dense polyline of a turtle program (step ~0.04) */
export function turtle(x0: number, y0: number, h0: number, cmds: Cmd[], out?: Poly): Poly {
  // with `out`: append to it, continuing from its last point (x0 / y0 / h0 ignored)
  const p: Poly = out ?? { x: [x0], y: [y0], h: [h0] };
  let x = p.x[p.x.length - 1];
  let y = p.y[p.y.length - 1];
  let h = p.h[p.h.length - 1];
  for (const [len, turn] of cmds) {
    if (len <= 1e-9) continue;
    const n = Math.max(1, Math.ceil(len / 0.04));
    const dl = len / n;
    const dh = turn / n;
    for (let i = 0; i < n; i++) {
      const hm = h + dh / 2;
      x += Math.cos(hm) * dl;
      y += Math.sin(hm) * dl;
      h += dh;
      p.x.push(x);
      p.y.push(y);
      p.h.push(h);
    }
  }
  return p;
}

/** points along a dense polyline, each exactly `d` (chord) from the previous one */
export function resample(p: Poly, d: number): DomLine {
  const out: DomLine = { x: [p.x[0]], y: [p.y[0]], h: [p.h[0]] };
  let lx = p.x[0];
  let ly = p.y[0];
  for (let i = 1; i < p.x.length; i++) {
    const bx = p.x[i];
    const by = p.y[i];
    if (Math.hypot(bx - lx, by - ly) < d) continue;
    // solve |a + t(b-a) - last| = d on the segment (a = previous dense point)
    const ax = p.x[i - 1];
    const ay = p.y[i - 1];
    const ex = bx - ax;
    const ey = by - ay;
    const fx = ax - lx;
    const fy = ay - ly;
    const A = ex * ex + ey * ey;
    const B = 2 * (fx * ex + fy * ey);
    const C = fx * fx + fy * fy - d * d;
    const disc = Math.max(0, B * B - 4 * A * C);
    const t = A > 0 ? Math.min(1, Math.max(0, (-B + Math.sqrt(disc)) / (2 * A))) : 1;
    lx = ax + ex * t;
    ly = ay + ey * t;
    out.x.push(lx);
    out.y.push(ly);
    out.h.push(p.h[i - 1] + (p.h[i] - p.h[i - 1]) * t);
    i--; // the same segment may hold another point
  }
  return out;
}

const R0 = RMIN * 1.06;

function shapeCmds(shape: PathShape, L: number, rnd: Rnd): { h0: number; cmds: Cmd[] } | null {
  switch (shape) {
    case 'arc': {
      let A = 2.2 + rnd() * 1.4;
      if (L / A < R0) A = L / R0;
      return { h0: -A / 2, cmds: [[L, A]] };
    }
    case 'scurve': {
      let A = 1.3 + rnd() * 1.0;
      const m = rnd() < 0.5 ? 0 : L * 0.15;
      const a = (L - m) / 2;
      if (a / A < R0) A = a / R0;
      return { h0: 0, cmds: [[a, A], [m, 0], [a, -A]] };
    }
    case 'zigzag': {
      for (let m = L > 24 ? 4 : 3; m >= 2; m--) {
        const c = 1.2 + rnd() * 0.6;
        const cl = c * R0;
        const s = (L - (m - 1) * cl) / m;
        if (s < 1.6) continue;
        const cmds: Cmd[] = [];
        for (let i = 0; i < m; i++) {
          cmds.push([s, 0]);
          if (i < m - 1) cmds.push([cl, i % 2 ? c : -c]);
        }
        return { h0: c / 2, cmds };
      }
      return null;
    }
    case 'spiral': {
      // inward Archimedean spiral ending at radius R0, arms 1.75 apart
      const p = 1.75;
      const a = p / (4 * Math.PI);
      const th = (-R0 + Math.sqrt(R0 * R0 + 4 * a * L)) / (2 * a);
      const cmds: Cmd[] = [];
      const step = 0.12;
      for (let t = 0; t < th - 1e-9; t += step) {
        const dt = Math.min(step, th - t);
        const r = R0 + (p * (th - (t + dt / 2))) / (2 * Math.PI);
        cmds.push([r * dt, dt]);
      }
      return { h0: 0, cmds };
    }
    case 'heart': {
      // tip -> left lobe -> dip -> right lobe -> back toward the tip (the tail is trimmed later)
      const lam = Math.max(1, (L + 3.2) / (R0 * (6 + 2 * Math.PI + Math.PI / 2)));
      const r = lam * R0;
      const L1 = 3 * r;
      return {
        h0: (3 * Math.PI) / 4,
        cmds: [
          [L1, 0],
          [Math.PI * r, -Math.PI],
          [(Math.PI / 2) * r, Math.PI / 2],
          [Math.PI * r, -Math.PI],
          [L1, 0],
        ],
      };
    }
    default:
      return null;
  }
}

/** the letters KU: line 0 = K stem (top to bottom), line 1 = K arms + a hook over to the U */
function kuLines(Hk: number): { lines: DomLine[]; apex: [number, number] } {
  const beta = 0.85;
  const gx = 1.85;
  const ax = gx;
  const ay = Hk / 2;
  const fil = (Math.PI / 2 - beta) * R0; // half fillet length
  // forward from the apex: half fillet (right turn), upper arm, hook (right turn) down into the U
  const fwd = turtle(ax, ay, Math.PI / 2, [[fil, -(Math.PI / 2 - beta)]]);
  const fy = fwd.y[fwd.y.length - 1];
  const armLen = Math.max(0.6, (Hk * 0.96 - fy) / Math.sin(beta));
  turtle(0, 0, 0, [[armLen, 0], [(beta + Math.PI / 2) * R0, -(beta + Math.PI / 2)]], fwd);
  const ey = fwd.y[fwd.y.length - 1];
  const u = Math.max(0.4, ey - R0);
  turtle(0, 0, 0, [[u, 0], [Math.PI * R0, Math.PI], [u, 0]], fwd);
  // backward from the apex: the lower arm, mirrored, then reversed into path order
  const back = turtle(ax, ay, -Math.PI / 2, [[fil, Math.PI / 2 - beta], [armLen, 0]]);
  const full: Poly = { x: [], y: [], h: [] };
  for (let i = back.x.length - 1; i >= 1; i--) {
    full.x.push(back.x[i]);
    full.y.push(back.y[i]);
    full.h.push(back.h[i] + Math.PI);
  }
  full.x.push(...fwd.x);
  full.y.push(...fwd.y);
  full.h.push(...fwd.h);
  const stem = resample(turtle(0, Hk, -Math.PI / 2, [[Hk, 0]]), DOM_D);
  return { lines: [stem, resample(full, DOM_D)], apex: [ax, ay] };
}

/**
 * A random domino path of about `n` tiles (never more than `maxN`); null when this shape cannot be
 * built within the limits (the caller tries another shape).
 */
export function buildDominoLayout(shape: PathShape, n: number, maxN: number, rnd: Rnd): DomLayout | null {
  let lay: DomLayout;
  if (shape === 'ku') {
    let built: DomLayout | null = null;
    for (let Hk = 5.2 + rnd() * 1.2; Hk >= 4.4; Hk -= 0.4) {
      const { lines, apex } = kuLines(Hk);
      const l = trimLines(lines);
      if (count(l) > maxN || l[1].x.length < 8) continue;
      const from = nearest(l[0], apex[0], apex[1]);
      const to = nearest(l[1], apex[0], apex[1]);
      built = { shape, lines: l, triggers: [{ fl: 0, from, tl: 1, to }] };
      break;
    }
    if (!built) return null;
    lay = built;
  } else {
    const L = (Math.max(2, n) - 1) * DOM_D;
    const sc = shapeCmds(shape, L, rnd);
    if (!sc) return null;
    const line = resample(turtle(0, 0, sc.h0, sc.cmds), DOM_D);
    const l = trimLines([line]);
    // a heart has a minimum size: too many tiles for this level means no heart (never a cut-off one)
    if (l[0].x.length > maxN) {
      if (shape === 'heart') return null;
      l[0] = cut(l[0], maxN);
    }
    if (l[0].x.length < 6) return null;
    lay = { shape, lines: l, triggers: [] };
  }
  // random orientation: free for the abstract shapes, letters and the heart stay upright-ish
  const upright = shape === 'ku' || shape === 'heart';
  const rot = upright ? (rnd() - 0.5) * 0.2 : rnd() * Math.PI * 2;
  const mirror = !upright && rnd() < 0.5;
  transform(lay, rot, mirror);
  return checkLayout(lay).ok ? lay : null;
}

function count(lines: DomLine[]): number {
  let n = 0;
  for (const l of lines) n += l.x.length;
  return n;
}

function cut(l: DomLine, n: number): DomLine {
  return { x: l.x.slice(0, n), y: l.y.slice(0, n), h: l.h.slice(0, n) };
}

function nearest(l: DomLine, x: number, y: number): number {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < l.x.length; i++) {
    const d = Math.hypot(l.x[i] - x, l.y[i] - y);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

/** rotate (and maybe mirror) about the bounding-box centre, which ends up at the origin */
function transform(lay: DomLayout, rot: number, mirror: boolean): void {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  for (const l of lay.lines)
    for (let i = 0; i < l.x.length; i++) {
      let x = l.x[i];
      let h = l.h[i];
      if (mirror) {
        x = -x;
        h = Math.PI - h;
      }
      const y = l.y[i];
      l.x[i] = x * c - y * s;
      l.y[i] = x * s + y * c;
      l.h[i] = h + rot;
      x0 = Math.min(x0, l.x[i]);
      x1 = Math.max(x1, l.x[i]);
      y0 = Math.min(y0, l.y[i]);
      y1 = Math.max(y1, l.y[i]);
    }
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  for (const l of lay.lines)
    for (let i = 0; i < l.x.length; i++) {
      l.x[i] -= cx;
      l.y[i] -= cy;
    }
}

// ───────────────────────── 2D footprints ─────────────────────────

/** 2D oriented rect: centre, unit axis (u), half extents along u and its normal */
export interface Rect2 {
  cx: number;
  cy: number;
  ux: number;
  uy: number;
  hu: number;
  hv: number;
}

/** footprint of a standing domino (thin along its heading) */
export function standingRect(x: number, y: number, h: number): Rect2 {
  return { cx: x, cy: y, ux: Math.cos(h), uy: Math.sin(h), hu: TH / 2, hv: TW / 2 };
}

/** footprint of a domino fallen flat forward (rotated about its front bottom edge) */
export function fallenRect(x: number, y: number, h: number): Rect2 {
  const ux = Math.cos(h);
  const uy = Math.sin(h);
  const f = TH / 2 + TL / 2;
  return { cx: x + ux * f, cy: y + uy * f, ux, uy, hu: TL / 2, hv: TW / 2 };
}

/** separating-axis gap between two rects (> 0: apart by at least that much; < 0: overlapping) */
export function rectGap(a: Rect2, b: Rect2): number {
  let best = -Infinity;
  const axes = [a.ux, a.uy, -a.uy, a.ux, b.ux, b.uy, -b.uy, b.ux];
  for (let k = 0; k < 8; k += 2) {
    const nx = axes[k];
    const ny = axes[k + 1];
    const ra = Math.abs(a.hu * (a.ux * nx + a.uy * ny)) + Math.abs(a.hv * (-a.uy * nx + a.ux * ny));
    const rb = Math.abs(b.hu * (b.ux * nx + b.uy * ny)) + Math.abs(b.hv * (-b.uy * nx + b.ux * ny));
    const d = Math.abs((b.cx - a.cx) * nx + (b.cy - a.cy) * ny);
    best = Math.max(best, d - ra - rb);
  }
  return best;
}

interface Slot {
  l: number;
  i: number;
  x: number;
  y: number;
  h: number;
}

function slots(lines: DomLine[]): Slot[] {
  const out: Slot[] = [];
  lines.forEach((ln, l) => ln.x.forEach((x, i) => out.push({ l, i, x, y: ln.y[i], h: ln.h[i] })));
  return out;
}

const neighbours = (a: Slot, b: Slot) => a.l === b.l && Math.abs(a.i - b.i) <= 1;

/** the pair conflicts: standing tiles too close, or a fallen tile landing on a tile it is not chained to */
function conflict(a: Slot, b: Slot): boolean {
  if (rectGap(standingRect(a.x, a.y, a.h), standingRect(b.x, b.y, b.h)) < 0.05) return true;
  if (neighbours(a, b)) return false;
  return (
    rectGap(fallenRect(a.x, a.y, a.h), standingRect(b.x, b.y, b.h)) < 0.03 ||
    rectGap(standingRect(a.x, a.y, a.h), fallenRect(b.x, b.y, b.h)) < 0.03 ||
    rectGap(fallenRect(a.x, a.y, a.h), fallenRect(b.x, b.y, b.h)) < 0.03
  );
}

/** cut each line at its first tile that conflicts with any earlier tile (e.g. a heart closing on itself) */
function trimLines(lines: DomLine[]): DomLine[] {
  const kept: Slot[] = [];
  const out: DomLine[] = [];
  lines.forEach((ln, l) => {
    let n = 0;
    for (let i = 0; i < ln.x.length; i++) {
      const s: Slot = { l, i, x: ln.x[i], y: ln.y[i], h: ln.h[i] };
      if (kept.some((k) => conflict(k, s))) break;
      kept.push(s);
      n++;
    }
    out.push(cut(ln, n));
  });
  return out;
}

export interface LayoutCheck {
  ok: boolean;
  /** smallest gap between standing footprints */
  minStanding: number;
  /** worst forward reach ratio (gap between faces / tile length; must stay < 1 to hit the neighbour) */
  maxReach: number;
  /** worst sideways offset of a neighbour off the falling tile's axis, as a share of half the width */
  maxSide: number;
  maxTurn: number;
  conflicts: number;
}

export function checkLayout(lay: DomLayout): LayoutCheck {
  const all = slots(lay.lines);
  let minStanding = Infinity;
  let conflicts = 0;
  for (let a = 0; a < all.length; a++)
    for (let b = a + 1; b < all.length; b++) {
      const A = all[a];
      const B = all[b];
      minStanding = Math.min(minStanding, rectGap(standingRect(A.x, A.y, A.h), standingRect(B.x, B.y, B.h)));
      if (conflict(A, B)) conflicts++;
    }
  let maxReach = 0;
  let maxSide = 0;
  let maxTurn = 0;
  for (const ln of lay.lines)
    for (let i = 0; i + 1 < ln.x.length; i++) {
      const ux = Math.cos(ln.h[i]);
      const uy = Math.sin(ln.h[i]);
      const dx = ln.x[i + 1] - ln.x[i];
      const dy = ln.y[i + 1] - ln.y[i];
      const f = dx * ux + dy * uy;
      const s = -dx * uy + dy * ux;
      maxReach = Math.max(maxReach, (f - TH) / TL);
      maxSide = Math.max(maxSide, Math.abs(s) / (TW / 2));
      let dh = ln.h[i + 1] - ln.h[i];
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      maxTurn = Math.max(maxTurn, Math.abs(dh));
    }
  const ok = conflicts === 0 && minStanding >= 0.05 && maxReach < 0.85 && maxSide < 0.8 && maxTurn <= MAX_TURN + 0.02;
  return { ok, minStanding, maxReach, maxSide, maxTurn, conflicts };
}

// ───────────────────────── 3D oriented boxes ─────────────────────────

/** OBB as 15 numbers: centre (3), three unit axes (3 x 3), half extents (3) */
export type Obb = Float64Array;
export const newObb = (): Obb => new Float64Array(15);

/** box of a tile at pos / quaternion / uniform scale (local X = length, Y = thickness, Z = width) */
export function tileObb(o: Obb, px: number, py: number, pz: number, qx: number, qy: number, qz: number, qw: number, s: number): Obb {
  o[0] = px;
  o[1] = py;
  o[2] = pz;
  const x2 = qx + qx;
  const y2 = qy + qy;
  const z2 = qz + qz;
  const xx = qx * x2;
  const xy = qx * y2;
  const xz = qx * z2;
  const yy = qy * y2;
  const yz = qy * z2;
  const zz = qz * z2;
  const wx = qw * x2;
  const wy = qw * y2;
  const wz = qw * z2;
  // rotation matrix columns
  o[3] = 1 - (yy + zz);
  o[4] = xy + wz;
  o[5] = xz - wy;
  o[6] = xy - wz;
  o[7] = 1 - (xx + zz);
  o[8] = yz + wx;
  o[9] = xz + wy;
  o[10] = yz - wx;
  o[11] = 1 - (xx + yy);
  o[12] = (TL / 2) * s;
  o[13] = (TH / 2) * s;
  o[14] = (TW / 2) * s;
  return o;
}

const AX = new Float64Array(3);

/**
 * Separating-axis test for two OBBs: returns the largest separation found over the 15 candidate axes
 * (> 0: disjoint by at least that much; <= 0: touching / overlapping, |value| ~ penetration depth).
 */
export function obbGap(a: Obb, b: Obb): number {
  let best = -Infinity;
  const tx = b[0] - a[0];
  const ty = b[1] - a[1];
  const tz = b[2] - a[2];
  const test = (nx: number, ny: number, nz: number): void => {
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-6) return;
    nx /= len;
    ny /= len;
    nz /= len;
    let ra = 0;
    let rb = 0;
    for (let k = 0; k < 3; k++) {
      ra += a[12 + k] * Math.abs(a[3 + k * 3] * nx + a[4 + k * 3] * ny + a[5 + k * 3] * nz);
      rb += b[12 + k] * Math.abs(b[3 + k * 3] * nx + b[4 + k * 3] * ny + b[5 + k * 3] * nz);
    }
    const d = Math.abs(tx * nx + ty * ny + tz * nz) - ra - rb;
    if (d > best) best = d;
  };
  for (let k = 0; k < 3; k++) test(a[3 + k * 3], a[4 + k * 3], a[5 + k * 3]);
  for (let k = 0; k < 3; k++) test(b[3 + k * 3], b[4 + k * 3], b[5 + k * 3]);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      const ux = a[3 + i * 3];
      const uy = a[4 + i * 3];
      const uz = a[5 + i * 3];
      const vx = b[3 + j * 3];
      const vy = b[4 + j * 3];
      const vz = b[5 + j * 3];
      AX[0] = uy * vz - uz * vy;
      AX[1] = uz * vx - ux * vz;
      AX[2] = ux * vy - uy * vx;
      test(AX[0], AX[1], AX[2]);
    }
  return best;
}

/** small seeded PRNG (mulberry32) for tests / reproducible layouts */
export function seeded(seed: number): Rnd {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
