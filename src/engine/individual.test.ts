import { describe, expect, it } from 'vitest';
import type { Difficulty, GameEvent, MatchState, Move, Pip, PlacedTile, RuleSettings, Seat } from '../contracts';
import { chooseMove } from './ai';
import { applyMove, createMatch, legalMoves, startHand, type EngineHand } from './game';
import { DEFAULT_RULES_INDIVIDUAL, normalizeRules, RULE_SETTINGS_INDIVIDUAL } from './rules';
import { tid } from './testutil';
import { ALL_TILES, DOUBLE_SIX_ID, tileById, tileSetOf } from './tiles';

const R = DEFAULT_RULES_INDIVIDUAL;
const solo = (players: 2 | 3 | 4, rules: RuleSettings = {}, seed = 1) => createMatch({ ...R, ...rules }, seed, { mode: 'individual', players });

interface SoloScenario {
  players: 2 | 3 | 4;
  rules?: RuleSettings;
  hands: number[][];
  boneyard?: number[];
  chain?: number[];
  chainSeats?: Seat[];
  ends?: { left: Pip; right: Pip } | null;
  turn: Seat;
  starter?: Seat;
  seatScores?: number[];
  handNo?: number;
}

/** an arbitrary individual mid-hand state */
function soloScenario(s: SoloScenario): MatchState {
  const m = solo(s.players, s.rules);
  const set = tileSetOf(s.rules ?? m.rules);
  const at = (id: number) => tileById(set, id);
  const chain: PlacedTile[] = (s.chain ?? []).map((id, i) => ({
    tile: at(id),
    seat: s.chainSeats?.[i] ?? s.starter ?? 0,
    side: 'right',
    outer: at(id).b,
  }));
  const hand: EngineHand = {
    handNo: s.handNo ?? 2,
    hands: s.hands.map((h) => h.map(at)),
    chain,
    ends: s.ends === undefined ? null : s.ends,
    turn: s.turn,
    starter: s.starter ?? 0,
    passesInRow: 0,
    passedOn: [[], [], [], []],
    over: false,
    pendingBonuses: [],
    openTile: null,
    ...(s.boneyard ? { boneyard: s.boneyard.map(at) } : {}),
  };
  return { ...m, hand, seatScores: s.seatScores ?? [0, 0, 0, 0] };
}

const play = (m: MatchState, a: number, b: number, side: 'left' | 'right' = 'right') =>
  applyMove(m, { kind: 'play', seat: m.hand!.turn, tileId: tid(a, b, tileSetOf(m.rules)), side });
const handEnd = (evs: GameEvent[]) => evs.find((e) => e.type === 'handEnd') as Extract<GameEvent, { type: 'handEnd' }> | undefined;

