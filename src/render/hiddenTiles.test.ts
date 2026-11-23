import { describe, expect, it } from 'vitest';
import { pickSwap, resolvePlaceholders, swapIds } from './hiddenTiles';

describe('hidden tiles (online renderer path)', () => {
  it('local games: real ids are untouched and nothing is unknown', () => {
    const hands = [
      [0, 1, 2],
      [3, 4, 5],
    ];
    const pile = [6, 7];
    const unknown = new Array<boolean>(28).fill(true);
    resolvePlaceholders([...hands, pile], [], unknown);
    expect(hands).toEqual([
      [0, 1, 2],
      [3, 4, 5],
    ]);
    expect(pile).toEqual([6, 7]);
    expect(unknown.every((u) => !u)).toBe(true);
  });

  it('placeholders borrow ids that are nowhere else (my hand, the chain)', () => {
    const mine = [27, 20, 13];
    const other = [-1, -1, -1];
    const pile = [-1, -1];
    const unknown = new Array<boolean>(28).fill(false);
    resolvePlaceholders([mine, other, pile], [0, 1], unknown);
    const all = [...mine, ...other, ...pile];
    expect(new Set(all).size).toBe(all.length);
    for (const id of [...other, ...pile]) {
      expect(id).toBeGreaterThanOrEqual(0);
      expect([27, 20, 13, 0, 1]).not.toContain(id);
      expect(unknown[id]).toBe(true);
    }
    for (const id of mine) expect(unknown[id]).toBe(false);
  });

  it('an opponent plays a tile that sits elsewhere: it trades places with one of their hidden tiles', () => {
    const unknown = new Array<boolean>(28).fill(false);
    const hands = [[27], [-1, -1], [-1, -1]];
    resolvePlaceholders(hands, [], unknown);
    const seat2Tile = hands[2][0];
    // seat 1 plays the tile currently standing in for one of seat 2's
    const y = pickSwap(seat2Tile, hands[1], unknown, false);
    expect(hands[1]).toContain(y);
    swapIds(seat2Tile, y, hands);
    expect(hands[1]).toContain(seat2Tile);
    expect(hands[2]).toContain(y);
    expect(hands[0]).toEqual([27]);
  });

  it('a tile already in the right hand needs no swap', () => {
    const unknown = new Array<boolean>(28).fill(false);
    unknown[5] = unknown[6] = true;
    expect(pickSwap(5, [5, 6], unknown, false)).toBe(-1);
  });

  it('my draw comes from the top of the pile', () => {
    const unknown = new Array<boolean>(28).fill(false);
    const pile = [-1, -1, -1];
    const other = [-1, -1];
    resolvePlaceholders([[0], other, pile], [], unknown);
    const drawn = other[0]; // the real tile happens to stand in another hand
    const y = pickSwap(drawn, pile, unknown, true);
    expect(y).toBe(pile[pile.length - 1]);
    swapIds(drawn, y, [other, pile]);
    expect(pile[pile.length - 1]).toBe(drawn);
  });

  it('a hand end keeps revealed tiles in place (keep list)', () => {
    const unknown = new Array<boolean>(28).fill(true);
    const hand = [4, 9, 11];
    unknown[4] = false; // already claimed
    expect(pickSwap(12, hand, unknown, false, [4, 12])).toBe(11);
  });

  it('explicit global ids (double-nine): placeholders borrow only active ids and mark their global index', () => {
    const ids = Array.from({ length: 55 }, (_, i) => 28 + i);
    const mine = [28, 40, 82];
    const other = [-1, -1, -1];
    const pile = [-1, -1];
    const unknown = new Array<boolean>(83).fill(false);
    resolvePlaceholders([mine, other, pile], [0, 1], unknown, ids);
    const all = [...mine, ...other, ...pile];
    expect(new Set(all).size).toBe(all.length);
    for (const id of [...other, ...pile]) {
      expect(id).toBeGreaterThanOrEqual(28);
      expect(id).toBeLessThanOrEqual(82);
      expect(unknown[id]).toBe(true);
    }
    for (const id of mine) expect(unknown[id]).toBe(false);
    // ids outside the active set are never borrowed, even when known elsewhere
    expect(unknown[0]).toBe(false);
    expect(pile).not.toContain(0);
  });
});
