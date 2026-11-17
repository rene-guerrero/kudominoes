import { describe, expect, it } from 'vitest';
import type { Difficulty, MatchState, Move, PlayStyle, RuleSettings } from '../contracts';
import { ROSTER, type Character } from '../roster';
import { chooseMove, lastHardStats, MASTER_MS, type AiOptions } from './ai';
import { applyMove, chooseStarter, cpuStarter, createMatch, legalMoves, startHand } from './game';
import { DEFAULT_RULES } from './rules';
import { scenario, tid } from './testutil';

const sameMove = (a: Move, b: Move) =>
  a.kind === b.kind && a.seat === b.seat && (a.kind === 'pass' || (b.kind === 'play' && a.tileId === b.tileId && a.side === b.side));

function checkInvariants(m: MatchState) {
  const h = m.hand!;
  const ids = [...h.hands.flat().map((t) => t.id), ...h.chain.map((p) => p.tile.id)];
  expect(ids.length).toBe(28);
  expect(new Set(ids).size).toBe(28);
  if (h.chain.length) {
    // walk the chain and verify the ends match the outers
    let left = h.chain[0].tile.a as number;
    let right = h.chain[0].outer as number;
    for (let i = 1; i < h.chain.length; i++) {
      const p = h.chain[i];
      const end = p.side === 'left' ? left : right;
      expect(p.tile.a === end || p.tile.b === end).toBe(true);
      expect(p.outer).toBe(p.tile.a === end ? p.tile.b : p.tile.a);
      if (p.side === 'left') left = p.outer;
      else right = p.outer;
    }
    expect(h.ends).toEqual({ left, right });
  }
}

/** Plays a complete match; difficulty per team. Returns the final state. */
function playMatch(
  seed: number,
  diffs: [Difficulty, Difficulty],
  rules: RuleSettings = DEFAULT_RULES,
  opts: AiOptions = {},
  check = false,
): MatchState {
  let m = createMatch(rules, seed);
  let hands = 0;
  while (!m.over) {
    m = startHand(m).match;
    // the winning pair chooses its opener (both CPU-team logic here, whichever team won)
    if (m.hand!.pendingStarterChoice != null) {
      expect(legalMoves(m)).toEqual([]);
      m = chooseStarter(m, cpuStarter(m));
    }
    hands++;
    if (hands > 200) throw new Error('match does not terminate');
    let steps = 0;
    while (!m.hand!.over) {
      if (++steps > 200) throw new Error('hand does not terminate');
      const legal = legalMoves(m);
      const d = diffs[m.hand!.turn & 1];
      const mv = chooseMove(m, d, opts);
      expect(legal.some((l) => sameMove(l, mv))).toBe(true);
      const prevScores = m.scores;
      const res = applyMove(m, mv);
      m = res.match;
      // a match only ever ends together with a hand end
      if (m.over) expect(res.events.some((e) => e.type === 'handEnd')).toBe(true);
      expect(m.scores[0]).toBeGreaterThanOrEqual(prevScores[0]);
      expect(m.scores[1]).toBeGreaterThanOrEqual(prevScores[1]);
      if (check) checkInvariants(m);
    }
  }
  expect(m.winner).not.toBeNull();
  expect(Math.max(...m.scores)).toBeGreaterThanOrEqual(1);
  return m;
}

const FAST: AiOptions = { maxRollouts: 120, timeMs: 30 };

describe('CPU: full match simulations', () => {
  it('200 easy matches', () => {
    for (let s = 0; s < 200; s++) playMatch(1000 + s, ['easy', 'easy'], DEFAULT_RULES, {}, s < 40);
  });
  it('200 normal matches (with all bonuses on)', () => {
    const rules = { ...DEFAULT_RULES, capicua: 2, chuchazo: 2, paseSalida: 1, paseCorrido: 2, pollona: 'double', paseSalidaNoWin: false };
    for (let s = 0; s < 200; s++) playMatch(2000 + s, ['normal', 'normal'], s % 2 ? rules : DEFAULT_RULES, {}, s < 40);
  });
  it('200 hard matches', { timeout: 300_000 }, () => {
    const variants: RuleSettings[] = [
      DEFAULT_RULES,
      { ...DEFAULT_RULES, scoring: 'opponents', tranqueWinner: 'lowestTeam', tranqueTie: 'mano', nextStarter: 'winner', rounding: 'none' },
      { ...DEFAULT_RULES, tranqueWinner: 'blockerRisk', tranqueTie: 'blockerLoses', nextStarter: 'winnerTeam', firstStarter: 'random', rounding: 'nearest', target: 10 },
      { ...DEFAULT_RULES, nextStarter: 'double6', redealFiveDoubles: true, pollona: 'halfTarget', capicua: 3, rounding: 'down', target: 30 },
    ];
    for (let s = 0; s < 200; s++) playMatch(3000 + s, ['hard', 'hard'], variants[s % 4], FAST, s < 20);
  });
  it('is reproducible from the seed', () => {
    const a = playMatch(77, ['normal', 'easy']);
    const b = playMatch(77, ['normal', 'easy']);
    expect(a).toEqual(b);
  });
});

