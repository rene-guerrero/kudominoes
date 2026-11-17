import { describe, expect, it } from 'vitest';
import { engine, RULE_SETTINGS, DEFAULT_RULES, ALL_TILES, normalizeRules } from './index';
import { CAPICUA_DOUBLE_BEFORE_ROUNDING, capicuaDoubleTotal, resolveHandCore, roundPoints, toScoreRules } from './scoring';
import { matchTarget, migrateRules, readRules, RULE_PRESETS, RULES_VERSION, sameRules, scoreUnit } from './rules';
import type { RuleSettings } from '../contracts';

describe('tiles', () => {
  it('has 28 unique ordered tiles', () => {
    expect(ALL_TILES).toHaveLength(28);
    ALL_TILES.forEach((t, i) => {
      expect(t.id).toBe(i);
      expect(t.a).toBeLessThanOrEqual(t.b);
    });
    expect(ALL_TILES[0]).toMatchObject({ a: 0, b: 0 });
    expect(ALL_TILES[1]).toMatchObject({ a: 0, b: 1 });
    expect(ALL_TILES[27]).toMatchObject({ a: 6, b: 6 });
    expect(new Set(ALL_TILES.map((t) => `${t.a}-${t.b}`)).size).toBe(28);
  });
});

describe('settings', () => {
  it('descriptors are well-formed and bilingual', () => {
    const keys = new Set<string>();
    for (const d of RULE_SETTINGS) {
      expect(keys.has(d.key)).toBe(false);
      keys.add(d.key);
      expect(d.label.es && d.label.en).toBeTruthy();
      if (d.type === 'select') {
        expect(d.options!.length).toBeGreaterThan(1);
        expect(d.options!.some((o) => o.value === d.default)).toBe(true);
        for (const o of d.options!) expect(o.label.es && o.label.en).toBeTruthy();
      } else {
        expect(typeof d.default).toBe('boolean');
      }
      expect(DEFAULT_RULES[d.key]).toBe(d.default);
    }
    expect(engine.RULE_SETTINGS).toBe(RULE_SETTINGS);
  });

  it('normalizes missing and invalid values to defaults', () => {
    const r = normalizeRules({ target: 15, scoring: 'bogus', capicua: 2, extra: 1 });
    expect(r.target).toBe(15);
    expect(r.scoring).toBe(DEFAULT_RULES.scoring);
    expect(r.capicua).toBe(2);
    expect(r.extra).toBeUndefined();
    expect(Object.keys(r).sort()).toEqual(Object.keys(DEFAULT_RULES).sort());
    // old raw-pip values are not valid any more
    expect(normalizeRules({ target: 100, capicua: 25 })).toMatchObject({ target: 20, capicua: 'double' });
  });

  it('cuban defaults (tens scale)', () => {
    expect(DEFAULT_RULES).toMatchObject({
      target: 20,
      rounding: 'up',
      firstStarter: 'double6',
      nextStarter: 'winnerTeam',
      scoring: 'all',
      tranqueWinner: 'lowestPlayer',
      tranqueTie: 'mano',
      abajo: true,
      capicua: 'double',
      paseSalida: 2,
      paseSalidaNoWin: true,
      paseCorrido: 0,
      chuchazo: 0,
      pollona: 'off',
    });
    expect(RULE_PRESETS[0]).toMatchObject({ id: 'cubano' });
    expect(sameRules(RULE_PRESETS[0].rules, DEFAULT_RULES)).toBe(true);
    expect(sameRules({ ...DEFAULT_RULES, target: 30 }, DEFAULT_RULES)).toBe(false);
  });

  it('rule groups are the four collapsible groups', () => {
    expect([...new Set(RULE_SETTINGS.map((d) => d.group))]).toEqual(['salida', 'puntuacion', 'tranque', 'bonos']);
  });

  it('effective target follows the scale', () => {
    expect(matchTarget(DEFAULT_RULES)).toBe(20);
    expect(matchTarget({ ...DEFAULT_RULES, rounding: 'none' })).toBe(200);
    expect(matchTarget({ ...DEFAULT_RULES, target: 15, rounding: 'nearest' })).toBe(15);
    expect(scoreUnit({ rounding: 'none' })).toBe(10);
    expect(scoreUnit({ rounding: 'down' })).toBe(1);
  });

  it('migrates schema-1 rules: structure kept, points scale reset', () => {
    const old = { target: 200, capicua: 25, paseSalida: 10, scoring: 'opponents', tranqueWinner: 'blockerRisk', nextStarter: 'winner' };
    const m = migrateRules(old, undefined);
    expect(m).toMatchObject({ target: 20, capicua: 'double', paseSalida: 2, rounding: 'up', scoring: 'opponents', tranqueWinner: 'blockerRisk', nextStarter: 'winner' });
    // an old default was never chosen: it takes the new Cuban default
    expect(migrateRules({ nextStarter: 'rotate', target: 100 }, 1).nextStarter).toBe('winnerTeam');
    expect(migrateRules({ nextStarter: 'rotate' }, 2).nextStarter).toBe('winnerTeam');
    // already current: kept as is
    expect(migrateRules({ ...DEFAULT_RULES, target: 30 }, RULES_VERSION).target).toBe(30);
  });

  it('migrates schema-3 rules: the old Cubano clásico moves to the new one, custom sets keep their choices', () => {
    expect(RULES_VERSION).toBe(4);
    // the old preset as stored by v3 (no abajo key, void tie): never changed → new defaults
    const { abajo: _a, ...v3 }: RuleSettings = { ...DEFAULT_RULES, tranqueTie: 'void' };
    void _a;
    const m = migrateRules(v3, 3);
    expect(sameRules(m, DEFAULT_RULES)).toBe(true);
    expect(m).toMatchObject({ tranqueTie: 'mano', abajo: true });
    // customised (Personalizado): every stored choice stays, including the void tie; abajo gets its default
    const c = migrateRules({ ...v3, target: 30 }, 3);
    expect(c).toMatchObject({ target: 30, tranqueTie: 'void', abajo: true });
    expect(migrateRules({ ...v3, tranqueTie: 'blockerLoses' }, 3).tranqueTie).toBe('blockerLoses');
    // schema 1/2: the old default void tie was never chosen → la mano
    expect(migrateRules({ tranqueTie: 'void' }, 2).tranqueTie).toBe('mano');
    expect(migrateRules({ tranqueTie: 'blockerLoses' }, 2).tranqueTie).toBe('blockerLoses');
  });
});

