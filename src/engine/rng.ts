/** mulberry32 — tiny, fast, deterministic PRNG. State is a single uint32-ish number. */

export function mulberry32Step(state: number): { value: number; state: number } {
  const s = (state + 0x6d2b79f5) | 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, state: s };
}

/** Mutable wrapper for local use inside a pure function (copy the state in, read it back out). */
export class Rng {
  s: number;
  constructor(seed: number) {
    this.s = seed | 0;
  }
  next(): number {
    const s = (this.s + 0x6d2b79f5) | 0;
    this.s = s;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
}

/** Mix a few integers into a 32-bit seed (for deterministic AI randomness). */
export function hashSeed(...xs: number[]): number {
  let h = 0x811c9dc5 | 0;
  for (const x of xs) {
    h ^= x | 0;
    h = Math.imul(h, 0x01000193);
    h ^= h >>> 13;
  }
  return h | 0;
}