describe('individual: setup and deal', () => {
  it('rules: own descriptors, no abajo / pase de los tres / blanqueo', () => {
    const keys = RULE_SETTINGS_INDIVIDUAL.map((d) => d.key);
    expect(keys).toEqual(expect.arrayContaining(['boneyardDraw', 'target', 'rounding', 'soloTie', 'capicua', 'paseSalida', 'paseSalidaNoWin']));
    for (const k of ['abajo', 'paseCorrido', 'pollona', 'tranqueTie', 'nextStarter']) expect(keys).not.toContain(k);
    expect(R).toMatchObject({ boneyardDraw: true, target: 20, rounding: 'up', soloTie: 'mano', capicua: 'double', paseSalida: 2, paseSalidaNoWin: true });
    expect(normalizeRules({ abajo: true, target: 30 }, 'individual')).toEqual({ ...R, target: 30 });
  });

  it.each([
    [2, [0, 2], 14],
    [3, [0, 1, 3], 7],
    [4, [0, 1, 2, 3], 0],
  ] as const)('%i players: 7 tiles each on seats %j, boneyard of %i', (n, seats, pile) => {
    for (let seed = 1; seed <= 30; seed++) {
      const m = startHand(solo(n, {}, seed)).match;
      expect(m.seats).toEqual(seats);
      const h = m.hand!;
      for (let s = 0; s < 4; s++) expect(h.hands[s]).toHaveLength((seats as readonly number[]).includes(s) ? 7 : 0);
      expect(h.boneyard?.length ?? 0).toBe(pile);
      const ids = [...h.hands.flat(), ...(h.boneyard ?? [])].map((t) => t.id);
      expect(new Set(ids).size).toBe(28);
      expect(m.scores).toEqual([0, 0]);
      expect(m.seatScores).toEqual([0, 0, 0, 0]);
      expect(h.pendingStarterChoice ?? null).toBeNull();
    }
  });

  it('handStart carries the seats and the boneyard', () => {
    const r = startHand(solo(3));
    const ev = r.events[0] as Extract<GameEvent, { type: 'handStart' }>;
    expect(ev.seats).toEqual([0, 1, 3]);
    expect(ev.boneyard).toHaveLength(7);
  });

  it.each([
    [2, [0, 2], 35],
    [3, [0, 1, 3], 25],
    [4, [0, 1, 2, 3], 15],
  ] as const)('double-nine: %i players deal 10 each, boneyard of %i', (n, seats, pile) => {
    for (let seed = 1; seed <= 20; seed++) {
      const m = startHand(solo(n, { tileSet: 'double9' }, seed)).match;
      const h = m.hand!;
      for (let s = 0; s < 4; s++) expect(h.hands[s]).toHaveLength((seats as readonly number[]).includes(s) ? 10 : 0);
      expect(h.boneyard?.length ?? 0).toBe(pile);
      const ids = [...h.hands.flat(), ...(h.boneyard ?? [])].map((t) => t.id);
      expect(new Set(ids).size).toBe(55);
      expect(ids.every((id) => id >= 28)).toBe(true);
    }
  });
});

describe('individual: opener', () => {
  it('first hand: the double six opens (and must be led)', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const m = startHand(solo(4, {}, seed)).match;
      const h = m.hand!;
      expect(h.hands[h.starter].some((t) => t.id === DOUBLE_SIX_ID)).toBe(true);
      expect(legalMoves(m)).toEqual([{ kind: 'play', seat: h.starter, tileId: DOUBLE_SIX_ID, side: 'right' }]);
    }
  });

  it('double-nine: the highest double actually dealt opens (9-9 when present)', () => {
    let sawNoNine = 0;
    for (let seed = 1; seed <= 80; seed++) {
      const m = startHand(solo(2, { tileSet: 'double9' }, seed)).match;
      const h = m.hand!;
      const dealt = h.hands.flat();
      const doubles = dealt.filter((t) => t.a === t.b).sort((x, y) => y.a - x.a);
      const best = doubles[0] ?? dealt.slice().sort((x, y) => y.a + y.b - (x.a + x.b) || y.b - x.b)[0];
      const legal = legalMoves(m);
      expect(legal).toHaveLength(1);
      expect((legal[0] as Extract<Move, { kind: 'play' }>).tileId).toBe(best.id);
      expect(h.hands[h.starter].some((t) => t.id === best.id)).toBe(true);
      if (!dealt.some((t) => t.a === 9 && t.b === 9)) sawNoNine++;
    }
    expect(sawNoNine).toBeGreaterThan(0);
  });

  it('2–3 players without the double six dealt: the highest double opens; no doubles: the highest tile', () => {
    let sawNoSix = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const m = startHand(solo(2, {}, seed)).match;
      const h = m.hand!;
      const dealt = h.hands.flat();
      const legal = legalMoves(m);
      expect(legal).toHaveLength(1);
      const lead = ALL_TILES[(legal[0] as Extract<Move, { kind: 'play' }>).tileId];
      const doubles = dealt.filter((t) => t.a === t.b).sort((x, y) => y.a - x.a);
      if (doubles.length) expect(lead).toEqual(doubles[0]);
      else {
        const best = dealt.slice().sort((x, y) => y.a + y.b - (x.a + x.b) || y.b - x.b)[0];
        expect(lead).toEqual(best);
      }
      if (!dealt.some((t) => t.id === DOUBLE_SIX_ID)) sawNoSix++;
      expect(h.hands[h.starter].some((t) => t.id === lead.id)).toBe(true);
    }
    expect(sawNoSix).toBeGreaterThan(20);
  });

  it('later hands: the previous winner opens with any tile', () => {
    let m = soloScenario({ players: 3, hands: [[tid(1, 2)], [tid(5, 5), tid(4, 4)], [], [tid(6, 6), tid(3, 3)]], boneyard: [tid(0, 0)], ends: { left: 2, right: 2 }, chain: [tid(2, 2)], turn: 0 });
    const r = play(m, 1, 2);
    expect(handEnd(r.events)?.winnerSeat).toBe(0);
    m = startHand(r.match).match;
    expect(m.hand!.starter).toBe(0);
    expect(legalMoves(m)).toHaveLength(7);
  });

  it('double-nine later hands: the previous winner opens with any of its 10 tiles', () => {
    const d9 = (a: number, b: number) => tid(a, b, 'double9');
    let m = soloScenario({
      players: 3,
      rules: { tileSet: 'double9' },
      hands: [[d9(1, 2)], [d9(5, 5), d9(4, 4)], [], [d9(6, 6), d9(3, 3)]],
      boneyard: [d9(0, 0)],
      ends: { left: 2, right: 2 },
      chain: [d9(2, 2)],
      turn: 0,
    });
    const r = play(m, 1, 2);
    expect(handEnd(r.events)?.winnerSeat).toBe(0);
    m = startHand(r.match).match;
    expect(m.hand!.starter).toBe(0);
    expect(m.hand!.hands[0]).toHaveLength(10);
    expect(legalMoves(m)).toHaveLength(10);
  });
});