describe('rounding to tens', () => {
  const cases: [number, Record<string, number>][] = [
    [0, { up: 0, nearest: 0, down: 0, none: 0 }],
    [1, { up: 1, nearest: 0, down: 0, none: 1 }],
    [10, { up: 1, nearest: 1, down: 1, none: 10 }],
    [31, { up: 4, nearest: 3, down: 3, none: 31 }],
    [60, { up: 6, nearest: 6, down: 6, none: 60 }],
    [64, { up: 7, nearest: 6, down: 6, none: 64 }],
    [65, { up: 7, nearest: 7, down: 6, none: 65 }],
    [69, { up: 7, nearest: 7, down: 6, none: 69 }],
    [5, { up: 1, nearest: 1, down: 0, none: 5 }],
  ];
  for (const [pips, exp] of cases) {
    it(`${pips} pips`, () => {
      for (const mode of ['up', 'nearest', 'down', 'none'] as const) expect(roundPoints(pips, mode)).toBe(exp[mode]);
    });
  }

  it('capicúa ×2: round first, then double', () => {
    expect(CAPICUA_DOUBLE_BEFORE_ROUNDING).toBe(false);
    expect(capicuaDoubleTotal(65, 0)).toBe(14);
    expect(capicuaDoubleTotal(31, 0)).toBe(8);
    expect(capicuaDoubleTotal(64, 1)).toBe(12);
    expect(capicuaDoubleTotal(65, 3)).toBe(130);
  });
});

function resolve(rules: Record<string, string | number>, blocked: boolean, pips: number[], last: number, starter = 0) {
  const sr = toScoreRules(readRules({ ...DEFAULT_RULES, ...rules }));
  const r = resolveHandCore(sr, blocked, pips, last, starter);
  return { seat: (r & 7) - 1, points: r >> 3 };
}

