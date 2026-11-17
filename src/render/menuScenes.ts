/**
 * Main-menu attract loop: falling dominoes.
 *
 * Each round: the fichas slide in one after another from just beyond the nearest screen edge, stand
 * along a random path (S-curve, spiral, heart, zig-zag, arc or "KU"), topple in a wave (rotation about
 * the bottom edge, each tile coming to rest on the next), then slide off screen; the next round picks a
 * new path. A tap knocks over whatever is standing (from the tile nearest the tap); a tap while nothing
 * stands starts the next round. Reduced motion: one ficha drifts in slowly, rests, drifts out.
 *
 * Hard rules: silent (no sound at all); tiles never appear or vanish on screen (they always come from /
 * go to beyond the camera frustum); tiles never pass through each other. Moves in and out: a slide at a
 * cruise height above the standing tiles, plus a vertical drop into (or lift out of) the tile's own
 * footprint column; each move's start is delayed until its sampled boxes clear every other tile.
 * Toppling is limited by per-pair contact tables built from real box tests.
 *
 * Per frame: no allocations (state lives in preallocated arrays; round starts may allocate).
 */
import * as THREE from 'three';
import {
  ALL_SHAPES,
  LOW_SHAPES,
  TH,
  TL,
  buildDominoLayout,
  fallenRect,
  newObb,
  obbGap,
  standingRect,
  tileObb,
  type DomLayout,
  type PathShape,
  type Rnd,
} from './menuPaths';

export interface MenuTile {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  s: number;
  dim: number;
}

/** local box at tile scale 1 (XZ around the origin, y up from the felt) */
export interface FitBox {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  h: number;
}

export interface Fit {
  s: number;
  cx: number;
  cz: number;
}

export interface MenuHost {
  /** the 28 tiles, index = tile id */
  readonly tiles: readonly MenuTile[];
  /** scale + centre so the box (times s) sits in the free screen area, s <= maxS */
  fit(box: FitBox, maxS: number, out: Fit): void;
  /** is a sphere (world centre, radius) completely outside the camera view (with a margin)? */
  offscreen(x: number, y: number, z: number, r: number): boolean;
  /** low quality: fewer tiles, simpler paths */
  readonly lite: boolean;
  readonly rnd: Rnd;
}

const UP = new THREE.Vector3(0, 1, 0);
const vA = new THREE.Vector3();
const qA = new THREE.Quaternion();
const qB = new THREE.Quaternion();
const mA = new THREE.Matrix4();
const vY = new THREE.Vector3();
const vZ = new THREE.Vector3();

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const outCubic = (t: number) => 1 - (1 - t) * (1 - t) * (1 - t);
const inQuad = (t: number) => t * t;
const smooth = (t: number) => t * t * (3 - 2 * t);

/** bounding-sphere radius of a tile at scale s */
const tileR = (s: number) => 1.12 * s + 0.05;

/** distance along (dx, dz) from (x, z) that puts the sphere off screen for good (the frustum is convex) */
function offDistance(host: MenuHost, x: number, y: number, z: number, dx: number, dz: number, r: number): number {
  let lastOn = -1;
  for (let d = 0; d < 300; d += Math.max(0.2, d * 0.04)) if (!host.offscreen(x + dx * d, y, z + dz * d, r)) lastOn = d;
  return lastOn < 0 ? 0 : lastOn + Math.max(0.2, lastOn * 0.04) + 0.3;
}

// ───────────────────────── moves in / out ─────────────────────────

/**
 * Per tile: a slide in from (or out to) beyond the nearest screen edge at a cruise height, and a vertical
 * drop into (lift out of) its resting pose. The orientation never changes during a move.
 */
class Moves {
  kind = new Uint8Array(28); // 0 none, 1 in, 2 out
  t0 = new Float64Array(28);
  tS = new Float64Array(28);
  tV = new Float64Array(28);
  px = new Float64Array(28);
  py = new Float64Array(28);
  pz = new Float64Array(28);
  cy = new Float64Array(28);
  dx = new Float64Array(28);
  dz = new Float64Array(28);
  D = new Float64Array(28);
  /** box axes / half extents per tile (constant while moving) */
  obb: Float64Array[] = Array.from({ length: 28 }, () => newObb());

