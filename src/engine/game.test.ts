import { describe, expect, it } from 'vitest';
import type { GameEvent, MatchState } from '../contracts';
import { ALL_TILES, DEFAULT_RULES } from './index';
import { applyMove, createMatch, legalMoves, pass, play, scenario, startHand, tid } from './testutil';
import { chooseStarter, cpuStarter, starterPreference } from './game';

/** exact pips (old behaviour): handy for checking raw arithmetic */
const RAW = { rounding: 'none' };

const ev = <T extends GameEvent['type']>(events: GameEvent[], type: T) =>
  events.find((e) => e.type === type) as Extract<GameEvent, { type: T }> | undefined;

/** The 15 tiles that are neither 0-x nor 1-x: used to build tranque scenarios. */
const REST = ALL_TILES.filter((t) => t.a >= 2).map((t) => t.id);
/** chain with every 0-x (except 0-1) and every 1-x (except 0-1) on the table */
const BLOCK_CHAIN = ALL_TILES.filter((t) => (t.a === 0 || t.a === 1) && t.id !== tid(0, 1)).map((t) => t.id);

describe('dealing', () => {
  it('deals 4 hands of 7 distinct tiles covering the set', () => {
    const { match, events } = startHand(createMatch(DEFAULT_RULES, 42));
    const h = match.hand!;
    expect(h.hands.map((x) => x.length)).toEqual([7, 7, 7, 7]);
    const ids = h.hands.flat().map((t) => t.id).sort((a, b) => a - b);
    expect(ids).toEqual([...Array(28).keys()]);
    expect(events[0]).toMatchObject({ type: 'handStart', handNo: 1, starter: h.starter });
    expect(h.chain).toEqual([]);
    expect(h.ends).toBeNull();
  });

  it('is reproducible from the seed and changes with it', () => {
    const a = startHand(createMatch(DEFAULT_RULES, 7)).match.hand!.hands;
    const b = startHand(createMatch(DEFAULT_RULES, 7)).match.hand!.hands;
    const c = startHand(createMatch(DEFAULT_RULES, 8)).match.hand!.hands;
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('does not mutate the input state', () => {
    const m0 = createMatch(DEFAULT_RULES, 3);
    const snap = JSON.stringify(m0);
    const { match } = startHand(m0);
    expect(JSON.stringify(m0)).toBe(snap);
    const snap2 = JSON.stringify(match);
    applyMove(match, legalMoves(match)[0]);
    expect(JSON.stringify(match)).toBe(snap2);
  });

  it('reshuffles hands with five doubles when enabled', () => {
    for (let seed = 0; seed < 400; seed++) {
      const h = startHand(createMatch({ ...DEFAULT_RULES, redealFiveDoubles: true }, seed)).match.hand!;
      for (const hand of h.hands) expect(hand.filter((t) => t.a === t.b).length).toBeLessThan(5);
    }
  });
});

describe('opening (first hand)', () => {
  it('double6: holder of 6-6 opens and must lead it', () => {
    for (let seed = 0; seed < 20; seed++) {
      const m = startHand(createMatch({ ...DEFAULT_RULES, firstStarter: 'double6' }, seed)).match;
      const h = m.hand!;
      expect(h.hands[h.starter].some((t) => t.id === 27)).toBe(true);
      expect(h.turn).toBe(h.starter);
      expect(legalMoves(m)).toEqual([{ kind: 'play', seat: h.starter, tileId: 27, side: 'right' }]);
    }
  });

  it('double6Free: holder of 6-6 opens with any tile', () => {
    const m = startHand(createMatch({ ...DEFAULT_RULES, firstStarter: 'double6Free' }, 5)).match;
    const h = m.hand!;
    expect(h.hands[h.starter].some((t) => t.id === 27)).toBe(true);
    expect(legalMoves(m)).toHaveLength(7);
  });

  it('random: any seat may open, reproducibly', () => {
    const starters = new Set<number>();
    for (let seed = 0; seed < 40; seed++) {
      const m = startHand(createMatch({ ...DEFAULT_RULES, firstStarter: 'random' }, seed)).match;
      starters.add(m.hand!.starter);
      expect(legalMoves(m)).toHaveLength(7);
      expect(startHand(createMatch({ ...DEFAULT_RULES, firstStarter: 'random' }, seed)).match.hand!.starter).toBe(m.hand!.starter);
    }
    expect(starters.size).toBe(4);
  });

  it('first tile sets both ends', () => {
    const m = startHand(createMatch(DEFAULT_RULES, 11)).match;
    const { match, events } = applyMove(m, legalMoves(m)[0]);
    expect(match.hand!.ends).toEqual({ left: 6, right: 6 });
    const p = ev(events, 'play')!;
    expect(p.isFirst).toBe(true);
    expect(p.placed).toMatchObject({ side: 'right', outer: 6 });
    expect(p.tilesLeft).toBe(6);
    expect(match.hand!.turn).toBe((m.hand!.starter + 1) % 4);
  });
});

describe('legality', () => {
  const base = () =>
    scenario({
      hands: [[tid(3, 5), tid(2, 2), tid(5, 6)], [tid(1, 1)], [tid(4, 4)], [tid(0, 0)]],
      chain: [tid(3, 4), tid(4, 5)],
      ends: { left: 3, right: 5 },
      turn: 0,
    });

  it('lists every tile/side that fits', () => {
    const moves = legalMoves(base());
    expect(moves).toContainEqual({ kind: 'play', seat: 0, tileId: tid(3, 5), side: 'left' });
    expect(moves).toContainEqual({ kind: 'play', seat: 0, tileId: tid(3, 5), side: 'right' });
    expect(moves).toContainEqual({ kind: 'play', seat: 0, tileId: tid(5, 6), side: 'right' });
    expect(moves).toHaveLength(3);
  });

  it('orients the tile on the chosen end', () => {
    const { match, events } = play(base(), 5, 6, 'right');
    expect(match.hand!.ends).toEqual({ left: 3, right: 6 });
    expect(ev(events, 'play')!.placed.outer).toBe(6);
    const r2 = play(base(), 3, 5, 'left');
    expect(r2.match.hand!.ends).toEqual({ left: 5, right: 5 });
  });

  it('rejects illegal moves and wrong seats', () => {
    expect(() => play(base(), 2, 2)).toThrow();
    expect(() => applyMove(base(), { kind: 'pass', seat: 0 })).toThrow();
    expect(() => applyMove(base(), { kind: 'play', seat: 1, tileId: tid(1, 1), side: 'left' })).toThrow();
    expect(() => applyMove(base(), { kind: 'play', seat: 0, tileId: tid(5, 6), side: 'left' })).toThrow();
  });

  it('a seat that cannot play gets exactly one pass, which is recorded publicly', () => {
    const m = scenario({
      hands: [[tid(2, 2)], [tid(1, 1)], [tid(4, 4)], [tid(0, 0)]],
      chain: [tid(3, 5)],
      ends: { left: 3, right: 5 },
      turn: 0,
      passedOn: [[5], [], [], []],
    });
    expect(legalMoves(m)).toEqual([{ kind: 'pass', seat: 0 }]);
    const { match, events } = pass(m);
    expect(match.hand!.passedOn[0]).toEqual([3, 5]);
    expect(match.hand!.passesInRow).toBe(1);
    expect(match.hand!.turn).toBe(1);
    expect(events).toEqual([{ type: 'pass', seat: 0, ends: { left: 3, right: 5 } }]);
  });
});

describe('domino (se pegó)', () => {
  const dominoScenario = (rules = {}) =>
    scenario({
      // plain arithmetic: small wins on 0 would go abajo (tested in its own block)
      rules: { capicua: 0, abajo: false, ...rules },
      hands: [[tid(3, 5)], [tid(6, 6), tid(1, 2)], [tid(4, 4)], [tid(0, 1)]],
      chain: [tid(3, 4)],
      ends: { left: 3, right: 5 },
      turn: 0,
    });

  it('scores all pips (exact pips with rounding none)', () => {
    const { match, events } = play(dominoScenario(RAW), 3, 5, 'left');
    const e = ev(events, 'handEnd')!;
    expect(e).toMatchObject({ reason: 'domino', winnerSeat: 0, winnerTeam: 0, points: 12 + 3 + 8 + 1, bonuses: [], rawPips: 24, rounding: 'none' });
    expect(e.pipCounts).toEqual([0, 15, 8, 1]);
    expect(e.remaining[1].map((t) => t.id)).toEqual([tid(6, 6), tid(1, 2)]);
    expect(match.scores).toEqual([24, 0]);
    expect(match.handsWon).toEqual([1, 0]);
    expect(match.hand!.over).toBe(true);
    expect(match.lastHandWinner).toBe(0);
    expect(legalMoves(match)).toEqual([]);
  });

  it('default: pips rounded up to the ten and counted in tens (24 → 30 → 3)', () => {
    const { match, events } = play(dominoScenario(), 3, 5, 'left');
    expect(ev(events, 'handEnd')).toMatchObject({ points: 3, rawPips: 24, rounding: 'up' });
    expect(match.scores).toEqual([3, 0]);
  });

  it('every rounding mode on a domino', () => {
    // 24 pips: up 3, nearest 2, down 2, none 24
    const exp = { up: 3, nearest: 2, down: 2, none: 24 } as const;
    for (const [rounding, pts] of Object.entries(exp)) {
      expect(play(dominoScenario({ rounding }), 3, 5, 'left').match.scores).toEqual([pts, 0]);
    }
  });

  it('opponents-only scoring', () => {
    const { match } = play(dominoScenario({ ...RAW, scoring: 'opponents' }), 3, 5, 'left');
    expect(match.scores).toEqual([16, 0]);
    expect(play(dominoScenario({ scoring: 'opponents' }), 3, 5, 'left').match.scores).toEqual([2, 0]);
  });
});

describe('bonuses', () => {
  // seat 0 goes out with 3-5 on ends 3|5 (capicúa); remaining 6-6, 4-4, 0-1 = 21 pips
  const capScenario = (rules = {}, scores: [number, number] = [0, 0]) =>
    scenario({
      rules,
      scores,
      hands: [[tid(3, 5)], [tid(6, 6)], [tid(4, 4)], [tid(0, 1)]],
      chain: [tid(3, 4)],
      ends: { left: 3, right: 5 },
      turn: 0,
    });

  it('capicúa ×2 by default: round first, then double (21 → 3, ×2 = 6)', () => {
    const e = ev(play(capScenario(), 3, 5, 'right').events, 'handEnd')!;
    expect(e).toMatchObject({ points: 3, rawPips: 21 });
    expect(e.bonuses).toEqual([expect.objectContaining({ id: 'capicua', points: 3, team: 0, kind: 'double' })]);
    expect(e.scores).toEqual([6, 0]);
  });

  it('capicúa ×2 with every rounding mode', () => {
    // 21 pips: up 3 → 6, nearest 2 → 4, down 2 → 4, none 21 → 42
    const exp = { up: 6, nearest: 4, down: 4, none: 42 } as const;
    for (const [rounding, total] of Object.entries(exp)) {
      expect(ev(play(capScenario({ rounding }), 3, 5, 'right').events, 'handEnd')!.scores).toEqual([total, 0]);
    }
  });

  it('capicúa ×2 on 65 pips gives 14', () => {
    // the others hold 6-6, 5-6, 5-5, 4-6, 4-4, 1-6, 2-5 = 65 pips
    const m65 = scenario({
      hands: [[tid(3, 5)], [tid(6, 6), tid(5, 6), tid(5, 5)], [tid(4, 6), tid(4, 4)], [tid(1, 6), tid(2, 5)]],
      chain: [tid(3, 4)],
      ends: { left: 3, right: 5 },
      turn: 0,
    });
    const e65 = ev(play(m65, 3, 5, 'left').events, 'handEnd')!;
    expect(e65.rawPips).toBe(65);
    expect(e65.points).toBe(7);
    expect(e65.scores).toEqual([14, 0]);
  });

  it('capicúa fixed bonus is on the tens scale (×10 without rounding)', () => {
    const e = ev(play(capScenario({ capicua: 2 }), 3, 5, 'right').events, 'handEnd')!;
    expect(e.bonuses).toEqual([expect.objectContaining({ id: 'capicua', points: 2, team: 0 })]);
    expect(e.scores).toEqual([3 + 2, 0]);
    const raw = ev(play(capScenario({ capicua: 2, ...RAW }), 3, 5, 'right').events, 'handEnd')!;
    expect(raw.scores).toEqual([21 + 20, 0]);
  });

  it('capicúa off, and not capicúa if only one end fits', () => {
    expect(ev(play(capScenario({ capicua: 0 }), 3, 5, 'right').events, 'handEnd')!.bonuses).toEqual([]);
    const m2 = scenario({
      hands: [[tid(5, 6)], [tid(6, 6)], [tid(4, 4)], [tid(0, 1)]],
      chain: [tid(3, 4)],
      ends: { left: 3, right: 5 },
      turn: 0,
    });
    expect(ev(play(m2, 5, 6, 'right').events, 'handEnd')!.bonuses).toEqual([]);
  });

  it('chuchazo: going out with the double blank (tens scale)', () => {
    const m = scenario({
      rules: { chuchazo: 3 },
      hands: [[tid(1, 1)], [tid(0, 0)], [tid(4, 4)], [tid(2, 6)]],
      chain: [tid(0, 3)],
      ends: { left: 0, right: 3 },
      turn: 1,
    });
    const e = ev(play(m, 0, 0, 'left').events, 'handEnd')!;
    expect(e.winnerTeam).toBe(1);
    expect(e.bonuses).toEqual([expect.objectContaining({ id: 'chuchazo', points: 3, team: 1 })]);
    // 2 + 8 + 8 = 18 pips → 2 points, + 3
    expect(e.scores).toEqual([0, 5]);
  });

  // opening: seat 0 leads 6-6, seat 1 has no 6 and passes
  const openScenario = (rules = {}, scores: [number, number] = [0, 0], starter: 0 | 1 = 0) =>
    scenario({
      rules: { abajo: false, ...rules },
      scores,
      hands:
        starter === 0
          ? [[tid(6, 6), tid(1, 1)], [tid(0, 0), tid(2, 3)], [tid(5, 6), tid(0, 2)], [tid(4, 6), tid(0, 1)]]
          : [[tid(4, 6), tid(0, 1)], [tid(6, 6), tid(1, 1)], [tid(0, 0), tid(2, 3)], [tid(5, 6), tid(0, 2)]],
      ends: null,
      turn: starter,
      starter,
      handNo: 2,
    });

  it('pase de salida: 2 points credited immediately to the opening team', () => {
    let r = play(openScenario(), 6, 6);
    r = pass(r.match); // seat 1 has no 6
    const p = ev(r.events, 'pass')!;
    expect(p.bonus).toEqual(expect.objectContaining({ id: 'pase-salida', team: 0, points: 2 }));
    expect(p.scores).toEqual([2, 0]);
    expect(r.match.scores).toEqual([2, 0]);
    expect(r.match.over).toBe(false);
    r = play(r.match, 5, 6, 'right'); // partner: ends 6|5
    r = play(r.match, 4, 6, 'left'); // seat 3: ends 4|5
    r = pass(r.match); // seat 0 (1-1) passes later: no second bonus
    expect(ev(r.events, 'pass')!.bonus).toBeUndefined();
    expect(r.match.scores).toEqual([2, 0]);
  });

  it('pase de salida for the other team, and ×10 without rounding', () => {
    let r = play(openScenario({}, [0, 0], 1), 6, 6);
    r = pass(r.match); // seat 2 has no 6
    expect(r.match.scores).toEqual([0, 2]);
    let q = play(openScenario(RAW), 6, 6);
    q = pass(q.match);
    expect(q.match.scores).toEqual([20, 0]);
  });

  it('pase de salida is listed as an early bonus at hand end and not paid twice', () => {
    const m = scenario({
      rules: { abajo: false },
      hands: [[tid(6, 6), tid(1, 1)], [tid(0, 0)], [tid(5, 6), tid(2, 2)], [tid(4, 6)]],
      ends: null,
      turn: 0,
      starter: 0,
      handNo: 2,
    });
    let r = play(m, 6, 6);
    r = pass(r.match);
    r = play(r.match, 5, 6, 'right');
    r = play(r.match, 4, 6, 'left'); // seat 3 goes out: 1-1, 0-0, 2-2 = 6 pips → 1
    const e = ev(r.events, 'handEnd')!;
    expect(e.winnerTeam).toBe(1);
    expect(e.bonuses).toEqual([]);
    expect(e.earlyBonuses).toEqual([expect.objectContaining({ id: 'pase-salida', team: 0, points: 2 })]);
    expect(e.scores).toEqual([2, 1]);
  });

  it('pase de salida off: nothing', () => {
    let r = play(openScenario({ paseSalida: 0 }), 6, 6);
    r = pass(r.match);
    expect(ev(r.events, 'pass')!.bonus).toBeUndefined();
    expect(r.match.scores).toEqual([0, 0]);
  });

  it('guard: at 18 or 19 of 20 the opening pass adds nothing', () => {
    for (const s of [18, 19]) {
      let r = play(openScenario({}, [s, 5]), 6, 6);
      r = pass(r.match);
      const p = ev(r.events, 'pass')!;
      expect(p.bonus).toBeUndefined();
      expect(p.bonusBlocked).toEqual(expect.objectContaining({ id: 'pase-salida', points: 2 }));
      expect(r.match.scores).toEqual([s, 5]);
      expect(r.match.over).toBe(false);
    }
  });

  it('guard: at 17 of 20 the opening pass is added (→ 19)', () => {
    let r = play(openScenario({}, [17, 5]), 6, 6);
    r = pass(r.match);
    expect(r.match.scores).toEqual([19, 5]);
    expect(r.match.over).toBe(false);
  });

  it('guard: same rule on the raw scale (180 of 200 blocked, 170 → 190)', () => {
    let r = play(openScenario(RAW, [180, 0]), 6, 6);
    r = pass(r.match);
    expect(r.match.scores).toEqual([180, 0]);
    r = pass(play(openScenario(RAW, [170, 0]), 6, 6).match);
    expect(r.match.scores).toEqual([190, 0]);
  });

  it('guard off: the bonus may reach the target, but the match only ends at the hand end', () => {
    let r = play(openScenario({ paseSalidaNoWin: false }, [19, 5]), 6, 6);
    r = pass(r.match);
    expect(r.match.scores).toEqual([21, 5]);
    expect(r.match.over).toBe(false);
    expect(r.events.map((e) => e.type)).toEqual(['pass']);
    r = play(r.match, 5, 6, 'right');
    expect(r.match.over).toBe(false);
    r = play(r.match, 4, 6, 'left');
    expect(r.match.over).toBe(false);
    while (!r.match.hand!.over) {
      r = applyMove(r.match, legalMoves(r.match)[0]);
      const types = r.events.map((e) => e.type);
      // the match can only end together with a handEnd event
      expect(r.match.over).toBe(types.includes('handEnd'));
    }
    expect(r.events.map((e) => e.type).slice(-2)).toEqual(['handEnd', 'matchEnd']);
  });

  it('pase corrido: three passes in a row return the turn, bonus paid at hand end (tens scale)', () => {
    const m = scenario({
      rules: { paseCorrido: 3, ...RAW },
      hands: [[tid(2, 5), tid(5, 5)], [tid(0, 0)], [tid(1, 1)], [tid(3, 3)]],
      chain: [tid(2, 4)],
      ends: { left: 2, right: 4 },
      turn: 0,
      starter: 0,
    });
    let r = play(m, 2, 5, 'left'); // ends 5,4
    r = pass(r.match);
    r = pass(r.match);
    r = pass(r.match);
    expect(r.match.hand!.turn).toBe(0);
    r = play(r.match, 5, 5, 'left'); // domino
    const e = ev(r.events, 'handEnd')!;
    expect(e.bonuses).toEqual([expect.objectContaining({ id: 'pase-corrido', points: 30, team: 0 })]);
    expect(e.scores[0]).toBe(e.points + 30);
  });

  it('pase corrido is off by default (no bonus for making the other three pass)', () => {
    const m = scenario({
      hands: [[tid(2, 5), tid(5, 5)], [tid(0, 0)], [tid(1, 1)], [tid(3, 3)]],
      chain: [tid(2, 4)],
      ends: { left: 2, right: 4 },
      turn: 0,
      starter: 0,
    });
    let r = play(m, 2, 5, 'left');
    r = pass(pass(pass(r.match).match).match);
    r = play(r.match, 5, 5, 'left');
    expect(ev(r.events, 'handEnd')!.bonuses).toEqual([]);
  });

  it('pollona double: shutout doubles the final score', () => {
    const { match, events } = play(capScenario({ pollona: 'double', target: 10, capicua: 0, ...RAW }, [80, 0]), 3, 5, 'left');
    const end = ev(events, 'matchEnd')!;
    expect(match.over).toBe(true);
    expect(end.winner).toBe(0);
    expect(end.bonuses).toEqual([expect.objectContaining({ id: 'pollona', points: 101 })]);
    expect(match.scores).toEqual([202, 0]);
    // tens scale: 18 + 3 = 21 ≥ 20 → 42
    expect(play(capScenario({ pollona: 'double', capicua: 0 }, [18, 0]), 3, 5, 'left').match.scores).toEqual([42, 0]);
  });

  it('pollona halfTarget: shutout ends the match at half target', () => {
    const a = play(capScenario({ pollona: 'halfTarget', capicua: 0 }, [7, 0]), 3, 5, 'left');
    expect(a.match.scores).toEqual([10, 0]);
    expect(a.match.over).toBe(true);
    expect(ev(a.events, 'matchEnd')).toMatchObject({ winner: 0, bonuses: [expect.objectContaining({ id: 'pollona' })] });
    const b = play(capScenario({ pollona: 'off', capicua: 0 }, [7, 0]), 3, 5, 'left');
    expect(b.match.over).toBe(false);
    expect(ev(b.events, 'matchEnd')).toBeUndefined();
  });
});

describe('tranque (blocked hand)', () => {
  // seat 0 plays 0-1 on the 0 end -> ends 1|1 and every 0 and 1 tile is out.
  const mk = (rules: Record<string, string | number>, hands: number[][], starter = 0) =>
    scenario({
      rules,
      hands,
      chain: BLOCK_CHAIN,
      ends: { left: 0, right: 1 },
      turn: 0,
      starter: starter as 0,
    });
  const t = (a: number, b: number) => tid(a, b);

  it('is detected immediately after the blocking play (lowest player wins)', () => {
    // pips after play: s0: 2-2=4, s1: 2-3=5, s2: 6-6=12, s3: 2-4=6
    const H = [[t(0, 1), t(2, 2)], [t(2, 3)], [t(6, 6)], [t(2, 4)]];
    const { match, events } = play(mk(RAW, H), 0, 1, 'left');
    const e = ev(events, 'handEnd')!;
    expect(e.reason).toBe('blocked');
    expect(e.winnerSeat).toBe(0);
    expect(e.pipCounts).toEqual([4, 5, 12, 6]);
    expect(e.points).toBe(27);
    expect(match.hand!.over).toBe(true);
  });

  it('cerrado points are rounded like a domino (27 → 30 → 3; nearest 3; down 2)', () => {
    const H = [[t(0, 1), t(2, 2)], [t(2, 3)], [t(6, 6)], [t(2, 4)]];
    expect(ev(play(mk({}, H), 0, 1, 'left').events, 'handEnd')).toMatchObject({ points: 3, rawPips: 27 });
    expect(ev(play(mk({ rounding: 'nearest' }, H), 0, 1, 'left').events, 'handEnd')!.points).toBe(3);
    expect(ev(play(mk({ rounding: 'down' }, H), 0, 1, 'left').events, 'handEnd')!.points).toBe(2);
  });

  it('lowestTeam vs lowestPlayer give different winners', () => {
    const H = [[t(0, 1), t(2, 2)], [t(2, 3)], [t(2, 4)], [t(6, 6)]]; // s0 4, s1 5, s2 6, s3 12
    expect(ev(play(mk({ tranqueWinner: 'lowestPlayer' }, H), 0, 1, 'left').events, 'handEnd')!.winnerSeat).toBe(0);
    const H2 = [[t(0, 1), t(3, 4)], [t(2, 2)], [t(2, 3)], [t(6, 6)]]; // s0 7, s1 4, s2 5, s3 12 -> player: s1; team: 12 vs 16 -> team0
    expect(ev(play(mk({ tranqueWinner: 'lowestPlayer' }, H2), 0, 1, 'left').events, 'handEnd')!.winnerSeat).toBe(1);
    expect(ev(play(mk({ tranqueWinner: 'lowestTeam' }, H2), 0, 1, 'left').events, 'handEnd')!.winnerSeat).toBe(2);
  });

  it('tie variants: void / blocker loses / mano', () => {
    const H = [[t(0, 1), t(2, 4)], [t(3, 3)], [t(5, 6)], [t(6, 6)]]; // s0 6, s1 6, s2 11, s3 12
    const v = play(mk({ tranqueTie: 'void' }, H), 0, 1, 'left');
    const ve = ev(v.events, 'handEnd')!;
    expect(ve).toMatchObject({ winnerSeat: null, winnerTeam: null, points: 0 });
    expect(v.match.scores).toEqual([0, 0]);
    expect(v.match.lastHandWinner).toBeNull();
    expect(ev(play(mk({ tranqueTie: 'blockerLoses' }, H), 0, 1, 'left').events, 'handEnd')!.winnerTeam).toBe(1);
    expect(ev(play(mk({ tranqueTie: 'mano' }, H, 0), 0, 1, 'left').events, 'handEnd')!.winnerTeam).toBe(0);
    expect(ev(play(mk({ tranqueTie: 'mano' }, H, 3), 0, 1, 'left').events, 'handEnd')!.winnerTeam).toBe(1);
  });

  it('blockerRisk: blocker must be strictly lower than both opponents', () => {
    const H = [[t(0, 1), t(3, 4)], [t(2, 2)], [t(2, 3)], [t(6, 6)]]; // s0 7, s1 4
    expect(ev(play(mk({ tranqueWinner: 'blockerRisk' }, H), 0, 1, 'left').events, 'handEnd')!.winnerSeat).toBe(1);
    const H2 = [[t(0, 1), t(2, 2)], [t(2, 4)], [t(2, 3)], [t(6, 6)]]; // s0 4, s1 6, s3 12
    expect(ev(play(mk({ tranqueWinner: 'blockerRisk' }, H2), 0, 1, 'left').events, 'handEnd')!.winnerSeat).toBe(0);
  });
});

describe('later hands: who opens', () => {
  const finishedMatch = (rules: Record<string, string | number | boolean>, starter: 0 | 1 | 2 | 3, winner: 0 | 1 | 2 | 3 | null) => {
    const m = createMatch({ ...DEFAULT_RULES, ...rules }, 99);
    const s = scenario({ rules, hands: [[], [], [], []], turn: 0, starter, handNo: 1 });
    return { ...m, hand: { ...s.hand!, over: true }, lastHandWinner: winner } as MatchState;
  };

  it('rotate: next seat after the previous opener', () => {
    const r = startHand(finishedMatch({ nextStarter: 'rotate' }, 3, 1));
    expect(r.match.hand!.starter).toBe(0);
    expect(r.match.hand!.handNo).toBe(2);
    expect(legalMoves(r.match)).toHaveLength(7);
  });

  it('winner: hand winner opens; void repeats opener', () => {
    expect(startHand(finishedMatch({ nextStarter: 'winner' }, 0, 3)).match.hand!.starter).toBe(3);
    expect(startHand(finishedMatch({ nextStarter: 'winner' }, 2, null)).match.hand!.starter).toBe(2);
  });

  it('winnerTeam (default): the winning pair chooses its opener after the deal', () => {
    const r = startHand(finishedMatch({}, 0, 1));
    const h = r.match.hand!;
    expect(h.pendingStarterChoice).toBe(1);
    expect(legalMoves(r.match)).toEqual([]);
    expect(() => applyMove(r.match, { kind: 'play', seat: h.turn, tileId: h.hands[h.turn][0].id, side: 'right' })).toThrow();
    expect(() => chooseStarter(r.match, 0)).toThrow(); // not in the choosing team
    for (const seat of [1, 3] as const) {
      const m = chooseStarter(r.match, seat);
      expect(m.hand!).toMatchObject({ starter: seat, turn: seat, pendingStarterChoice: null });
      expect(legalMoves(m)).toHaveLength(7); // the chosen opener plays any tile
    }
  });

  it('winnerTeam: the human pair can choose either player', () => {
    const r = startHand(finishedMatch({}, 1, 2));
    expect(r.match.hand!.pendingStarterChoice).toBe(0);
    expect(chooseStarter(r.match, 0).hand!.turn).toBe(0);
    expect(chooseStarter(r.match, 2).hand!.turn).toBe(2);
  });

  it('winnerTeam: a CPU pair decides by spoken preference only', () => {
    for (let seed = 0; seed < 40; seed++) {
      const m = startHand({ ...finishedMatch({}, 0, 3), rng: seed }).match;
      const s = cpuStarter(m);
      expect([1, 3]).toContain(s);
      const w3 = starterPreference(m, 3);
      const w1 = starterPreference(m, 1);
      // the partner opens only if it wants to and the hand winner does not
      expect(s).toBe(w1 && !w3 ? 1 : 3);
    }
  });

  it('winnerTeam: first hand keeps its own rule; a void hand repeats the opener without a choice', () => {
    const first = startHand(createMatch(DEFAULT_RULES, 5)).match.hand!;
    expect(first.pendingStarterChoice ?? null).toBeNull();
    expect(first.hands[first.starter].some((t) => t.id === 27)).toBe(true);
    const v = startHand(finishedMatch({}, 2, null)).match.hand!;
    expect(v.pendingStarterChoice ?? null).toBeNull();
    expect(v.starter).toBe(2);
  });

  it('other nextStarter options never ask for a choice', () => {
    for (const nextStarter of ['rotate', 'winner', 'double6']) {
      expect(startHand(finishedMatch({ nextStarter }, 0, 1)).match.hand!.pendingStarterChoice ?? null).toBeNull();
    }
  });

  it('double6 every hand', () => {
    const r = startHand(finishedMatch({ nextStarter: 'double6' }, 0, 1));
    const h = r.match.hand!;
    expect(h.hands[h.starter].some((t) => t.id === 27)).toBe(true);
    expect(legalMoves(r.match)).toEqual([{ kind: 'play', seat: h.starter, tileId: 27, side: 'right' }]);
  });
});

describe('match end', () => {
  it('ends when a team reaches the target and refuses further hands', () => {
    const m = scenario({
      rules: { target: 10, capicua: 0, ...RAW },
      scores: [80, 95],
      hands: [[tid(3, 5)], [tid(6, 6)], [tid(4, 4)], [tid(0, 1)]],
      chain: [tid(3, 4)],
      ends: { left: 3, right: 5 },
      turn: 0,
    });
    const { match, events } = play(m, 3, 5, 'left');
    expect(events.map((e) => e.type)).toEqual(['play', 'handEnd', 'matchEnd']);
    expect(match.over).toBe(true);
    expect(match.winner).toBe(0);
    expect(match.scores).toEqual([101, 95]);
    expect(() => startHand(match)).toThrow();
    expect(legalMoves(match)).toEqual([]);
  });

  it('default match to 20 on the tens scale: reached by a hand end', () => {
    const mk = (scores: [number, number]) =>
      scenario({
        scores,
        rules: { capicua: 0 },
        hands: [[tid(3, 5)], [tid(6, 6)], [tid(4, 4)], [tid(0, 1)]],
        chain: [tid(3, 4)],
        ends: { left: 3, right: 5 },
        turn: 0,
      });
    // 21 pips → 3 points
    const a = play(mk([16, 10]), 3, 5, 'left');
    expect(a.match.scores).toEqual([19, 10]);
    expect(a.match.over).toBe(false);
    const b = play(mk([17, 10]), 3, 5, 'left');
    expect(b.match.scores).toEqual([20, 10]);
    expect(b.match.over).toBe(true);
    expect(b.events.map((e) => e.type)).toEqual(['play', 'handEnd', 'matchEnd']);
  });

  it('startHand refuses while a hand is in progress', () => {
    const m = startHand(createMatch(DEFAULT_RULES, 1)).match;
    expect(() => startHand(m)).toThrow();
  });
});

describe('puntos abajo', () => {
  // seat 0 goes out with 3-5 on the 3 end; the other seats keep `rest` (their pips decide the hand)
  const out = (rest: number[][], o: { rules?: Record<string, string | number | boolean>; scores?: [number, number]; pot?: number; capicua?: boolean } = {}) => {
    const m = scenario({
      rules: o.rules,
      scores: o.scores,
      hands: [[tid(3, 5)], ...rest],
      chain: [tid(3, 4)],
      ends: { left: 3, right: o.capicua ? 5 : 6 },
      turn: 0,
    });
    return play({ ...m, abajo: o.pot ?? 0 }, 3, 5, 'left');
  };
  // remaining pips: 20 = 6-6 + 4-4 + 0-0; 21 = 6-6 + 4-4 + 0-1; 15 = 6-6 + 1-2 + 0-0; 6 = 1-1 + 2-2 + 0-0
  const P20 = [[tid(6, 6)], [tid(4, 4)], [tid(0, 0)]];
  const P21 = [[tid(6, 6)], [tid(4, 4)], [tid(0, 1)]];
  const P15 = [[tid(6, 6)], [tid(1, 2)], [tid(0, 0)]];
  const P6 = [[tid(1, 1)], [tid(2, 2)], [tid(0, 0)]];

  it('is on by default in Cubano clásico', () => {
    expect(DEFAULT_RULES.abajo).toBe(true);
    expect(createMatch(DEFAULT_RULES, 1).abajo).toBe(0);
  });

  it('a small win of a team on 0 goes to the pot (exactly 20 pips = 2 points is abajo)', () => {
    const { match, events } = out(P20);
    const e = ev(events, 'handEnd')!;
    expect(e).toMatchObject({ winnerTeam: 0, points: 2, abajoAdded: 2, abajoPot: 2 });
    expect(e.abajoClaimed).toBeUndefined();
    expect(e.scores).toEqual([0, 0]);
    expect(match.scores).toEqual([0, 0]);
    expect(match.abajo).toBe(2);
    expect(match.handsWon).toEqual([1, 0]);
    expect(match.lastHandWinner).toBe(0);
  });

  it('the pot keeps growing with repeated small wins of teams on 0', () => {
    expect(out(P6, { pot: 2 }).match).toMatchObject({ scores: [0, 0], abajo: 3 });
    expect(out(P20, { pot: 7, scores: [0, 4] }).match).toMatchObject({ scores: [0, 4], abajo: 9 });
  });

  it('a win of 3 or more claims the whole pot, even for a team on 0', () => {
    const { match, events } = out(P21, { pot: 4, scores: [0, 5] });
    expect(ev(events, 'handEnd')).toMatchObject({ points: 3, abajoClaimed: 4, abajoPot: 0 });
    expect(ev(events, 'handEnd')!.abajoAdded).toBeUndefined();
    expect(match.scores).toEqual([7, 5]);
    expect(match.abajo).toBe(0);
  });

  it('a small win of a team that already has points scores normally and claims the pot', () => {
    const { match, events } = out(P6, { pot: 4, scores: [5, 0] });
    expect(ev(events, 'handEnd')).toMatchObject({ points: 1, abajoClaimed: 4, abajoPot: 0 });
    expect(match.scores).toEqual([10, 0]);
  });

  it('capicúa is applied first: 15 pips → 2, ×2 = 4 is not abajo (and claims the pot)', () => {
    const { match, events } = out(P15, { capicua: true, pot: 2 });
    const e = ev(events, 'handEnd')!;
    expect(e.points).toBe(2);
    expect(e.bonuses).toEqual([expect.objectContaining({ id: 'capicua', kind: 'double', points: 2 })]);
    expect(e.bonuses[0].abajo).toBeUndefined();
    expect(e).toMatchObject({ abajoClaimed: 2, abajoPot: 0 });
    expect(match.scores).toEqual([6, 0]);
  });

  it('capicúa that stays small (6 pips → 1, ×2 = 2) goes abajo with its bonus flagged', () => {
    const { match, events } = out(P6, { capicua: true });
    const e = ev(events, 'handEnd')!;
    expect(e.abajoAdded).toBe(2);
    expect(e.bonuses).toEqual([expect.objectContaining({ id: 'capicua', abajo: true })]);
    expect(match).toMatchObject({ scores: [0, 0], abajo: 2 });
  });

  it('claiming the pot can win the match', () => {
    const { match, events } = out(P21, { pot: 4, scores: [15, 3] });
    expect(match.scores).toEqual([22, 3]);
    expect(match.over).toBe(true);
    expect(match.winner).toBe(0);
    expect(match.abajo).toBe(0);
    expect(events.map((x) => x.type)).toEqual(['play', 'handEnd', 'matchEnd']);
  });

  it('a void hand leaves the pot unchanged', () => {
    const H = [[tid(0, 1), tid(2, 4)], [tid(3, 3)], [tid(5, 6)], [tid(6, 6)]]; // s0 6, s1 6: tie
    const m = scenario({ rules: { tranqueTie: 'void' }, hands: H, chain: BLOCK_CHAIN, ends: { left: 0, right: 1 }, turn: 0 });
    const { match, events } = play({ ...m, abajo: 5 }, 0, 1, 'left');
    expect(ev(events, 'handEnd')).toMatchObject({ winnerTeam: null, abajoPot: 5 });
    expect(match).toMatchObject({ scores: [0, 0], abajo: 5 });
  });

  it('opening pass of a team on 0 goes to the pot (guard irrelevant); a team with points scores it and never claims', () => {
    const open = (scores: [number, number], pot: number) => {
      const m = scenario({
        scores,
        hands: [[tid(6, 6), tid(1, 1)], [tid(0, 0), tid(2, 3)], [tid(5, 6), tid(0, 2)], [tid(4, 6), tid(0, 1)]],
        ends: null,
        turn: 0,
        starter: 0,
        handNo: 2,
      });
      return pass(play({ ...m, abajo: pot }, 6, 6).match);
    };
    const a = open([0, 7], 3);
    const p = ev(a.events, 'pass')!;
    expect(p.bonus).toBeUndefined();
    expect(p.bonusAbajo).toEqual(expect.objectContaining({ id: 'pase-salida', points: 2, team: 0, abajo: true }));
    expect(p.abajoPot).toBe(5);
    expect(a.match).toMatchObject({ scores: [0, 7], abajo: 5 });
    expect((a.match.hand as { earlyBonuses?: unknown[] }).earlyBonuses).toEqual([expect.objectContaining({ abajo: true })]);
    const b = open([4, 0], 3);
    expect(ev(b.events, 'pass')!.bonus).toEqual(expect.objectContaining({ points: 2 }));
    expect(b.match).toMatchObject({ scores: [6, 0], abajo: 3 });
    // the guard still applies to a team with points
    const c = open([18, 0], 3);
    expect(ev(c.events, 'pass')!.bonusBlocked).toBeTruthy();
    expect(c.match).toMatchObject({ scores: [18, 0], abajo: 3 });
  });

  it('a held opening pass is listed at hand end, and a small win of a team on 0 also goes abajo', () => {
    const m = scenario({
      hands: [[tid(6, 6), tid(1, 1)], [tid(0, 0)], [tid(5, 6), tid(2, 2)], [tid(4, 6)]],
      ends: null,
      turn: 0,
      starter: 0,
      handNo: 2,
    });
    let r = pass(play(m, 6, 6).match); // pase de salida for team 0 (on 0) → pot 2
    r = play(r.match, 5, 6, 'right');
    r = play(r.match, 4, 6, 'left'); // seat 3 (team 1, on 0) goes out: 6 pips → 1 → abajo
    const e = ev(r.events, 'handEnd')!;
    expect(e).toMatchObject({ winnerTeam: 1, abajoAdded: 1, abajoPot: 3 });
    expect(e.earlyBonuses).toEqual([expect.objectContaining({ id: 'pase-salida', abajo: true })]);
    expect(r.match).toMatchObject({ scores: [0, 0], abajo: 3 });
  });

  it('tied cerrado goes to la mano by default and scores (and claims) like any hand', () => {
    expect(DEFAULT_RULES.tranqueTie).toBe('mano');
    const H = [[tid(0, 1), tid(2, 4)], [tid(3, 3)], [tid(5, 6)], [tid(6, 6)]]; // s0 6, s1 6: tie; 35 pips → 4
    const mk = (starter: 0 | 3, scores: [number, number], pot: number) =>
      play({ ...scenario({ hands: H, chain: BLOCK_CHAIN, ends: { left: 0, right: 1 }, turn: 0, starter, scores }), abajo: pot }, 0, 1, 'left');
    const a = mk(3, [0, 0], 2);
    expect(ev(a.events, 'handEnd')).toMatchObject({ reason: 'blocked', winnerTeam: 1, points: 4, abajoClaimed: 2 });
    expect(a.match.scores).toEqual([0, 6]);
    const b = mk(0, [3, 0], 0);
    expect(ev(b.events, 'handEnd')!.winnerTeam).toBe(0);
    expect(b.match.scores).toEqual([7, 0]);
  });

  it('setting off: the old behaviour, no pot', () => {
    const { match, events } = out(P20, { rules: { abajo: false } });
    const e = ev(events, 'handEnd')!;
    expect(match.scores).toEqual([2, 0]);
    expect(e.abajoAdded).toBeUndefined();
    expect(e.abajoPot).toBeUndefined();
  });

  it('rounding none: the threshold is ×10 (≤ 20 pips abajo, 21 claims)', () => {
    const a = out(P20, { rules: RAW });
    expect(a.match).toMatchObject({ scores: [0, 0], abajo: 20 });
    const b = out(P21, { rules: RAW, pot: 20 });
    expect(b.match).toMatchObject({ scores: [41, 0], abajo: 0 });
  });

  it('old states without a pot field behave as an empty pot', () => {
    const m = scenario({ hands: [[tid(3, 5)], ...P21], chain: [tid(3, 4)], ends: { left: 3, right: 6 }, turn: 0 });
    delete (m as { abajo?: number }).abajo;
    const r = play(m, 3, 5, 'left');
    expect(r.match).toMatchObject({ scores: [3, 0], abajo: 0 });
    expect(ev(r.events, 'handEnd')!.abajoClaimed).toBeUndefined();
  });
});

void REST;