describe('individual: boneyard', () => {
  const base: SoloScenario = {
    players: 2,
    hands: [[tid(1, 1), tid(1, 2)], [], [tid(0, 3), tid(4, 4)], []],
    boneyard: [tid(5, 5), tid(6, 6), tid(3, 6)],
    chain: [tid(5, 6)],
    ends: { left: 5, right: 6 },
    turn: 0,
  };

  it('draw ON: no tile fits → draw, one at a time from the end, the turn stays; a fitting draw must be played', () => {
    let m = soloScenario(base);
    expect(legalMoves(m)).toEqual([{ kind: 'draw', seat: 0 }]);
    let r = applyMove(m, { kind: 'draw', seat: 0 });
    const ev = r.events[0] as Extract<GameEvent, { type: 'draw' }>;
    expect(ev).toMatchObject({ type: 'draw', seat: 0, boneyardLeft: 2 });
    expect(ev.tile.id).toBe(tid(3, 6));
    m = r.match;
    expect(m.hand!.turn).toBe(0);
    expect(m.hand!.hands[0]).toHaveLength(3);
    // 3-6 fits the 6: only that tile may be played (no pass, no further draw)
    const legal = legalMoves(m);
    expect(legal.every((x) => x.kind === 'play' && x.tileId === tid(3, 6))).toBe(true);
    r = applyMove(m, legal[0]);
    expect(r.match.hand!.turn).toBe(2);
    // drawing tells the others the drawer had neither end
    expect(m.hand!.passedOn[0]).toEqual([5, 6]);
  });

  it('draw ON with an empty boneyard → pass', () => {
    const m = soloScenario({ ...base, boneyard: [] });
    expect(legalMoves(m)).toEqual([{ kind: 'pass', seat: 0 }]);
  });

  it('draw OFF: the extra tiles are set aside and whoever cannot play passes', () => {
    const m = soloScenario({ ...base, rules: { boneyardDraw: false } });
    expect(legalMoves(m)).toEqual([{ kind: 'pass', seat: 0 }]);
    const r = applyMove(m, { kind: 'pass', seat: 0 });
    expect(r.match.hand!.boneyard).toHaveLength(3);
    expect(r.match.hand!.turn).toBe(2);
  });

  it('blocked only when the boneyard is empty and nobody can play', () => {
    // seat 2 plays 4-5; nobody holds a 4 or a 6 but the boneyard still has tiles → not blocked
    const s: SoloScenario = {
      players: 2,
      hands: [[tid(1, 1), tid(1, 2)], [], [tid(4, 5), tid(0, 0)], []],
      boneyard: [tid(2, 2), tid(0, 1)],
      chain: [tid(5, 6)],
      ends: { left: 5, right: 6 },
      turn: 2,
    };
    let r = play(soloScenario(s), 4, 5, 'left');
    expect(r.match.hand!.over).toBe(false);
    expect(legalMoves(r.match)).toEqual([{ kind: 'draw', seat: 0 }]);
    r = applyMove(r.match, { kind: 'draw', seat: 0 });
    expect(r.match.hand!.over).toBe(false);
    // the last tile goes and still nobody can play: cerrado right away
    r = applyMove(r.match, { kind: 'draw', seat: 0 });
    const he = handEnd(r.events)!;
    expect(he.reason).toBe('blocked');
    // with draw OFF the same play blocks immediately
    const off = play(soloScenario({ ...s, rules: { boneyardDraw: false } }), 4, 5, 'left');
    expect(handEnd(off.events)?.reason).toBe('blocked');
  });
});

