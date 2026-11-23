/**
 * Online play: tiles the player may not see (other hands, the boneyard) arrive as placeholders
 * (id < 0). The view still animates the tiles of the active set, so each placeholder borrows the id
 * of a tile whose whereabouts are unknown (shown face down, so which one it is never shows). When a
 * real tile is revealed somewhere it is not (an opponent plays it, the player draws it, a hand end shows
 * it), it trades places with one of the hidden tiles there: both are face down, so nothing visible
 * moves. Local games never have placeholders; then none of this does anything.
 *
 * Pure helpers on the view's id arrays (index = global tile id), unit-tested in hiddenTiles.test.ts.
 */

/**
 * Replace every placeholder in `lists` with an id that appears nowhere else (in `lists` or `known`).
 * Marks the borrowed ids in `unknown` (and clears it for every real id). Mutates the lists in place.
 *
 * `idsOrTotal` is either the number of ids in the classic 0..N-1 space (old behaviour, used by the
 * unit tests) or the explicit list of global ids in the active set, e.g. `TILE_SETS.double9.ids`
 * (28..82). In both cases `unknown` is indexed by the global id, so ids borrowed for double-nine
 * are marked at their real index.
 */
export function resolvePlaceholders(
  lists: number[][],
  known: readonly number[],
  unknown: boolean[],
  idsOrTotal: readonly number[] | number = 28,
): void {
  const ids: readonly number[] =
    typeof idsOrTotal === 'number' ? Array.from({ length: idsOrTotal }, (_, i) => i) : idsOrTotal;
  const used = new Set<number>();
  for (const id of known) if (id >= 0) used.add(id);
  for (const l of lists) for (const id of l) if (id >= 0) used.add(id);
  for (let i = 0; i < unknown.length; i++) unknown[i] = false;
  let next = 0;
  const borrow = (): number => {
    while (next < ids.length && used.has(ids[next])) next++;
    if (next >= ids.length) return -1;
    const id = ids[next++];
    used.add(id);
    unknown[id] = true;
    return id;
  };
  for (const l of lists)
    for (let i = 0; i < l.length; i++) {
      if (l[i] >= 0) continue;
      const id = borrow();
      if (id < 0) {
        l.splice(i--, 1); // more placeholders than tiles: drop (never happens with a consistent server)
        continue;
      }
      l[i] = id;
    }
}

/**
 * Which hidden tile should trade places with real tile `id` so that `id` ends up in `dest`
 * (a seat's hand, or the boneyard pile)? -1 = nothing to do (already there) or no candidate.
 * Pile: the top of the pile (drawn from the end). Hand: the last hidden tile not in `keep`.
 */
export function pickSwap(id: number, dest: readonly number[], unknown: readonly boolean[], fromEnd: boolean, keep?: readonly number[]): number {
  if (id < 0) return -1;
  const at = dest.indexOf(id);
  if (at >= 0 && (!fromEnd || at === dest.length - 1)) return -1;
  for (let i = dest.length - 1; i >= 0; i--) {
    const y = dest[i];
    if (y === id || !unknown[y] || (keep && keep.includes(y))) continue;
    return y;
  }
  return -1;
}

/** swap ids `x` and `y` everywhere they appear */
export function swapIds(x: number, y: number, lists: readonly number[][]): void {
  for (const l of lists)
    for (let i = 0; i < l.length; i++) {
      if (l[i] === x) l[i] = y;
      else if (l[i] === y) l[i] = x;
    }
}