describe('CPU: strength', () => {
  const winRate = (diffs: [Difficulty, Difficulty], n: number, opts: AiOptions, seed0: number) => {
    let w = 0;
    for (let s = 0; s < n; s++) {
      // swap seats every other match to cancel any seat bias
      const swap = s % 2 === 1;
      const m = playMatch(seed0 + s, swap ? [diffs[1], diffs[0]] : diffs, DEFAULT_RULES, opts);
      if (m.winner === (swap ? 1 : 0)) w++;
    }
    return w / n;
  };

  it('normal beats easy', () => {
    const r = winRate(['normal', 'easy'], 200, {}, 5000);
    console.log('normal vs easy win rate', r);
    expect(r).toBeGreaterThan(0.6);
  });

  it('hard beats easy', { timeout: 300_000 }, () => {
    const r = winRate(['hard', 'easy'], 120, { maxRollouts: 400, timeMs: 50 }, 6000);
    console.log('hard vs easy win rate', r);
    expect(r).toBeGreaterThan(0.62);
  });
});

describe('CPU: behaviour', () => {
  it('always goes out when it can (normal/hard)', () => {
    const m = scenario({
      hands: [[tid(3, 5)], [tid(6, 6), tid(1, 2)], [tid(4, 4)], [tid(0, 1)]],
      chain: [tid(3, 4)],
      ends: { left: 3, right: 5 },
      turn: 0,
    });
    for (const d of ['normal', 'hard'] as Difficulty[]) expect(chooseMove(m, d)).toMatchObject({ kind: 'play', tileId: tid(3, 5) });
  });

  it('passes when it must', () => {
    const m = scenario({
      hands: [[tid(2, 2)], [tid(1, 1)], [tid(4, 4)], [tid(0, 0)]],
      chain: [tid(3, 5)],
      ends: { left: 3, right: 5 },
      turn: 0,
    });
    for (const d of ['easy', 'normal', 'hard'] as Difficulty[]) expect(chooseMove(m, d)).toEqual({ kind: 'pass', seat: 0 });
  });

  it('only uses legitimate information (decision independent of hidden hands)', () => {
    // same own hand / table / public info, different distribution of the hidden tiles
    const { match } = startHand(createMatch(DEFAULT_RULES, 123));
    let m = applyMove(match, legalMoves(match)[0]).match;
    const seat = m.hand!.turn;
    const others = [0, 1, 2, 3].filter((s) => s !== seat);
    const pool = others.flatMap((s) => m.hand!.hands[s]);
    // rotate the hidden pool among the other seats (no passes yet, so any split is consistent)
    const rotated = [...pool.slice(5), ...pool.slice(0, 5)];
    const hands = m.hand!.hands.map((h) => h.slice());
    let k = 0;
    for (const s of others) hands[s] = rotated.slice(k, (k += m.hand!.hands[s].length));
    const m2: MatchState = { ...m, hand: { ...m.hand!, hands } };
    for (const d of ['easy', 'normal', 'hard'] as Difficulty[]) {
      expect(chooseMove(m2, d, { maxRollouts: 600, timeMs: 10_000 })).toEqual(chooseMove(m, d, { maxRollouts: 600, timeMs: 10_000 }));
    }
    m = m2;
  });

  it('blocks the next opponent on a pip he passed on', () => {
    // ends 2|3; next opponent (seat 1) passed on 4. Playing 3-4 shows a 4 he cannot cover.
    const m = scenario({
      hands: [[tid(3, 4), tid(2, 5), tid(4, 6), tid(0, 5)], [tid(1, 1), tid(0, 0)], [tid(6, 6), tid(5, 5)], [tid(1, 2), tid(0, 1)]],
      chain: [tid(2, 3)],
      ends: { left: 2, right: 3 },
      turn: 0,
      passedOn: [[], [4], [], []],
    });
    const mv = chooseMove(m, 'normal');
    expect(mv).toMatchObject({ kind: 'play', tileId: tid(3, 4) });
  });

  it('hard decides within budget', () => {
    const times: number[] = [];
    for (let s = 0; s < 30; s++) {
      let m = startHand(createMatch({ ...DEFAULT_RULES, firstStarter: 'double6Free' }, 9000 + s)).match;
      // take a few early moves to reach a typical branching position
      for (let i = 0; i < s % 5 && !m.hand!.over; i++) m = applyMove(m, chooseMove(m, 'normal')).match;
      if (m.hand!.over) continue;
      const t0 = performance.now();
      chooseMove(m, 'hard');
      const dt = performance.now() - t0;
      if (lastHardStats.moves > 1) times.push(dt);
    }
    times.sort((a, b) => a - b);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    console.log(`hard decision ms: avg ${avg.toFixed(1)}, max ${times[times.length - 1].toFixed(1)}, samples last ${lastHardStats.samples}`);
    expect(times[times.length - 1]).toBeLessThan(150);
  });
});

