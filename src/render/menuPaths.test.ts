import { describe, expect, it } from 'vitest';
import {
  ALL_SHAPES,
  DOM_D,
  LOW_SHAPES,
  MAX_TURN,
  TH,
  TL,
  buildDominoLayout,
  checkLayout,
  fallenRect,
  newObb,
  obbGap,
  rectGap,
  seeded,
  standingRect,
  tileObb,
} from './menuPaths';

describe('domino paths', () => {
  for (const shape of ALL_SHAPES) {
    for (const [n, maxN] of [
      [14, 16],
      [20, 28],
      [26, 28],
    ] as const) {
      it(`${shape}, ~${n} tiles (max ${maxN}): every tile reaches its neighbour, no overlaps`, () => {
        let built = 0;
        for (let seed = 1; seed <= 25; seed++) {
          const lay = buildDominoLayout(shape, n, maxN, seeded(seed));
          if (!lay) continue;
          built++;
          const c = checkLayout(lay);
          const total = lay.lines.reduce((a, l) => a + l.x.length, 0);
          expect(total).toBeLessThanOrEqual(maxN);
          expect(c.conflicts).toBe(0);
          expect(c.minStanding).toBeGreaterThanOrEqual(0.05);
          // the gap between faces is well under a tile length: the falling tile's top hits the next tile
          expect(c.maxReach).toBeLessThan(0.85);
          // ... on its face, not beside it
          expect(c.maxSide).toBeLessThan(0.8);
          expect(c.maxTurn).toBeLessThanOrEqual(MAX_TURN + 0.02);
          // consecutive tiles exactly one spacing apart
          for (const l of lay.lines)
            for (let i = 0; i + 1 < l.x.length; i++) expect(Math.hypot(l.x[i + 1] - l.x[i], l.y[i + 1] - l.y[i])).toBeCloseTo(DOM_D, 3);
          // standing footprints pairwise apart; fallen footprints only ever meet the next / previous tile
          const all = lay.lines.flatMap((l, li) => l.x.map((x, i) => ({ li, i, x, y: l.y[i], h: l.h[i] })));
          for (let a = 0; a < all.length; a++)
            for (let b = a + 1; b < all.length; b++) {
              const A = all[a];
              const B = all[b];
              expect(rectGap(standingRect(A.x, A.y, A.h), standingRect(B.x, B.y, B.h))).toBeGreaterThan(0.04);
              if (A.li === B.li && Math.abs(A.i - B.i) <= 1) continue;
              expect(rectGap(fallenRect(A.x, A.y, A.h), fallenRect(B.x, B.y, B.h))).toBeGreaterThan(0);
            }
        }
        // the simple shapes always build; heart / KU / spiral need enough tiles
        if (LOW_SHAPES.includes(shape) || maxN >= 28) expect(built).toBeGreaterThan(15);
      });
    }
  }

  it('the neighbour gap is less than a tile length (a toppling tile always reaches)', () => {
    expect(DOM_D - TH).toBeLessThan(TL * 0.8);
  });
});

describe('oriented boxes', () => {
  it('detects separation and overlap', () => {
    const a = tileObb(newObb(), 0, 0, 0, 0, 0, 0, 1, 1);
    const b = tileObb(newObb(), TL + 0.1, 0, 0, 0, 0, 0, 1, 1);
    expect(obbGap(a, b)).toBeCloseTo(0.1, 5);
    const c = tileObb(newObb(), TL - 0.1, 0, 0, 0, 0, 0, 1, 1);
    expect(obbGap(a, c)).toBeLessThan(0);
    // rotated 45° about Y, corner toward the other box
    const s = Math.sin(Math.PI / 8);
    const d = tileObb(newObb(), 2.2, 0, 0, 0, s, 0, Math.cos(Math.PI / 8), 1);
    expect(obbGap(a, d)).toBeLessThan(0.3);
  });
});
