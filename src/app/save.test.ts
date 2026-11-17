import { beforeEach, describe, expect, it } from 'vitest';
import { createMatch, legalMoves, startHand } from '../engine/game';
import { DEFAULT_RULES, DEFAULT_RULES_INDIVIDUAL } from '../engine/rules';
import { DEFAULT_LINEUP } from '../roster';
import { loadSave, saveGame, saveSummary } from './save';

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

describe('save / resume: puntos abajo', () => {
  beforeEach(() => store.clear());

  it('keeps the abajo pot', () => {
    const m = { ...startHand(createMatch(DEFAULT_RULES, 5)).match, abajo: 6 };
    saveGame(m, [], { ...DEFAULT_LINEUP });
    const s = loadSave()!;
    expect(s.match.abajo).toBe(6);
    expect(s.match.rules.abajo).toBe(true);
  });

  it('an old save (no pot, rules without abajo) resumes with an empty pot and the rule off', () => {
    const m = startHand(createMatch(DEFAULT_RULES, 5)).match;
    const { abajo: _r, ...oldRules } = m.rules;
    void _r;
    const old = { ...m, rules: oldRules } as typeof m;
    delete old.abajo;
    saveGame(old, [], { ...DEFAULT_LINEUP });
    const s = loadSave()!;
    expect(s.match.abajo).toBe(0);
    expect(s.match.rules.abajo).toBe(false);
  });
});

describe('save / resume: individual mode', () => {
  beforeEach(() => store.clear());

  it('keeps mode, seats, per-seat scores and the boneyard; the rules get no abajo', () => {
    const m0 = createMatch(DEFAULT_RULES_INDIVIDUAL, 9, { mode: 'individual', players: 3 });
    const m = { ...startHand(m0).match, seatScores: [3, 0, 0, 7] };
    saveGame(m, [], { ...DEFAULT_LINEUP });
    const s = loadSave()!;
    expect(s.match.mode).toBe('individual');
    expect(s.match.seats).toEqual([0, 1, 3]);
    expect(s.match.seatScores).toEqual([3, 0, 0, 7]);
    expect(s.match.hand!.boneyard).toHaveLength(7);
    expect('abajo' in s.match.rules).toBe(false);
    expect(saveSummary(s)).toEqual({ hand: 1, us: 3, them: 7 });
    // it plays on from the saved state
    expect(legalMoves(s.match).length).toBeGreaterThan(0);
  });

  it('an old save (no mode) is a pairs match', () => {
    const m = startHand(createMatch(DEFAULT_RULES, 5)).match;
    saveGame(m, [], { ...DEFAULT_LINEUP });
    const s = loadSave()!;
    expect(s.match.mode).toBeUndefined();
    expect(s.match.seats).toBeUndefined();
    expect(saveSummary(s)).toEqual({ hand: 1, us: 0, them: 0 });
  });

  it('a broken individual save is dropped', () => {
    const m = { ...startHand(createMatch(DEFAULT_RULES_INDIVIDUAL, 9, { mode: 'individual', players: 2 })).match, seatScores: undefined };
    saveGame(m, [], { ...DEFAULT_LINEUP });
    expect(loadSave()).toBeNull();
  });
});