  end(i: number): number {
    return this.t0[i] + this.tS[i] + this.tV[i];
  }

  /** centre of tile i at time t; false while it is off stage (before an entry / after an exit) */
  at(i: number, t: number, out: THREE.Vector3): boolean {
    const k = t - this.t0[i];
    let away: number;
    let y: number;
    if (this.kind[i] === 1) {
      away = 1 - outCubic(clamp01(k / this.tS[i]));
      y = this.cy[i] + (this.py[i] - this.cy[i]) * smooth(clamp01((k - this.tS[i]) / this.tV[i]));
    } else {
      away = inQuad(clamp01((k - this.tV[i]) / this.tS[i]));
      y = this.py[i] + (this.cy[i] - this.py[i]) * smooth(clamp01(k / this.tV[i]));
    }
    out.set(this.px[i] + this.dx[i] * this.D[i] * away, y, this.pz[i] + this.dz[i] * this.D[i] * away);
    return this.kind[i] === 1 ? k > -0.02 : t < this.end(i) + 0.02;
  }
}

const OA = newObb();
const OB = newObb();
const pA = new THREE.Vector3();
const pB = new THREE.Vector3();
const pC = new THREE.Vector3();
/** sample step of the clearance checks (margins grow with the distance moved per step) */
const H = 1 / 60;
const pre = new Set<number>();

/**
 * Plan moves for `ids` in order: each one starts a small random delay after the previous one, later if
 * its sampled path would come closer than a small margin to any other tile (moving or resting).
 * Resting contacts (dominoes leaning on each other) and tiles moving apart are fine.
 */
function planMoves(host: MenuHost, mv: Moves, ids: number[], kind: 1 | 2, cruise: number, now: number, gap: number, slow = 1): void {
  const tiles = host.tiles;
  const planned: number[] = [];
  const rest = new Set(kind === 2 ? ids : []);
  // pairs already overlapping at the start (a game's tiles) are not this planner's business
  pre.clear();
  if (kind === 2)
    for (const i of ids)
      for (const j of ids) {
        if (j <= i) continue;
        const a = tiles[i];
        const b = tiles[j];
        tileObb(OA, a.pos.x, a.pos.y, a.pos.z, a.quat.x, a.quat.y, a.quat.z, a.quat.w, a.s);
        tileObb(OB, b.pos.x, b.pos.y, b.pos.z, b.quat.x, b.quat.y, b.quat.z, b.quat.w, b.s);
        if (obbGap(OA, OB) < -0.004) pre.add(i * 28 + j).add(j * 28 + i);
      }
  let start = now;
  for (const i of ids) {
    const t = tiles[i];
    rest.delete(i);
    mv.kind[i] = kind;
    mv.px[i] = t.pos.x;
    mv.py[i] = t.pos.y;
    mv.pz[i] = t.pos.z;
    mv.cy[i] = Math.max(cruise, t.pos.y);
    tileObb(mv.obb[i], 0, 0, 0, t.quat.x, t.quat.y, t.quat.z, t.quat.w, t.s);
    // the nearest edge: the shortest of four slides along the table's axes
    let best = Infinity;
    for (let a = 0; a < 4; a++) {
      const dx = a === 0 ? 1 : a === 1 ? -1 : 0;
      const dz = a === 2 ? 1 : a === 3 ? -1 : 0;
      const d = offDistance(host, t.pos.x, mv.cy[i], t.pos.z, dx, dz, tileR(t.s));
      if (d < best) {
        best = d;
        mv.dx[i] = dx;
        mv.dz[i] = dz;
      }
    }
    mv.D[i] = best;
    mv.tS[i] = Math.min(1.6, Math.max(0.45, best / 9)) * slow;
    mv.tV[i] = 0.22 * slow;
    start += gap * (0.6 + host.rnd() * 0.8);
    for (let tries = 0; tries < 300; tries++) {
      mv.t0[i] = start;
      if (clearOf(host, mv, i, planned, rest, now)) break;
      start += 0.1;
    }
    planned.push(i);
  }
}

