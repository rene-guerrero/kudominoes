import { describe, expect, it } from 'vitest';
import { fitRing, ringHalfWidth, ringRadius, type RingGeo, type TileDims } from './idleRing';

// must match tableView.ts (TL, TW, TH, IDLE_TILT, IDLE_GAP)
const DIMS: TileDims = { l: 1.92, w: 0.94, t: 0.3 };
const TILT = 0.12;
const GAP = 0.12;

type P = [number, number];

/** footprint (top view) of ring tile k: tangential half-width hw, radial half-thickness h */
function footprint(g: RingGeo, k: number, phase: number): P[] {
  const a = (k / g.n) * Math.PI * 2 + phase;
  const hw = ringHalfWidth(DIMS, TILT) * g.s;
  const h = (DIMS.t / 2) * g.s;
  const rx = Math.cos(a);
  const rz = Math.sin(a);
  const tx = -rz;
  const tz = rx;
  const c: P = [rx * g.r, rz * g.r];
  return [
    [c[0] - rx * h - tx * hw, c[1] - rz * h - tz * hw],
    [c[0] + rx * h - tx * hw, c[1] + rz * h - tz * hw],
    [c[0] + rx * h + tx * hw, c[1] + rz * h + tz * hw],
    [c[0] - rx * h + tx * hw, c[1] - rz * h + tz * hw],
  ];
}

/** separating-axis distance between two convex polygons (> 0: disjoint by at least that much) */
function separation(A: P[], B: P[]): number {
  let best = -Infinity;
  for (const poly of [A, B]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const nx = q[1] - p[1];
      const nz = p[0] - q[0];
      const len = Math.hypot(nx, nz);
      const proj = (pts: P[]) => pts.map((v) => (v[0] * nx + v[1] * nz) / len);
      const a = proj(A);
      const b = proj(B);
      const gap = Math.max(Math.min(...b) - Math.max(...a), Math.min(...a) - Math.max(...b));
      best = Math.max(best, gap);
    }
  }
  return best;
}

describe('idle attract ring', () => {
  for (const s of [0.8, 0.6, 0.45, 0.3]) {
    it(`28 tiles at scale ${s} keep a visible gap between neighbours`, () => {
      const g = fitRing({ n: 0, r: 0, s: 0 }, 28, DIMS, TILT, GAP, s, Infinity);
      expect(g.s).toBeCloseTo(s);
      for (const phase of [0, 0.037, 0.11]) {
        for (let k = 0; k < 28; k++) {
          const d = separation(footprint(g, k, phase), footprint(g, (k + 1) % 28, phase));
          expect(d).toBeGreaterThan(GAP * s * 0.99);
        }
      }
    });
  }

  it('scales radius and tiles together to fit a smaller circle', () => {
    const big = fitRing({ n: 0, r: 0, s: 0 }, 28, DIMS, TILT, GAP, 0.8, Infinity);
    const small = fitRing({ n: 0, r: 0, s: 0 }, 28, DIMS, TILT, GAP, 0.8, 2.5);
    expect(small.s).toBeLessThan(big.s);
    expect(small.r / small.s).toBeCloseTo(big.r / big.s);
    expect(small.r + (DIMS.t / 2) * small.s).toBeLessThanOrEqual(2.5);
  });

  it('radius grows with the tile count', () => {
    expect(ringRadius(28, DIMS, TILT, GAP)).toBeGreaterThan(ringRadius(20, DIMS, TILT, GAP));
  });
});
