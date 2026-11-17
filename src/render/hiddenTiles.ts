/**
 * Online play: tiles the player may not see (other hands, the boneyard) arrive as placeholders
 * (id < 0). The view still animates 28 real tile objects, so each placeholder borrows the id of a
 * tile whose whereabouts are unknown (shown face down, so which one it is never shows). When a real
 * tile is revealed somewhere it is not (an opponent plays it, the player draws it, a hand end shows
 * it), it trades places with one of the hidden tiles there: both are face down, so nothing visible
 * moves. Local games never have placeholders; then none of this does anything.
 *
 * Pure helpers on the view's id arrays (index = tile id), unit-tested in hiddenTiles.test.ts.
 */

/**
 * Replace every placeholder in `lists` with an id that appears nowhere else (in `lists` or `known`).
 * Marks the borrowed ids in `unknown` (and clears it for every real id). Mutates the lists in place.
 */
export function resolvePlaceholders(lists: number[][], known: readonly number[], unknown: boolean[], total = 28): void {
  const used = new Array<boolean>(total).fill(false);
  for (const id of known) if (id >= 0 && id < total) used[id] = true;
  for (const l of lists) for (const id of l) if (id >= 0 && id < total) used[id] = true;
  for (let i = 0; i < total; i++) unknown[i] = false;
  let next = 0;
  for (const l of lists)
    for (let i = 0; i < l.length; i++) {
      if (l[i] >= 0) continue;
      while (next < total && used[next]) next++;
      if (next >= total) {
        l.splice(i--, 1); // more placeholders than tiles: drop (never happens with a consistent server)
        continue;
      }
      used[next] = true;
      unknown[next] = true;
      l[i] = next++;
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