describe('individual: scoring', () => {
  it('domino: the winner scores the pips of ALL other hands, the boneyard does not count (rounded up)', () => {
    const m = soloScenario({
      players: 3,
      hands: [[tid(2, 3)], [tid(6, 6), tid(5, 6)], [], [tid(4, 4), tid(0, 1)]],
      boneyard: [tid(6, 4), tid(5, 5)],
      chain: [tid(3, 3)],
      ends: { left: 3, right: 3 },
      turn: 0,
    });
    const r = play(m, 2, 3);
    const he = handEnd(r.events)!;
    expect(he.winnerSeat).toBe(0);
    expect(he.winnerTeam).toBe(0);
    expect(he.rawPips).toBe(12 + 11 + 8 + 1); // 32, boneyard (10 + 10) excluded
    expect(he.points).toBe(4);
    expect(he.seatScores).toEqual([4, 0, 0, 0]);
    expect(r.match.seatScores).toEqual([4, 0, 0, 0]);
    expect(r.match.scores).toEqual([0, 0]);
    expect(r.match.seatHandsWon).toEqual([1, 0, 0, 0]);
  });

  it('capicúa doubles the hand for the player', () => {
    const m = soloScenario({
      players: 2,
      hands: [[tid(2, 5)], [], [tid(6, 6), tid(4, 6)], []],
      chain: [tid(5, 5), tid(2, 4)],
      ends: { left: 5, right: 2 },
      turn: 0,
    });
    const he = handEnd(play(m, 2, 5).events)!;
    expect(he.points).toBe(3); // 22 → 3
    expect(he.bonuses).toEqual([expect.objectContaining({ id: 'capicua', kind: 'double', points: 3, seat: 0 })]);
    expect(he.seatScores![0]).toBe(6);
  });

  it('no abajo: a small first win of a player on 0 scores normally', () => {
    const m = soloScenario({ players: 2, hands: [[tid(1, 2)], [], [tid(0, 1)], []], chain: [tid(2, 2)], ends: { left: 2, right: 2 }, turn: 0 });
    const r = play(m, 1, 2);
    const he = handEnd(r.events)!;
    expect(he.abajoAdded).toBeUndefined();
    expect(he.abajoPot).toBeUndefined();
    expect(r.match.seatScores![0]).toBe(1);
    expect(r.match.abajo ?? 0).toBe(0);
  });

  it('cerrado: lowest pips wins and scores everyone else’s; a tie goes to the opener (or the first tied after them)', () => {
    // 3 players, draw OFF; seat 3 plays the blocking tile
    const s = (hands: number[][], starter: Seat, rules: RuleSettings = {}) =>
      soloScenario({ players: 3, rules: { boneyardDraw: false, ...rules }, hands, boneyard: [tid(0, 0)], chain: [tid(5, 6)], ends: { left: 5, right: 6 }, turn: 3, starter });
    // 0: 1-2 (3) · 1: 1-1, 0-2 (4) · 3: 1-3 after playing 4-5 → 4 pips; seat 0 lowest
    let he = handEnd(play(s([[tid(1, 2)], [tid(1, 1), tid(0, 2)], [], [tid(4, 5), tid(1, 3)]], 1), 4, 5, 'left').events)!;
    expect(he).toMatchObject({ reason: 'blocked', winnerSeat: 0, rawPips: 8 });
    // tie between 0 and 3 (3 pips each), opener = 1 → order from the opener: 1, 3, 0 → seat 3
    he = handEnd(play(s([[tid(1, 2)], [tid(1, 1), tid(0, 3)], [], [tid(4, 5), tid(0, 3)]], 1), 4, 5, 'left').events)!;
    expect(he.winnerSeat).toBe(3);
    // the same tie with seat 0 as the opener → seat 0
    he = handEnd(play(s([[tid(1, 2)], [tid(1, 1), tid(0, 3)], [], [tid(4, 5), tid(0, 3)]], 0), 4, 5, 'left').events)!;
    expect(he.winnerSeat).toBe(0);
    expect(he.rawPips).toBe(3 + 5);
    // void option
    he = handEnd(play(s([[tid(1, 2)], [tid(1, 1), tid(0, 3)], [], [tid(4, 5), tid(0, 3)]], 0, { soloTie: 'void' }), 4, 5, 'left').events)!;
    expect(he.winnerSeat).toBeNull();
    expect(he.points).toBe(0);
  });

  it('match: first player to the target wins (only at the end of a hand)', () => {
    const m = soloScenario({
      players: 4,
      hands: [[tid(1, 2)], [tid(6, 6), tid(5, 6)], [tid(5, 5)], [tid(4, 4), tid(3, 4)]],
      chain: [tid(2, 2)],
      ends: { left: 2, right: 2 },
      turn: 0,
      seatScores: [15, 18, 0, 0],
    });
    const r = play(m, 1, 2);
    expect(r.match.over).toBe(true);
    expect(r.match.winnerSeat).toBe(0);
    const me = r.events.find((e) => e.type === 'matchEnd') as Extract<GameEvent, { type: 'matchEnd' }>;
    expect(me).toMatchObject({ winnerSeat: 0, winner: 0 });
  });
});

