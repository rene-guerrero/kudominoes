/**
 * Geometry of the main-menu attract ring: N tiles standing upright on a circle, wide face outward
 * (tile width tangential, thickness radial), each wobbling sideways by up to `tilt` radians.
 * Everything scales linearly with the tile scale `s`, so the ring is fitted by scaling it uniformly.
 */
export interface TileDims {
  /** length (stands vertical in the ring) */
  l: number;
  /** width (tangential) */
  w: number;
  /** thickness (radial) */
  t: number;
}

export interface RingGeo {
  n: number;
  /** circle radius of the tile centres */
  r: number;
  /** tile scale */
  s: number;
}

/** tangential half-extent of a tile at scale 1, worst case over the sideways wobble */
export function ringHalfWidth(d: TileDims, tilt: number): number {
  return (d.w * Math.cos(tilt) + d.l * Math.sin(tilt)) / 2;
}

/**
 * Smallest centre radius (scale 1) so neighbouring footprints keep at least `gap` between them.
 * Footprint A at angle 0 spans radius [r-h, r+h], tangent [-hw, hw]; it stays clear of the bisector
 * with its neighbour (angle π/n) iff its inner corner does: (r-h)·sin(π/n) − hw·cos(π/n) ≥ gap/2.
 */
export function ringRadius(n: number, d: TileDims, tilt: number, gap: number): number {
  const half = Math.PI / n;
  const hw = ringHalfWidth(d, tilt);
  return d.t / 2 + (hw * Math.cos(half) + gap / 2) / Math.sin(half);
}

/**
 * Fit the ring into a circle of radius `maxOuter` (world units, outermost tile extent) by scaling it
 * uniformly, never above `baseS`. Writes into `out` (no allocation).
 */
export function fitRing(out: RingGeo, n: number, d: TileDims, tilt: number, gap: number, baseS: number, maxOuter: number): RingGeo {
  const r1 = ringRadius(n, d, tilt, gap);
  const outer1 = Math.hypot(r1 + d.t / 2, ringHalfWidth(d, tilt));
  const s = Math.max(0.05, Math.min(baseS, maxOuter / outer1));
  out.n = n;
  out.s = s;
  out.r = r1 * s;
  return out;
}