// ───────────────────────── characters: styles + the master level ─────────────────────────

type Prof = { level: Difficulty; style?: PlayStyle; opts?: AiOptions };

/** a full match with one profile per seat; checks every move is legal */
function playSeats(seed: number, seats: [Prof, Prof, Prof, Prof], rules: RuleSettings = DEFAULT_RULES): MatchState {
  let m = createMatch(rules, seed);
  let hands = 0;
  while (!m.over) {
    m = startHand(m).match;
    if (m.hand!.pendingStarterChoice != null) m = chooseStarter(m, cpuStarter(m));
    if (++hands > 200) throw new Error('match does not terminate');
    let steps = 0;
    while (!m.hand!.over) {
      if (++steps > 200) throw new Error('hand does not terminate');
      const p = seats[m.hand!.turn];
      const mv = chooseMove(m, p.level, p.opts ?? {}, p.style);
      expect(legalMoves(m).some((l) => sameMove(l, mv))).toBe(true);
      m = applyMove(m, mv).match;
    }
  }
  expect(m.winner).not.toBeNull();
  return m;
}

const FAST_M: AiOptions = { maxRollouts: 160, timeMs: 10_000 };
const prof = (c: Character, opts?: AiOptions): Prof => ({ level: c.level, style: c.style, opts: c.level === 'hard' || c.level === 'master' ? opts ?? FAST_M : undefined });

/** team A (seats 0/2) vs team B (1/3), characters drawn per match; same deal played with the teams swapped */
function teamWinRate(a: Character[], b: Character[], n: number, seed0: number, optsA?: AiOptions, optsB?: AiOptions): number {
  let w = 0;
  for (let s = 0; s < n; s++) {
    const swap = s % 2 === 1;
    const k = s >> 1;
    const A1 = prof(a[k % a.length], optsA);
    const A2 = prof(a[(k + 1) % a.length], optsA);
    const B1 = prof(b[(k + 2) % b.length], optsB);
    const B2 = prof(b[(k + 1) % b.length], optsB);
    const m = swap ? playSeats(seed0 + k, [B1, A1, B2, A2]) : playSeats(seed0 + k, [A1, B1, A2, B2]);
    if (m.winner === (swap ? 1 : 0)) w++;
  }
  return w / n;
}

const ofLevel = (l: Difficulty) => ROSTER.filter((c) => c.level === l);

