import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MenuDirector, type MenuHost, type MenuTile } from './menuScenes';
import { newObb, obbGap, seeded, tileObb } from './menuPaths';

/** the fake view: a circle of radius VIEW around (CX, CZ) on the felt */
const VIEW = 9;
const CX = 0.3;
const CZ = -0.4;
const onScreen = (t: MenuTile) => t.s > 0.02 && t.pos.y > -1 && Math.hypot(t.pos.x - CX, t.pos.z - CZ) < VIEW + 1.12 * t.s + 0.05;

function makeHost(lite: boolean, seed: number): MenuHost {
  return {
    tiles: Array.from({ length: 28 }, () => ({ pos: new THREE.Vector3(0, -5, 0), quat: new THREE.Quaternion(), s: 0.8, dim: 0 })),
    offscreen: (x, _y, z, r) => Math.hypot(x - CX, z - CZ) > VIEW + r,
    fit: (_box, maxS, out) => {
      out.s = Math.min(maxS, 0.55);
      out.cx = CX;
      out.cz = CZ;
    },
    lite,
    rnd: seeded(seed),
  };
}

const A = newObb();
const B = newObb();

/**
 * Worst penetration (> 0 = overlap) between two visible tiles. An overlap lies inside both tiles'
 * bounding spheres, so if either sphere is fully off screen nobody can see it.
 */
function worstOverlap(tiles: readonly MenuTile[]): number {
  let pen = -Infinity;
  for (let i = 0; i < 28; i++) {
    const a = tiles[i];
    if (!onScreen(a)) continue;
    tileObb(A, a.pos.x, a.pos.y, a.pos.z, a.quat.x, a.quat.y, a.quat.z, a.quat.w, a.s);
    for (let j = i + 1; j < 28; j++) {
      const b = tiles[j];
      if (!onScreen(b)) continue;
      tileObb(B, b.pos.x, b.pos.y, b.pos.z, b.quat.x, b.quat.y, b.quat.z, b.quat.w, b.s);
      pen = Math.max(pen, -obbGap(A, B));
    }
  }
  return pen;
}

/**
 * Three rounds (in, stand, topple, out) with random taps: worst tile/tile penetration over the whole
 * timeline, and every on-screen pop (a visible tile changing size or jumping between frames).
 */
function run(lite: boolean, seed: number, taps: number, dt = 1 / 60, reduced = false) {
  const host = makeHost(lite, seed);
  const dir = new MenuDirector(host);
  dir.start(reduced);
  const tr = seeded(seed * 7 + 1);
  const tapAt = Array.from({ length: taps }, () => tr() * 30).sort((a, b) => a - b);
  const prev = host.tiles.map((t) => ({ x: t.pos.x, z: t.pos.z, s: t.s, on: onScreen(t) }));
  const pops: string[] = [];
  let worst = -Infinity;
  let ti = 0;
  let t = 0;
  while (dir.rounds < 4 && t < 120) {
    if (ti < tapAt.length && t >= tapAt[ti++]) {
      const vis = host.tiles.filter(onScreen);
      const p = vis.length ? vis[Math.floor(tr() * vis.length)].pos : new THREE.Vector3(CX, 0, CZ);
      dir.tap(p.x + (tr() - 0.5) * 0.3, p.z + (tr() - 0.5) * 0.3);
    }
    dir.update(dt);
    t += dt;
    worst = Math.max(worst, worstOverlap(host.tiles));
    host.tiles.forEach((tile, i) => {
      const p = prev[i];
      const on = onScreen(tile);
      const moved = Math.hypot(tile.pos.x - p.x, tile.pos.z - p.z);
      if ((on || p.on) && (Math.abs(tile.s - p.s) > 1e-9 || moved > 40 * dt)) pops.push(`t=${t.toFixed(2)} tile ${i} moved ${moved.toFixed(2)}`);
      p.x = tile.pos.x;
      p.z = tile.pos.z;
      p.s = tile.s;
      p.on = on;
    });
  }
  return { worst, pops, rounds: dir.rounds, t };
}

/** allowed contact depth: resting tiles may touch (the real tiles have rounded edges) */
const TOL = 0.006;

describe('menu falling dominoes', () => {
  for (const lite of [false, true]) {
    it(`${lite ? 'low' : 'high'}: no intersections, tiles only enter / leave past the screen edge`, () => {
      for (let seed = 1; seed <= 6; seed++) {
        for (const taps of [0, 6]) {
          const r = run(lite, seed * 13 + (lite ? 5 : 0), taps);
          expect(r.rounds, `seed ${seed}`).toBe(4);
          expect(r.worst, `seed ${seed} taps ${taps}`).toBeLessThan(TOL);
          expect(r.pops, `seed ${seed} taps ${taps}`).toEqual([]);
        }
      }
    });
  }

  it('30 fps keeps the same guarantees', () => {
    const r = run(true, 99, 5, 1 / 30);
    expect(r.worst).toBeLessThan(TOL);
    expect(r.pops).toEqual([]);
  });

  it('reduced motion: one ficha drifts in and out, never pops', () => {
    const r = run(false, 5, 2, 1 / 30, true);
    expect(r.rounds).toBe(4);
    expect(r.pops).toEqual([]);
  });

  it('a game left on the table slides off before the first round', () => {
    const host = makeHost(false, 3);
    host.tiles.forEach((t, i) => t.pos.set(CX + (i % 7) * 1.2 - 3.6, 0.1, CZ + Math.floor(i / 7) * 2.2 - 3.3));
    const dir = new MenuDirector(host);
    dir.start(false);
    expect(dir.sceneName).toBe(null);
    for (let i = 0; i < 60 * 8 && dir.rounds < 1; i++) dir.update(1 / 60);
    expect(dir.rounds).toBe(1);
  });
});