describe('individual: opening pass', () => {
  const s = (over: Partial<SoloScenario> = {}) =>
    soloScenario({ players: 3, hands: [[tid(0, 1)], [tid(1, 1), tid(2, 2)], [], [tid(3, 3), tid(4, 5)]], boneyard: [tid(2, 6), tid(0, 0)], chain: [tid(6, 6)], chainSeats: [3], ends: { left: 6, right: 6 }, turn: 0, starter: 3, ...over });

  it('the next player cannot play the first tile and has to draw: the opener scores at once (only once)', () => {
    let r = applyMove(s(), { kind: 'draw', seat: 0 });
    const ev = r.events[0] as Extract<GameEvent, { type: 'draw' }>;
    expect(ev.bonus).toMatchObject({ id: 'pase-salida', points: 2, seat: 3 });
    expect(r.match.seatScores).toEqual([0, 0, 0, 2]);
    r = applyMove(r.match, { kind: 'draw', seat: 0 });
    expect((r.events[0] as Extract<GameEvent, { type: 'draw' }>).bonus).toBeUndefined();
    expect(r.match.seatScores).toEqual([0, 0, 0, 2]);
  });

  it('with draw OFF it is the plain pass', () => {
    const r = applyMove(s({ rules: { boneyardDraw: false } }), { kind: 'pass', seat: 0 });
    expect((r.events[0] as Extract<GameEvent, { type: 'pass' }>).bonus).toMatchObject({ points: 2, seat: 3 });
  });

  it('the 18/19 guard applies to the player', () => {
    const r = applyMove(s({ seatScores: [0, 0, 0, 18] }), { kind: 'draw', seat: 0 });
    const ev = r.events[0] as Extract<GameEvent, { type: 'draw' }>;
    expect(ev.bonus).toBeUndefined();
    expect(ev.bonusBlocked).toBeTruthy();
    expect(r.match.seatScores![3]).toBe(18);
  });
});