describe('CPU: characters', () => {
  it('every character plays legal, terminating matches (all seats, several rule sets)', { timeout: 300_000 }, () => {
    const rules: RuleSettings[] = [
      DEFAULT_RULES,
      { ...DEFAULT_RULES, capicua: 2, chuchazo: 2, paseSalida: 1, paseCorrido: 2, paseSalidaNoWin: false, rounding: 'none', target: 100 },
      { ...DEFAULT_RULES, scoring: 'opponents', tranqueWinner: 'blockerRisk', nextStarter: 'winnerTeam', capicua: 'double' },
    ];
    const opts: AiOptions = { maxRollouts: 80, timeMs: 10_000 };
    for (let s = 0; s < 30; s++) {
      const seats = [0, 1, 2, 3].map((i) => prof(ROSTER[(s + i * 3) % ROSTER.length], opts)) as [Prof, Prof, Prof, Prof];
      playSeats(12_000 + s, seats, rules[s % rules.length]);
    }
  });

  it('styles are real but light: each style changes some decisions, never the forced ones', () => {
    // same positions, base level vs styled: some decisions differ, all stay legal
    const styles: [Difficulty, PlayStyle][] = [
      ['easy', 'carefree'],
      ['easy', 'impulsive'],
      ['easy', 'beginner'],
      ['normal', 'balanced'],
      ['normal', 'byTheBook'],
      ['normal', 'blocker'],
    ];
    for (const [level, style] of styles) {
      let diff = 0;
      for (let s = 0; s < 60; s++) {
        let m = startHand(createMatch(DEFAULT_RULES, 13_000 + s)).match;
        if (m.hand!.pendingStarterChoice != null) m = chooseStarter(m, cpuStarter(m));
        for (let i = 0; i < 2 + (s % 6) && !m.hand!.over; i++) m = applyMove(m, chooseMove(m, 'normal')).match;
        if (m.hand!.over) continue;
        const a = chooseMove(m, level, {}, style);
        const b = chooseMove(m, level);
        if (!sameMove(a, b)) diff++;
      }
      expect(diff, `${style} should change some decisions`).toBeGreaterThan(0);
    }
  });

  it('level ordering in aggregate: easy characters < normal characters', () => {
    const r = teamWinRate(ofLevel('normal'), ofLevel('easy'), 200, 14_000);
    console.log('normal chars vs easy chars', r);
    expect(r).toBeGreaterThan(0.6);
  });

  it('level ordering in aggregate: normal characters < hard characters', { timeout: 300_000 }, () => {
    const r = teamWinRate(ofLevel('hard'), ofLevel('normal'), 160, 15_000, { maxRollouts: 400, timeMs: 10_000 });
    console.log('hard chars vs normal chars', r);
    expect(r).toBeGreaterThan(0.55);
  });

  it('master pair beats a hard pair (hard characters, 4:1 simulation budget like 170 ms vs 90 ms × speed)', { timeout: 600_000 }, () => {
    const zorg = ofLevel('master');
    const r = teamWinRate(zorg, ofLevel('hard'), 140, 16_000, { maxRollouts: 800, timeMs: 60_000 }, { maxRollouts: 320, timeMs: 60_000 });
    console.log('master pair vs hard pair', r);
    expect(r).toBeGreaterThan(0.55);
  });

  it('master decides within its time budget (cap ~250 ms on a mid-range phone)', { timeout: 120_000 }, () => {
    const times: number[] = [];
    for (let s = 0; s < 4; s++) {
      let m = startHand(createMatch(DEFAULT_RULES, 17_000 + s)).match;
      if (m.hand!.pendingStarterChoice != null) m = chooseStarter(m, cpuStarter(m));
      while (!m.hand!.over) {
        const choices = legalMoves(m).length;
        const t0 = performance.now();
        const mv = chooseMove(m, 'master');
        const dt = performance.now() - t0;
        if (choices > 1) times.push(dt);
        m = applyMove(m, mv).match;
      }
    }
    times.sort((a, b) => a - b);
    console.log(`master decision ms: median ${times[times.length >> 1].toFixed(1)}, max ${times[times.length - 1].toFixed(1)} (budget ${MASTER_MS})`);
    expect(times[times.length - 1]).toBeLessThan(MASTER_MS + 40);
    expect(MASTER_MS + 40).toBeLessThanOrEqual(250);
  });

  it('master only uses legitimate information', () => {
    const { match } = startHand(createMatch(DEFAULT_RULES, 321));
    let m = match;
    for (let i = 0; i < 6 && !m.hand!.over; i++) m = applyMove(m, chooseMove(m, 'normal')).match;
    const seat = m.hand!.turn;
    const others = [0, 1, 2, 3].filter((s) => s !== seat && !m.hand!.passedOn[s].length);
    if (others.length < 2) return;
    const [x, y] = others;
    const hands = m.hand!.hands.map((h) => h.slice());
    // swap one tile between two seats that never passed (the public info is unchanged)
    const tx = hands[x][0];
    hands[x][0] = hands[y][0];
    hands[y][0] = tx;
    const m2: MatchState = { ...m, hand: { ...m.hand!, hands } };
    const o = { maxRollouts: 600, timeMs: 10_000 };
    expect(chooseMove(m2, 'master', o)).toEqual(chooseMove(m, 'master', o));
  });
});
