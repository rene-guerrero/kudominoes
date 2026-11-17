/**
 * Main-menu attract loop: the rotating ring.
 *
 * All 28 fichas stand upright on a circle, wide face outward, and the ring turns slowly while each tile
 * bobs and wobbles a little. The ring radius comes from the tile size (idleRing.ts), so neighbours can
 * never touch, whatever the wobble; bobbing is vertical only. The whole ring is scaled to fit the free
 * screen area between the logo and the buttons.
 *
 * Entry: every tile glides from where it is (a finished game's table, or beyond the screen edge when it
 * was hidden) into its ring slot; nothing appears from nowhere. A tap spins the ring faster for a moment
 * and sends a hop wave round it. Silent. Reduced motion: a very slow turn, no bob or wobble.
 *
 * Per frame: no allocations.
 */
import * as THREE from 'three';
import { ringHalfWidth, ringRadius, type TileDims } from './idleRing';

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
  readonly lite: boolean;
  readonly rnd: () => number;
}

const TL = 1.92;
const TW = 0.94;
const TH = 0.3;
const N = 28;
const DIMS: TileDims = { l: TL, w: TW, t: TH };
const TILT = 0.12;
const GAP = 0.14;
const LIFT = 0.1;
const BOB = 0.4;
const HOP = 0.9;
const MAX_S = 0.8;
const SPIN = 0.18;
const SPIN_REDUCED = 0.05;
/** entry glide: per-tile stagger and duration */
const IN_STAGGER = 0.025;
const IN_DUR = 1.1;

const R1 = ringRadius(N, DIMS, TILT, GAP);
const HW1 = ringHalfWidth(DIMS, TILT);
const OUTER1 = Math.hypot(R1 + TH / 2, HW1);

const vA = new THREE.Vector3();
const vX = new THREE.Vector3();
const vY = new THREE.Vector3();
const vZ = new THREE.Vector3();
const qA = new THREE.Quaternion();
const qB = new THREE.Quaternion();
const mA = new THREE.Matrix4();

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const tileR = (s: number) => 1.12 * s + 0.05;

export class RingDirector {
  private time = 0;
  /** ring angle (integrated, so speed changes never jump) */
  private angle = 0;
  private boost = 0;
  /** hop wave: start time and the angle it starts from */
  private hopT = -99;
  private hopA = 0;
  private reduced = false;
  private fit: Fit = { s: 0.5, cx: 0, cz: 0 };
  private target: Fit = { s: 0.5, cx: 0, cz: 0 };
  private fitAge = 99;
  private entering = false;
  private enterT = 0;
  private from = Array.from({ length: N }, () => ({ pos: new THREE.Vector3(), quat: new THREE.Quaternion(), s: 1 }));
  private box: FitBox = { x0: -OUTER1, x1: OUTER1, z0: -OUTER1, z1: OUTER1, h: TL + LIFT + BOB + HOP };

  constructor(private host: MenuHost) {}

  private refit(): void {
    this.host.fit(this.box, MAX_S, this.target);
    this.fitAge = 0;
  }

  /** (re)start after reset(): every tile glides into its ring slot from wherever it is */
  start(reduced: boolean): void {
    this.reduced = reduced;
    this.refit();
    this.fit.s = this.target.s;
    this.fit.cx = this.target.cx;
    this.fit.cz = this.target.cz;
    this.boost = 0;
    this.hopT = -99;
    const f = this.fit;
    for (let i = 0; i < N; i++) {
      const t = this.host.tiles[i];
      const fr = this.from[i];
      const hidden = t.s < 0.01 || t.pos.y < -1 || this.host.offscreen(t.pos.x, t.pos.y, t.pos.z, tileR(Math.max(t.s, 0.1)));
      if (hidden) {
        // waits beyond the screen edge, outward from its slot, lying flat
        const a = this.slotAngle(i);
        const dx = Math.cos(a);
        const dz = Math.sin(a);
        const y = (TH / 2) * f.s;
        let d = 0;
        while (d < 300 && !this.host.offscreen(f.cx + dx * d, y, f.cz + dz * d, tileR(f.s))) d += Math.max(0.3, d * 0.08);
        fr.pos.set(f.cx + dx * (d + 1), y, f.cz + dz * (d + 1));
        fr.quat.setFromAxisAngle(vA.set(0, 1, 0), -a);
        fr.s = f.s;
      } else {
        fr.pos.copy(t.pos);
        fr.quat.copy(t.quat);
        fr.s = t.s;
      }
      t.dim = 0;
    }
    this.entering = true;
    this.enterT = 0;
    this.pose();
  }

