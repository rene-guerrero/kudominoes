import { describe, it, expect } from 'vitest';
import type { PlacedTile, Pip, Tile, Side } from '../contracts';
import { layoutChain, type ChainBounds, type TilePose } from './chainLayout';

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

function check(chain: PlacedTile[], b: ChainBounds) {
  const res = layoutChain(chain, b);
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
});
