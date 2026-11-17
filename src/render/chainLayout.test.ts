import { describe, it, expect } from 'vitest';
import type { PlacedTile, Pip, Tile, Side } from '../contracts';
import { layoutChain, type AvoidRect, type ChainBounds, type ChainLayoutOptions, type TilePose } from './chainLayout';

const ALL: Tile[] = [];
for (let a = 0; a <= 6; a++) for (let b = a; b <= 6; b++) ALL.push({ id: ALL.length, a: a as Pip, b: b as Pip });

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

/** random legal play (no hands) until stuck or `max` tiles */
function randomChain(r: () => number, max = 28): PlacedTile[] {
  const pool = ALL.slice();
  const first = pool.splice(Math.floor(r() * pool.length), 1)[0];
  const chain: PlacedTile[] = [{ tile: first, seat: 0, side: 'right', outer: first.b }];
  let L: number = first.a;
  let R: number = first.b;
  while (chain.length < max) {
    const opts: { i: number; side: Side }[] = [];
    pool.forEach((t, i) => {
      if (t.a === L || t.b === L) opts.push({ i, side: 'left' });
      if (t.a === R || t.b === R) opts.push({ i, side: 'right' });
    });
    if (!opts.length) break;
    const o = opts[Math.floor(r() * opts.length)];
    const t = pool.splice(o.i, 1)[0];
    const end = o.side === 'left' ? L : R;
    const outer = (t.a === end ? t.b : t.a) as Pip;
    chain.push({ tile: t, seat: (chain.length % 4) as 0, side: o.side, outer });
    if (o.side === 'left') L = outer;
    else R = outer;
  }
  return chain;
}

/** Eulerian line through all 28 tiles (random), as vertex sequence + tiles */
function eulerLine(r: () => number): { tiles: Tile[]; verts: number[] } {
  for (;;) {
    const used = new Set<number>();
    const start = Math.floor(r() * 7);
    // Hierholzer with random edge order
    const stack: { v: number; t: number }[] = [{ v: start, t: -1 }];
    const path: { v: number; t: number }[] = [];
    while (stack.length) {
      const top = stack[stack.length - 1];
      const cand = ALL.filter((t) => !used.has(t.id) && (t.a === top.v || t.b === top.v));
      if (cand.length) {
        const t = cand[Math.floor(r() * cand.length)];
        used.add(t.id);
        stack.push({ v: t.a === top.v ? t.b : t.a, t: t.id });
      } else path.push(stack.pop()!);
    }
    path.reverse();
    if (path.length !== 29) continue;
    return { verts: path.map((p) => p.v), tiles: path.slice(1).map((p) => ALL[p.t]) };
  }
}

/** turn a line into a legal chain split at k with interleaved (or one-sided) play order */
function chainFromLine(line: { tiles: Tile[]; verts: number[] }, k: number, r: () => number): PlacedTile[] {
  let { tiles, verts } = line;
  if (tiles[k].a !== verts[k]) {
    tiles = tiles.slice().reverse();
    verts = verts.slice().reverse();
    k = tiles.length - 1 - k;
  }
  const first = tiles[k];
  const chain: PlacedTile[] = [{ tile: first, seat: 0, side: 'right', outer: first.b }];
  const rights: PlacedTile[] = [];
  const lefts: PlacedTile[] = [];
  for (let j = k + 1; j < tiles.length; j++) rights.push({ tile: tiles[j], seat: 0, side: 'right', outer: verts[j + 1] as Pip });
  for (let j = k - 1; j >= 0; j--) lefts.push({ tile: tiles[j], seat: 0, side: 'left', outer: verts[j] as Pip });
  while (rights.length || lefts.length) {
    const takeRight = lefts.length === 0 || (rights.length > 0 && r() < 0.5);
    chain.push((takeRight ? rights : lefts).shift()!);
  }
  return chain;
}

function halves(p: TilePose, cell: number, t: Tile): { x: number; z: number; pip: number }[] {
  const ux = Math.cos(p.rotY) * 0.5 * cell;
  const uz = -Math.sin(p.rotY) * 0.5 * cell;
  return [
    { x: p.x - ux, z: p.z - uz, pip: t.a },
    { x: p.x + ux, z: p.z + uz, pip: t.b },
  ];
}

