import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { RingDirector, type MenuHost, type MenuTile } from './menuRing';

function host(): MenuHost {
  const tiles: MenuTile[] = Array.from({ length: 28 }, (_, i) => ({ pos: new THREE.Vector3(i * 0.3, 0.15, 0), quat: new THREE.Quaternion(), s: i < 10 ? 0.7 : 0, dim: 0 }));
  return {
    tiles,
    fit: (_box, maxS, out) => {
      out.s = Math.min(0.6, maxS);
      out.cx = 0;
      out.cz = 0;
    },
    offscreen: (x, _y, z) => Math.hypot(x, z) > 20,
    lite: false,
    rnd: Math.random,
  };
}

describe('menu ring', () => {
  it('hidden tiles enter from off screen, then everyone stands in the ring without touching', () => {
    const h = host();
    const dir = new RingDirector(h);
    dir.start(false);
    // a hidden tile starts beyond the screen edge, not in the middle of the table
    expect(Math.hypot(h.tiles[20].pos.x, h.tiles[20].pos.z)).toBeGreaterThan(20);
    for (let k = 0; k < 200; k++) dir.update(1 / 60);
    dir.tap(1, 1);
    for (let k = 0; k < 600; k++) {
      dir.update(1 / 60);
      for (let i = 0; i < 28; i++) {
        const a = h.tiles[i].pos;
        const b = h.tiles[(i + 1) % 28].pos;
        expect(Number.isFinite(a.x + a.y + a.z)).toBe(true);
        expect(h.tiles[i].s).toBeCloseTo(0.6, 5);
        // horizontal centre spacing stays above the tile width (wobble included)
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(0.94 * 0.6);
      }
    }
  });
});
