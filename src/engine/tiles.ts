import type { Pip, Tile } from '../contracts';

function buildTiles(): Tile[] {
  const out: Tile[] = [];
  let id = 0;
  for (let a = 0; a <= 6; a++) {
    for (let b = a; b <= 6; b++) {
      out.push(Object.freeze({ id: id++, a: a as Pip, b: b as Pip }));
    }
  }
  return out;
}

/** 28 tiles ordered 0-0, 0-1, …, 0-6, 1-1, …, 6-6. */
export const ALL_TILES: Tile[] = Object.freeze(buildTiles()) as Tile[];

export const DOUBLE_SIX_ID = 27;
export const DOUBLE_BLANK_ID = 0;

/** Fast lookups by id. */
export const TILE_A = new Int8Array(28);
export const TILE_B = new Int8Array(28);
for (const t of ALL_TILES) {
  TILE_A[t.id] = t.a;
  TILE_B[t.id] = t.b;
}

export const pipsOf = (t: Tile): number => t.a + t.b;
export const isDouble = (t: Tile): boolean => t.a === t.b;
export const hasPip = (t: Tile, p: number): boolean => t.a === p || t.b === p;
export const handPips = (h: readonly Tile[]): number => h.reduce((s, t) => s + t.a + t.b, 0);