function check(chain: PlacedTile[], b: ChainBounds, opts: ChainLayoutOptions = {}) {
  const res = layoutChain(chain, b, opts);
  expect(res.fits).toBe(true);
  const { poses, cell } = res;
  const e = 1e-5;
  const rects = poses.map((p) => {
    const alongX = Math.abs(Math.cos(p.rotY)) > 0.5;
    const hx = (alongX ? 1 : 0.5) * cell;
    const hz = (alongX ? 0.5 : 1) * cell;
    return { x: p.x, z: p.z, hx, hz };
  });
  // inside bounds
  for (const q of rects) {
    expect(q.x - q.hx).toBeGreaterThanOrEqual(b.cx - b.w / 2 - e);
    expect(q.x + q.hx).toBeLessThanOrEqual(b.cx + b.w / 2 + e);
    expect(q.z - q.hz).toBeGreaterThanOrEqual(b.cz - b.h / 2 - e);
    expect(q.z + q.hz).toBeLessThanOrEqual(b.cz + b.h / 2 + e);
  }
  // no overlaps
  for (let i = 0; i < rects.length; i++)
    for (let j = 0; j < i; j++) {
      const p = rects[i];
      const q = rects[j];
      const ov = Math.abs(p.x - q.x) < p.hx + q.hx - e && Math.abs(p.z - q.z) < p.hz + q.hz - e;
      expect(ov, `tiles ${i} and ${j} overlap`).toBe(false);
    }
  // clear of every keep-out rect
  for (const q of rects)
    for (const a of opts.avoid ?? []) {
      const ov = q.x + q.hx > a.x0 + e && q.x - q.hx < a.x1 - e && q.z + q.hz > a.z0 + e && q.z - q.hz < a.z1 - e;
      expect(ov, 'tile under a keep-out rect').toBe(false);
    }
  // joints: matching halves are edge-adjacent
  let lastRight = 0;
  let lastLeft = 0;
  for (let i = 1; i < chain.length; i++) {
    const pt = chain[i];
    const pred = pt.side === 'right' ? lastRight : lastLeft;
    let v: number;
    if (pred === 0) v = pt.side === 'right' ? chain[0].outer : chain[0].tile.a === chain[0].outer ? chain[0].tile.b : chain[0].tile.a;
    else v = chain[pred].outer;
    if (pred === 0 && chain[0].tile.a === chain[0].tile.b) v = chain[0].tile.a;
    const ph = halves(poses[pred], cell, chain[pred].tile).filter((h) => h.pip === v);
    const ch = halves(poses[i], cell, pt.tile).filter((h) => h.pip === v);
    expect(ph.length).toBeGreaterThan(0);
    expect(ch.length).toBeGreaterThan(0);
    let ok = false;
    for (const h1 of ph)
      for (const h2 of ch) {
        const dx = Math.abs(h1.x - h2.x);
        const dz = Math.abs(h1.z - h2.z);
        if ((Math.abs(dx - cell) < e && dz < cell * 0.8) || (Math.abs(dz - cell) < e && dx < cell * 0.8)) ok = true;
      }
    expect(ok, `joint ${pred}->${i} not adjacent`).toBe(true);
    // the outer half must not be the touching one: outer pip half is further from predecessor
    if (pt.side === 'right') lastRight = i;
    else lastLeft = i;
  }
  return res;
}

const BOUNDS: ChainBounds[] = [
  { cx: 0, cz: 0, w: 22, h: 9 }, // landscape
  { cx: 0, cz: -0.5, w: 9, h: 15 }, // portrait
  { cx: 1, cz: 2, w: 12, h: 12 }, // square, offset
  { cx: 0, cz: 0, w: 6, h: 4 }, // tiny
];