/** does tile i's move keep clear of the planned moves and of the tiles still resting (`rest`)? */
function clearOf(host: MenuHost, mv: Moves, i: number, planned: number[], rest: Set<number>, now: number): boolean {
  const tiles = host.tiles;
  const r = tileR(tiles[i].s);
  // an entry stays on its spot afterwards: check it until every planned move is over
  let to = mv.end(i);
  if (mv.kind[i] === 1) for (const j of planned) to = Math.max(to, mv.end(j));
  const prev = new Float64Array(28).fill(Infinity);
  // an entry is beyond the screen until it starts
  const from = mv.kind[i] === 1 ? Math.max(now, mv.t0[i] - H) : now;
  for (let t = from; t <= to + H; t += H) {
    if (!mv.at(i, t, pA)) continue;
    // resting (before its exit / after its entry)
    const stillI = mv.kind[i] === 2 ? t < mv.t0[i] : t > mv.end(i);
    mv.at(i, t + H, pC);
    const di = pA.distanceTo(pC);
    const offA = host.offscreen(pA.x, pA.y, pA.z, r);
    for (let pass = 0; pass < 2; pass++) {
      const list: Iterable<number> = pass === 0 ? planned : rest;
      for (const j of list) {
        if (pre.has(i * 28 + j)) continue;
        // two resting tiles: nothing changes between them
        if (stillI && (pass === 1 || (mv.kind[j] === 2 ? t < mv.t0[j] : t > mv.end(j)))) {
          prev[j] = -Infinity; // a resting relation: the next move may start from contact
          continue;
        }
        let dj = 0;
        if (pass === 0) {
          if (!mv.at(j, t, pB)) {
            prev[j] = Infinity;
            continue;
          }
          mv.at(j, t + H, pC);
          dj = pB.distanceTo(pC);
        } else pB.copy(tiles[j].pos);
        const sj = tiles[j].s;
        const margin = 0.02 + Math.max(di, dj);
        if (pA.distanceTo(pB) > r + tileR(sj) + margin || offA || host.offscreen(pB.x, pB.y, pB.z, tileR(sj))) {
          prev[j] = Infinity;
          continue;
        }
        copyAt(OA, mv.obb[i], pA);
        if (pass === 0) copyAt(OB, mv.obb[j], pB);
        else tileObb(OB, pB.x, pB.y, pB.z, tiles[j].quat.x, tiles[j].quat.y, tiles[j].quat.z, tiles[j].quat.w, sj);
        const g = obbGap(OA, OB);
        // overlapping, or closing in within the margin (from a resting contact or out of the blue)
        if (g < -0.004 || (g < margin && g < prev[j] - 1e-6 && (prev[j] !== Infinity || t > from + H / 2))) return false;
        prev[j] = g;
      }
    }
  }
  return true;
}

function copyAt(o: Float64Array, src: Float64Array, p: THREE.Vector3): void {
  o.set(src);
  o[0] = p.x;
  o[1] = p.y;
  o[2] = p.z;
}

// ───────────────────────── falling dominoes ─────────────────────────

/** samples of the per-pair contact table (neighbour angle 0..π/2) */
const NS = 40;
const HALF_PI = Math.PI / 2;
/** angular gravity (rad/s² at sin φ = 1) and the cap on angular speed */
const GRAV = 15;
const OM_MAX = 7.5;
const SUB = 1 / 240;