describe('hand resolution (scoring core)', () => {
  it('domino: all pips vs opponents only', () => {
    expect(resolve({ scoring: 'all' }, false, [0, 10, 5, 7], 0)).toEqual({ seat: 0, points: 22 });
    expect(resolve({ scoring: 'opponents' }, false, [0, 10, 5, 7], 0)).toEqual({ seat: 0, points: 17 });
    expect(resolve({ scoring: 'opponents' }, false, [4, 0, 5, 7], 1)).toEqual({ seat: 1, points: 9 });
  });

  it('tranque lowestPlayer', () => {
    expect(resolve({ tranqueWinner: 'lowestPlayer' }, true, [9, 3, 20, 8], 0)).toEqual({ seat: 1, points: 40 });
    // partners tied at minimum -> still their team; earlier in play order from starter wins seat
    expect(resolve({ tranqueWinner: 'lowestPlayer' }, true, [3, 9, 3, 8], 1, 1)).toEqual({ seat: 2, points: 23 });
  });

  it('tranque lowestTeam', () => {
    // seat 1 is lowest individually but team 0 total (2+20=22) < team 1 (1+25=26)
    expect(resolve({ tranqueWinner: 'lowestTeam' }, true, [2, 1, 20, 25], 0)).toEqual({ seat: 0, points: 48 });
    expect(resolve({ tranqueWinner: 'lowestPlayer' }, true, [2, 1, 20, 25], 0)).toEqual({ seat: 1, points: 48 });
  });

  it('tranque blockerRisk', () => {
    expect(resolve({ tranqueWinner: 'blockerRisk' }, true, [5, 6, 30, 9], 0)).toEqual({ seat: 0, points: 50 });
    // blocker 0 has 7 but opponent seat 3 has 6 -> opponents win, even though partner has 1
    expect(resolve({ tranqueWinner: 'blockerRisk' }, true, [7, 10, 1, 6], 0)).toEqual({ seat: 3, points: 24 });
  });

  it('tranque tie variants', () => {
    const pips = [5, 5, 10, 12];
    expect(resolve({ tranqueTie: 'void' }, true, pips, 2)).toEqual({ seat: -1, points: 0 });
    expect(resolve({ tranqueTie: 'blockerLoses' }, true, pips, 2)).toEqual({ seat: 1, points: 32 });
    expect(resolve({ tranqueTie: 'blockerLoses' }, true, pips, 1)).toEqual({ seat: 0, points: 32 });
    expect(resolve({ tranqueTie: 'mano' }, true, pips, 2, 3)).toEqual({ seat: 1, points: 32 });
    expect(resolve({ tranqueTie: 'mano' }, true, pips, 2, 2)).toEqual({ seat: 0, points: 32 });
    // team-total tie
    expect(resolve({ tranqueWinner: 'lowestTeam', tranqueTie: 'void' }, true, [4, 6, 10, 8], 0).seat).toBe(-1);
    expect(resolve({ tranqueWinner: 'lowestTeam', tranqueTie: 'mano' }, true, [4, 6, 10, 8], 0, 1).seat).toBe(1);
    // blockerRisk tie
    expect(resolve({ tranqueWinner: 'blockerRisk', tranqueTie: 'void' }, true, [6, 6, 1, 9], 0).seat).toBe(-1);
    expect(resolve({ tranqueWinner: 'blockerRisk', tranqueTie: 'blockerLoses' }, true, [6, 6, 1, 9], 0).seat).toBe(1);
  });

  it('tranque scoring: same vs losers only', () => {
    expect(resolve({ tranqueScoring: 'same' }, true, [2, 10, 5, 7], 0).points).toBe(24);
    expect(resolve({ tranqueScoring: 'opponents' }, true, [2, 10, 5, 7], 0).points).toBe(17);
    expect(resolve({ scoring: 'opponents', tranqueScoring: 'same' }, true, [2, 10, 5, 7], 0).points).toBe(17);
  });
});