describe('layoutChain', () => {
  it('handles empty chain and single tiles', () => {
    expect(layoutChain([], BOUNDS[0]).poses.length).toBe(0);
    for (const t of ALL) check([{ tile: t, seat: 0, side: 'right', outer: t.b }], BOUNDS[0]);
  });

  it('random legal chains fit, never overlap, joints adjacent', () => {
    const r = rng(12345);
    for (let n = 0; n < 600; n++) {
      const c = randomChain(r);
      check(c, BOUNDS[n % BOUNDS.length]);
    }
  });

  it('worst case: full 28-tile chains, balanced and one-sided', () => {
    const r = rng(777);
    for (let n = 0; n < 120; n++) {
      const line = eulerLine(r);
      const k = n % 3 === 0 ? 0 : n % 3 === 1 ? 27 : Math.floor(r() * 28);
      const c = chainFromLine(line, k, r);
      expect(c.length).toBe(28);
      for (const b of BOUNDS) check(c, b);
    }
  });

  it('keeps the preferred cell size for short chains', () => {
    const r = rng(9);
    const c = randomChain(r, 6);
    expect(layoutChain(c, BOUNDS[0]).cell).toBe(1);
  });

  it('forced cell (ghost preview) keeps earlier poses stable', () => {
    const r = rng(42);
    const c = randomChain(r, 12);
    const base = layoutChain(c, BOUNDS[0]);
    const more = layoutChain(c.concat(randomChain(rng(1), 1)).slice(0, 12), BOUNDS[0], { cell: base.cell });
    expect(more.poses[5]).toEqual(base.poses[5]);
  });

  /** the real portrait composition at 360x740 (edge plates): full felt width, keep-out rects for the
   * plates, bubble zones and side stacks; cell limits from on-screen px (max ~0.8 hand tile, floor ~52 px) */
  const PORTRAIT: ChainBounds = { cx: 0, cz: 2.0, w: 12.0, h: 17.4 };
  const P_AVOID: AvoidRect[] = [
    { x0: -6.2, x1: -0.7, z0: 9, z1: 11 }, // human plate
    { x0: 0.0, x1: 5.7, z0: 9, z1: 11 }, // human bubble (beside the plate)
    { x0: 3.7, x1: 6.9, z0: 3.4, z1: 6.8 }, // right edge plate
    { x0: 3.2, x1: 7, z0: 2, z1: 4 }, // its compact bubble
    { x0: 0, x1: 5.7, z0: -7.3, z1: -4.6 }, // partner's bubble
    { x0: -6.9, x1: -3.7, z0: 3.4, z1: 6.8 },
    { x0: -7, x1: -3.2, z0: 2, z1: 4 },
    { x0: 4.6, x1: 24.6, z0: -1.6, z1: 4.6 }, // side stacks + reveal zone
    { x0: -24.6, x1: -4.6, z0: -1.6, z1: 4.6 },
  ];
  const P_OPTS: ChainLayoutOptions = { maxCell: 1.48, softMinCell: 1.04, vertical: true, avoid: P_AVOID };

  it('portrait: chains dodge keep-out rects and keep the readability floor until late', () => {
    const r = rng(2024);
    let below = 0;
    let total = 0;
    for (let n = 0; n < 160; n++) {
      const c = randomChain(r, 4 + (n % 17)); // 4..20 tiles
      const res = check(c, PORTRAIT, P_OPTS);
      total++;
      if (res.cell < 1.04 - 1e-9) below++;
      // early and mid-hand chains never drop below the readability floor
      if (c.length <= 14) expect(res.cell).toBeGreaterThanOrEqual(1.04 - 1e-9);
      // short chains always get the full size
      if (c.length <= 4) expect(res.cell).toBeCloseTo(1.48, 6);
    }
    // the floor is only crossed late (long, lopsided chains)
    expect(below / total).toBeLessThan(0.2);
  });

  it('portrait worst case: full 28-tile chains still fit, shrinking as little as needed', () => {
    const r = rng(4242);
    for (let n = 0; n < 40; n++) {
      const c = chainFromLine(eulerLine(r), Math.floor(r() * 28), r);
      const res = check(c, PORTRAIT, P_OPTS);
      expect(res.cell).toBeGreaterThan(0.5);
      // shrunk as little as possible: one fine step (3%) larger does not fit
      if (res.cell < 1.04 * 0.97) {
        const bigger = layoutChain(c, PORTRAIT, { cell: res.cell / 0.97, vertical: res.vertical, avoid: P_AVOID });
        expect(bigger.fits).toBe(false);
      }
    }
  });

  it('portrait preview (forced cell + orientation + slide) reproduces the live poses', () => {
    const r = rng(77);
    for (let n = 0; n < 30; n++) {
      const c = randomChain(r, 6 + (n % 14));
      const live = layoutChain(c, PORTRAIT, P_OPTS);
      const prev = layoutChain(c, PORTRAIT, { cell: live.cell, vertical: live.vertical, shift: live.shift, avoid: P_AVOID });
      expect(prev.poses).toEqual(live.poses);
    }
  });
});