// ───────────────────────── CPU ─────────────────────────

function runMatch(players: 2 | 3 | 4, level: Difficulty, seed: number, rules: RuleSettings = {}): MatchState {
  let m = solo(players, rules, seed);
  const opts = level === 'hard' || level === 'master' ? { timeMs: 4, maxRollouts: 120 } : {};
  for (let hands = 0; hands < 80 && !m.over; hands++) {
    m = startHand(m).match;
    for (let guard = 0; guard < 200 && !m.hand!.over; guard++) {
      const legal = legalMoves(m);
      expect(legal.length).toBeGreaterThan(0);
      const mv = chooseMove(m, level, opts, level === 'normal' ? 'teamPlayer' : undefined);
      expect(legal.some((x) => JSON.stringify(x) === JSON.stringify(mv))).toBe(true);
      m = applyMove(m, mv).match;
      // invariant: every tile is somewhere exactly once
      const h = m.hand!;
      const ids = [...h.hands.flat(), ...h.chain.map((p) => p.tile), ...(h.boneyard ?? [])].map((t) => t.id);
      expect(new Set(ids).size).toBe(28);
      expect(ids).toHaveLength(28);
    }
    expect(m.hand!.over).toBe(true);
  }
  expect(m.over).toBe(true);
  expect(m.winnerSeat).not.toBeNull();
  return m;
}

describe('individual: CPU matches terminate', () => {
  for (const players of [2, 3, 4] as const)
    for (const level of ['easy', 'normal', 'hard', 'master'] as Difficulty[])
      it(`${players} players, ${level}, draw on and off`, { timeout: 120_000 }, () => {
        runMatch(players, level, 11 + players);
        if (players < 4) runMatch(players, level, 23 + players, { boneyardDraw: false });
      });

  it('CPU only uses legitimate information (boneyard and hidden hands do not change its choice)', () => {
    let checked = 0;
    for (let seed = 1; seed <= 40 && checked < 12; seed++) {
      let m = startHand(solo(2, {}, seed)).match;
      for (let k = 0; k < 6 && !m.hand!.over; k++) m = applyMove(m, chooseMove(m, 'normal')).match;
      if (m.hand!.over || m.hand!.turn !== 0 || legalMoves(m).length < 2) continue;
      // swap the opponent's hand with boneyard tiles (same counts): seat 0's decision must not change
      const h = m.hand!;
      const pool = [...h.hands[2], ...(h.boneyard ?? [])];
      const rot = pool.slice(3).concat(pool.slice(0, 3));
      const alt: MatchState = { ...m, hand: { ...h, hands: h.hands.map((x, s) => (s === 2 ? rot.slice(0, h.hands[2].length) : x)), boneyard: rot.slice(h.hands[2].length) } };
      for (const lvl of ['normal', 'hard'] as Difficulty[]) {
        const o = { timeMs: 1e9, maxRollouts: 300 };
        expect(chooseMove(alt, lvl, o)).toEqual(chooseMove(m, lvl, o));
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(3);
  });
});