class Round {
  n = 0;
  lx = new Float64Array(28);
  lz = new Float64Array(28);
  tx = new Float64Array(28);
  tz = new Float64Array(28);
  qb: THREE.Quaternion[] = [];
  ax: THREE.Vector3[] = [];
  id = new Int32Array(28);
  next = new Int32Array(28);
  prev = new Int32Array(28);
  trig = new Int32Array(28);
  falling = new Uint8Array(28);
  prop = new Uint8Array(28);
  phi = new Float64Array(28);
  om = new Float64Array(28);
  /** contact table: max angle of slot k for each angle of its next slot (k * (NS + 1) + m) */
  lim = new Float64Array(28 * (NS + 1));
  fit: Fit = { s: 0.5, cx: 0, cz: 0 };
  box: FitBox = { x0: 0, x1: 0, z0: 0, z1: 0, h: TL };
  settledFor = 0;

  constructor(host: MenuHost) {
    const rnd = host.rnd;
    const shapes = host.lite ? LOW_SHAPES : ALL_SHAPES;
    const maxN = host.lite ? 16 : 28;
    let lay: DomLayout | null = null;
    for (let tries = 0; !lay && tries < 12; tries++) {
      const shape: PathShape = shapes[Math.floor(rnd() * shapes.length)];
      lay = buildDominoLayout(shape, host.lite ? 12 + Math.floor(rnd() * 5) : 18 + Math.floor(rnd() * 9), maxN, rnd);
    }
    lay ??= buildDominoLayout('arc', 12, maxN, () => 0.5)!;
    const ids = Array.from({ length: 28 }, (_, i) => i);
    for (let i = 27; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    let k = 0;
    const lineStart: number[] = [];
    for (const ln of lay.lines) {
      lineStart.push(k);
      for (let i = 0; i < ln.x.length; i++, k++) {
        this.lx[k] = ln.x[i];
        this.lz[k] = -ln.y[i];
        this.tx[k] = Math.cos(ln.h[i]);
        this.tz[k] = -Math.sin(ln.h[i]);
        this.next[k] = i + 1 < ln.x.length ? k + 1 : -1;
        this.prev[k] = i > 0 ? k - 1 : -1;
        this.trig[k] = -1;
        this.id[k] = ids[k];
        // basis: local X (length) up, local Y (face) forward, local Z = up x forward
        vY.set(this.tx[k], 0, this.tz[k]);
        vZ.crossVectors(UP, vY);
        mA.makeBasis(UP, vY, vZ);
        this.qb.push(new THREE.Quaternion().setFromRotationMatrix(mA));
        this.ax.push(vZ.clone());
      }
    }
    this.n = k;
    for (const tr of lay.triggers) this.trig[lineStart[tr.fl] + tr.from] = lineStart[tr.tl] + tr.to;
    this.buildLimits();
    const b = this.box;
    b.x0 = b.z0 = Infinity;
    b.x1 = b.z1 = -Infinity;
    for (const ln of lay.lines)
      for (let i = 0; i < ln.x.length; i++)
        for (const r of [standingRect(ln.x[i], ln.y[i], ln.h[i]), fallenRect(ln.x[i], ln.y[i], ln.h[i])])
          for (const [su, sv] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
            const x = r.cx + r.ux * r.hu * su - r.uy * r.hv * sv;
            const y = r.cy + r.uy * r.hu * su + r.ux * r.hv * sv;
            b.x0 = Math.min(b.x0, x);
            b.x1 = Math.max(b.x1, x);
            b.z0 = Math.min(b.z0, -y);
            b.z1 = Math.max(b.z1, -y);
          }
    host.fit(b, 0.78, this.fit);
  }

  /** local pose (scale 1) of slot k toppled by phi */
  localPose(k: number, phi: number, out: THREE.Vector3, q: THREE.Quaternion): void {
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    const f = TH / 2 - (TH / 2) * c + (TL / 2) * s;
    out.set(this.lx[k] + this.tx[k] * f, (TH / 2) * s + (TL / 2) * c, this.lz[k] + this.tz[k] * f);
    q.setFromAxisAngle(this.ax[k], phi).multiply(this.qb[k]);
  }

  pose(k: number, tile: MenuTile): void {
    const { s: S, cx, cz } = this.fit;
    this.localPose(k, this.phi[k], tile.pos, tile.quat);
    tile.pos.set(cx + tile.pos.x * S, tile.pos.y * S, cz + tile.pos.z * S);
    tile.s = S;
    tile.dim = 0;
  }

  /** per-pair contact tables from real box tests (a small gap kept so interpolation never clips) */
  private buildLimits(): void {
    const A = newObb();
    const B = newObb();
    const pb = new THREE.Vector3();
    const qbb = new THREE.Quaternion();
    for (let k = 0; k < this.n; k++) {
      const nx = this.next[k];
      if (nx < 0) continue;
      let prevLim = 0;
      for (let m = 0; m <= NS; m++) {
        this.localPose(nx, (m / NS) * HALF_PI, pb, qbb);
        tileObb(B, pb.x, pb.y, pb.z, qbb.x, qbb.y, qbb.z, qbb.w, 1);
        const gapAt = (p: number) => {
          this.localPose(k, p, vA, qA);
          tileObb(A, vA.x, vA.y, vA.z, qA.x, qA.y, qA.z, qA.w, 1);
          return obbGap(A, B);
        };
        let v = HALF_PI;
        if (gapAt(HALF_PI) < 0.02) {
          let lo = gapAt(prevLim) >= 0.02 ? prevLim : 0;
          let hi = HALF_PI;
          for (let it = 0; it < 18; it++) {
            const mid = (lo + hi) / 2;
            if (gapAt(mid) >= 0.02) lo = mid;
            else hi = mid;
          }
          v = lo;
        }
        prevLim = Math.max(v, prevLim);
        this.lim[k * (NS + 1) + m] = prevLim;
      }
    }
  }

  private limitOf(k: number): number {
    const nx = this.next[k];
    if (nx < 0) return HALF_PI;
    const x = (this.phi[nx] / HALF_PI) * NS;
    const m = Math.min(NS - 1, Math.max(0, Math.floor(x)));
    const f = Math.min(1, Math.max(0, x - m));
    const o = k * (NS + 1);
    return this.lim[o + m] + (this.lim[o + m + 1] - this.lim[o + m]) * f;
  }

  knock(k: number, om: number, prop: number): void {
    if (this.falling[k]) return;
    this.falling[k] = 1;
    this.om[k] = om;
    this.prop[k] |= prop;
  }

  /** the standing tile nearest a world point, or -1 */
  nearestStanding(x: number, z: number): number {
    const { s: S, cx, cz } = this.fit;
    let best = -1;
    let bd = Infinity;
    for (let k = 0; k < this.n; k++) {
      if (this.falling[k]) continue;
      const d = Math.hypot(this.lx[k] - (x - cx) / S, this.lz[k] - (z - cz) / S);
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    return best;
  }

  /** physics in fixed substeps, last slot first so each tile sees its neighbour's new angle; true if moving */
  step(dt: number): boolean {
    let moving = false;
    for (let left = dt; left > 1e-9; left -= SUB) {
      const h = Math.min(SUB, left);
      for (let k = this.n - 1; k >= 0; k--) {
        if (!this.falling[k]) continue;
        const p0 = this.phi[k];
        let om = Math.min(OM_MAX, this.om[k] + GRAV * Math.sin(p0 + 0.06) * h);
        let p = p0 + om * h;
        const lim = this.limitOf(k);
        if (p >= lim) {
          p = Math.max(p0, lim);
          om = Math.min(om, (p - p0) / h);
          const nx = this.next[k];
          if (nx >= 0 && this.prop[k] & 1 && !this.falling[nx]) this.knock(nx, Math.max(1.6, this.om[k] * 0.95) + 0.45, 1);
        }
        if (p - p0 > 1e-5) moving = true;
        this.phi[k] = p;
        this.om[k] = om;
        const pv = this.prev[k];
        if (this.prop[k] & 2 && p > 0.32 && pv >= 0) this.knock(pv, 1.8, 2);
        const tg = this.trig[k];
        if (tg >= 0 && p > 0.42) {
          this.trig[k] = -1;
          this.knock(tg, 1.7, 3);
        }
      }
    }
    return moving;
  }
}

// ───────────────────────── the loop ─────────────────────────

/** reduced motion: 1|3 (the brand tile) and the doubles */
const SHOW_IDS = [9, 9, 9, 0, 7, 13, 18, 22, 25, 27];

type Phase = 'clear' | 'in' | 'stand' | 'topple' | 'out';

export class MenuDirector {
  private round: Round | null = null;
  private phase: Phase = 'clear';
  private phaseT = 0;
  private time = 0;
  private moves = new Moves();
  /** ids moving in the current phase (in / out / clear) */
  private movingIds: number[] = [];
  private movesEnd = 0;
  private reduced = false;
  private leaveAfterIn = false;
  /** reduced-motion showcase tile and its fit */
  private show = -1;
  private showFit: Fit = { s: 1, cx: 0, cz: 0 };
  private showSpin = 0;
  /** rounds started so far (tests / dev) */
  rounds = 0;

  constructor(private host: MenuHost) {}

  /** (re)start after reset(): whatever is on screen slides off first, then a round comes in */
  start(reduced: boolean): void {
    this.reduced = reduced;
    this.round = null;
    this.show = -1;
    this.leaveAfterIn = false;
    this.moves.kind.fill(0);
    const ids: number[] = [];
    let top = 0;
    let s = 0.6;
    for (let i = 0; i < 28; i++) {
      const t = this.host.tiles[i];
      if (t.s > 0.01 && t.pos.y > -1 && !this.host.offscreen(t.pos.x, t.pos.y, t.pos.z, tileR(t.s))) {
        ids.push(i);
        top = Math.max(top, t.pos.y);
        s = t.s;
      }
    }
    this.movingIds = ids;
    planMoves(this.host, this.moves, ids, 2, top + 2 * tileR(s), this.time, 0.04);
    this.movesEnd = this.lastEnd(ids);
    this.setPhase('clear');
  }

  setReduced(r: boolean): void {
    if (r === this.reduced) return;
    this.reduced = r;
    this.leave();
  }

  /** wants full-rate frames (the showcase resting is fine at the ambient rate) */
  get busy(): boolean {
    return !(this.show >= 0 && this.phase === 'stand');
  }

  get sceneName(): 'dominoes' | 'showcase' | null {
    return this.phase === 'clear' ? null : this.show >= 0 ? 'showcase' : 'dominoes';
  }

  private setPhase(p: Phase): void {
    this.phase = p;
    this.phaseT = 0;
  }

  private lastEnd(ids: number[]): number {
    let e = this.time;
    for (const i of ids) e = Math.max(e, this.moves.end(i));
    return e;
  }

  /** every tile waits beyond the screen, lying flat (also where a game flies them in from) */
  private parkAll(cx: number, cz: number, s: number): void {
    for (let i = 0; i < 28; i++) {
      const t = this.host.tiles[i];
      const a = (i / 28) * Math.PI * 2;
      const y = (TH / 2) * s;
      const d = offDistance(this.host, cx, y, cz, Math.cos(a), Math.sin(a), tileR(s)) * 1.1 + 2;
      t.pos.set(cx + Math.cos(a) * d, y, cz + Math.sin(a) * d);
      t.quat.setFromAxisAngle(UP, -a);
      t.s = s;
      t.dim = 0;
    }
  }

  /** a new round (or showcase tile) slides in */
  private begin(): void {
    this.rounds++;
    const host = this.host;
    let ids: number[];
    let cruise: number;
    if (this.reduced) {
      this.round = null;
      this.show = SHOW_IDS[Math.floor(host.rnd() * SHOW_IDS.length)];
      this.showSpin = host.rnd() * Math.PI * 2;
      host.fit({ x0: -TL * 0.6, x1: TL * 0.6, z0: -TL * 0.6, z1: TL * 0.6, h: TL * 0.8 }, 1.5, this.showFit);
      this.parkAll(this.showFit.cx, this.showFit.cz, this.showFit.s);
      ids = [this.show];
      this.showPose(0);
      cruise = 0;
    } else {
      this.show = -1;
      const r = (this.round = new Round(host));
      this.parkAll(r.fit.cx, r.fit.cz, r.fit.s);
      ids = Array.from(r.id.subarray(0, r.n));
      // the moves start from the resting poses (entering along the path order)
      for (let k = 0; k < r.n; k++) r.pose(k, host.tiles[r.id[k]]);
      cruise = TL * 1.5 * r.fit.s + 0.55;
    }
    this.movingIds = ids;
    planMoves(host, this.moves, ids, 1, cruise, this.time, this.reduced ? 0 : ids.length > 20 ? 0.09 : 0.13, this.reduced ? 3 : 1);
    this.movesEnd = this.lastEnd(ids);
    this.applyMoves();
    this.setPhase('in');
  }

  private showPose(t: number): void {
    const tile = this.host.tiles[this.show];
    const f = this.showFit;
    qA.setFromAxisAngle(vA.set(1, 0, 0), 0.55);
    qB.setFromAxisAngle(UP, this.showSpin + t * 0.12);
    tile.quat.copy(qA).multiply(qB);
    tile.pos.set(f.cx, f.s * (TL * 0.3 + 0.25), f.cz);
    tile.s = f.s;
    tile.dim = 0;
  }

  /** slide everything off (after the entries, if they are still coming in) */
  private leave(): void {
    if (this.phase === 'out' || this.phase === 'clear') return;
    if (this.phase === 'in') {
      this.leaveAfterIn = true;
      return;
    }
    const showing = this.show >= 0;
    const ids = showing ? [this.show] : Array.from(this.round!.id.subarray(0, this.round!.n));
    const s = this.host.tiles[ids[0]].s;
    // path order: a tile leaning on the next one leaves before it; the showcase drifts out slowly
    planMoves(this.host, this.moves, ids, 2, showing ? 0 : TL * 1.5 * s + 0.55, this.time, showing ? 0 : 0.07, showing ? 3 : 1);
    this.movingIds = ids;
    this.movesEnd = this.lastEnd(ids);
    this.setPhase('out');
  }

  private applyMoves(): void {
    const tiles = this.host.tiles;
    for (const i of this.movingIds) this.moves.at(i, this.time, tiles[i].pos);
  }

  update(dt: number): void {
    this.time += dt;
    this.phaseT += dt;
    const r = this.round;
    switch (this.phase) {
      case 'clear':
      case 'out':
        this.applyMoves();
        // one frame with everyone past the edge, then the next round
        if (this.time > this.movesEnd + dt) this.begin();
        return;
      case 'in':
        this.applyMoves();
        if (this.time >= this.movesEnd) {
          this.setPhase('stand');
          if (this.leaveAfterIn) {
            this.leaveAfterIn = false;
            this.leave();
          }
        }
        return;
      case 'stand':
        if (this.show >= 0) {
          this.showPose(this.phaseT);
          if (this.phaseT > 12) this.leave();
        } else if (this.phaseT > 0.45) {
          r!.knock(0, 1.3, 1);
          this.setPhase('topple');
        }
        return;
      case 'topple': {
        const moving = r!.step(dt);
        for (let k = 0; k < r!.n; k++) r!.pose(k, this.host.tiles[r!.id[k]]);
        r!.settledFor = moving ? 0 : r!.settledFor + dt;
        if (r!.settledFor > 1.4) this.leave();
        return;
      }
    }
  }

  /** tap at world (x, z) on the felt: knock over what stands, or (nothing standing) start the next round */
  tap(x: number, z: number): void {
    if (this.phase !== 'stand' && this.phase !== 'topple') return;
    const r = this.round;
    const k = r ? r.nearestStanding(x, z) : -1;
    if (!r || k < 0) {
      this.leave();
      return;
    }
    r.knock(k, 2.0, 3);
    this.setPhase('topple');
  }
}
