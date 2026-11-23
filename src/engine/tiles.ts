import type { GameMode, Pip, RuleSettings, Tile, TileSet } from '../contracts';

/** The physical sets share one global id space: 0..27 (double-six) and 28..82 (double-nine). */
export const DOUBLE6_COUNT = 28;
export const DOUBLE9_FIRST_ID = DOUBLE6_COUNT;
export const MAX_PIP = 9;
export const MAX_TILES = 55; // 0..9 → (10*11)/2
export const MAX_TILE_ID = DOUBLE9_FIRST_ID + MAX_TILES - 1;

export interface TileSetDef {
  key: TileSet;
  maxPip: number;
  /** ordered a<=b, ids are globally stable */
  tiles: readonly Tile[];
  ids: readonly number[];
  count: number;
  /** tiles dealt to each player in both pairs and individual play */
  handSize: number;
  blankId: number;
  /** the double used by the "double six opens" rule in this set (6-6 or 9-9) */
  highDoubleId: number;
}

function buildTiles(maxPip: number, firstId: number): Tile[] {
  const out: Tile[] = [];
  let id = firstId;
  for (let a = 0; a <= maxPip; a++) {
    for (let b = a; b <= maxPip; b++) {
      out.push(Object.freeze({ id: id++, a: a as Pip, b: b as Pip }));
    }
  }
  return out;
}

export const DOUBLE6_TILES: readonly Tile[] = Object.freeze(buildTiles(6, 0));
export const DOUBLE9_TILES: readonly Tile[] = Object.freeze(buildTiles(9, DOUBLE9_FIRST_ID));

export const TILE_SETS: Record<TileSet, TileSetDef> = Object.freeze({
  double6: Object.freeze({
    key: 'double6',
    maxPip: 6,
    tiles: DOUBLE6_TILES,
    ids: Object.freeze(DOUBLE6_TILES.map((t) => t.id)),
    count: DOUBLE6_TILES.length,
    handSize: 7,
    blankId: 0,
    highDoubleId: 27,
  }),
  double9: Object.freeze({
    key: 'double9',
    maxPip: 9,
    tiles: DOUBLE9_TILES,
    ids: Object.freeze(DOUBLE9_TILES.map((t) => t.id)),
    count: DOUBLE9_TILES.length,
    handSize: 10,
    blankId: DOUBLE9_FIRST_ID,
    highDoubleId: MAX_TILE_ID,
  }),
});

/** Backwards-compatible public API: the classic set. Use `tilesFor(rules)` for the active set. */
export const ALL_TILES: Tile[] = DOUBLE6_TILES as Tile[];

/** Legacy constants: both remain valid for the default (double-six) set. */
export const DOUBLE_SIX_ID = TILE_SETS.double6.highDoubleId;
export const DOUBLE_BLANK_ID = TILE_SETS.double6.blankId;

/** Fast global lookups by id (both sets). */
export const TILE_BY_ID: readonly Tile[] = (() => {
  const a = new Array<Tile>(MAX_TILE_ID + 1);
  for (const t of [...DOUBLE6_TILES, ...DOUBLE9_TILES]) a[t.id] = t;
  return Object.freeze(a);
})();

export const TILE_A = new Int8Array(MAX_TILE_ID + 1);
export const TILE_B = new Int8Array(MAX_TILE_ID + 1);
for (const t of [...DOUBLE6_TILES, ...DOUBLE9_TILES]) {
  TILE_A[t.id] = t.a;
  TILE_B[t.id] = t.b;
}

/** Read the tile set from a rule record, a match, a set name, or a tile id. Missing/invalid = double6. */
export function tileSetOf(src: unknown): TileSet {
  if (src === 'double9') return 'double9';
  if (src === 'double6' || src === undefined || src === null) return 'double6';
  if (typeof src === 'number') return src >= DOUBLE9_FIRST_ID ? 'double9' : 'double6';
  if (typeof src === 'object') {
    const o = src as { tileSet?: unknown; rules?: { tileSet?: unknown } };
    const v = o.tileSet ?? o.rules?.tileSet;
    if (v === 'double9' || v === 'double6') return v;
  }
  return 'double6';
}

export const tilesFor = (src: unknown): readonly Tile[] => TILE_SETS[tileSetOf(src)].tiles;
export const tileIdsFor = (src: unknown): readonly number[] => TILE_SETS[tileSetOf(src)].ids;
export const tileById = (_src: unknown, id: number): Tile => TILE_BY_ID[id];
export const tilesPerPip = (src: unknown): number => TILE_SETS[tileSetOf(src)].maxPip + 1;
export const highestDoubleId = (src: unknown): number => TILE_SETS[tileSetOf(src)].highDoubleId;
export const blankTileId = (src: unknown): number => TILE_SETS[tileSetOf(src)].blankId;

/** Tiles dealt to each hand. Kept as a helper so the rule can evolve without touching callers. */
export function handSizeFor(_src: unknown, _mode?: GameMode): number {
  // Both bases use the same hand size for a given set: 7 (double-six) or 10 (Cuban double-nine).
  // Individual mode puts the rest in the pozo.
  return TILE_SETS[tileSetOf(_src)].handSize;
}

/** True when this rule record selects the double-nine set. */
export const isDouble9 = (rules: RuleSettings | undefined): boolean => tileSetOf(rules) === 'double9';

export const pipsOf = (t: Tile): number => t.a + t.b;
export const isDouble = (t: Tile): boolean => t.a === t.b;
export const hasPip = (t: Tile, p: number): boolean => t.a === p || t.b === p;
export const handPips = (h: readonly Tile[]): number => h.reduce((s, t) => s + t.a + t.b, 0);