  setReduced(r: boolean): void {
    this.reduced = r;
  }

  /** wants full-rate frames (the slow reduced-motion turn is fine at the ambient rate) */
  get busy(): boolean {
    return this.entering || !this.reduced || this.boost > 0.01;
  }

  private slotAngle(i: number): number {
    return (i / N) * Math.PI * 2 + this.angle;
  }

  update(dt: number): void {
    this.time += dt;
    this.fitAge += dt;
    if (this.fitAge > 0.5) this.refit();
    // ease toward the target fit (resizes, the menu moving) instead of jumping
    const k = 1 - Math.exp(-dt * 4);
    this.fit.s += (this.target.s - this.fit.s) * k;
    this.fit.cx += (this.target.cx - this.fit.cx) * k;
    this.fit.cz += (this.target.cz - this.fit.cz) * k;
    this.boost *= Math.exp(-dt * 1.6);
    this.angle += dt * ((this.reduced ? SPIN_REDUCED : SPIN) + this.boost);
    if (this.entering) {
      this.enterT += dt;
      if (this.enterT > (N - 1) * IN_STAGGER + IN_DUR) this.entering = false;
    }
    this.pose();
  }

  /** tap anywhere on the felt: a spin burst and a hop wave starting from the tile nearest the tap */
  tap(x: number, z: number): void {
    if (this.entering) return;
    this.boost = Math.min(this.boost + 2.2, 4);
    this.hopT = this.time;
    this.hopA = Math.atan2(z - this.fit.cz, x - this.fit.cx);
  }

  private pose(): void {
    const f = this.fit;
    const s = f.s;
    const R = R1 * s;
    const calm = this.reduced;
    for (let i = 0; i < N; i++) {
      const t = this.host.tiles[i];
      const a = this.slotAngle(i);
      const ox = Math.cos(a);
      const oz = Math.sin(a);
      let lift = LIFT * s;
      if (!calm) {
        lift += (Math.sin(this.time * 1.6 + i * 0.7) * 0.5 + 0.5) * BOB * s;
        // hop wave: travels both ways round the ring from the tapped angle
        const ht = this.time - this.hopT;
        if (ht < 2) {
          let da = Math.abs(a - this.hopA) % (Math.PI * 2);
          if (da > Math.PI) da = Math.PI * 2 - da;
          const local = ht - da * 0.18;
          if (local > 0 && local < 0.45) lift += Math.sin((local / 0.45) * Math.PI) * HOP * s;
        }
      }
      vA.set(f.cx + ox * R, (TL * s) / 2 + lift, f.cz + oz * R);
      // upright (tile length along world up), wide face outward
      vX.set(0, 1, 0);
      vY.set(ox, 0, oz);
      vZ.crossVectors(vX, vY);
      mA.makeBasis(vX, vY, vZ);
      qA.setFromRotationMatrix(mA);
      if (!calm) {
        qB.setFromAxisAngle(vY, Math.sin(this.time * 0.9 + i) * TILT);
        qA.premultiply(qB);
      }
      if (this.entering) {
        const u = smooth((this.enterT - i * IN_STAGGER) / IN_DUR);
        const fr = this.from[i];
        if (u < 1) {
          // glide with a small arc so tiles coming off the table rise over their neighbours
          const arc = Math.sin(u * Math.PI) * 1.2 * s;
          t.pos.lerpVectors(fr.pos, vA, u);
          t.pos.y += arc;
          t.quat.slerpQuaternions(fr.quat, qA, u);
          t.s = fr.s + (s - fr.s) * u;
          continue;
        }
      }
      t.pos.copy(vA);
      t.quat.copy(qA);
      t.s = s;
    }
  }
}
