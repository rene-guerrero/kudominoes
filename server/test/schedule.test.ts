import { describe, expect, it } from 'vitest';
import type { GameEvent, MatchState } from '../../src/contracts';
import { applyMove, createMatch, legalMoves, startHand } from '../../src/engine/game';
import { DEFAULT_RULES } from '../../src/engine/rules';
import { tunables } from '../src/config';
import { cpuMove, drawDelay, markFinishing, matchLegal, thinkDelay } from '../src/game';
import { clearGameTimer, emptySchedule, nextAlarm, setGameTimer, takeDue } from '../src/schedule';

describe('schedule', () => {
  it('alarm = earliest of game, grace and idle', () => {
    const s = emptySchedule();
    expect(nextAlarm(s)).toBeNull();
    setGameTimer(s, 'turn', 500, '1:0:human');
    s.grace.a = 300;
    s.grace.b = 900;
    s.idle = 10_000;
    expect(nextAlarm(s)).toBe(300);
    delete s.grace.a;
    expect(nextAlarm(s)).toBe(500);
    clearGameTimer(s);
    expect(nextAlarm(s)).toBe(900);
  });

  it('takeDue removes only what is due', () => {
    const s = emptySchedule();
    setGameTimer(s, 'cpu', 100, '3:1:cpu');
    s.grace.a = 50;
    s.grace.b = 200;
    s.idle = 150;
    const d = takeDue(s, 120);
    expect(d.game?.kind).toBe('cpu');
    expect(d.grace).toEqual(['a']);
    expect(d.idle).toBe(false);
    expect(s.game).toBeNull();
    expect(s.grace).toEqual({ b: 200 });
    expect(nextAlarm(s)).toBe(150);
    expect(takeDue(s, 1000)).toEqual({ game: null, grace: ['b'], idle: true });
    expect(nextAlarm(s)).toBeNull();
  });

  it('the same situation keeps its running turn clock; a new one replaces it', () => {
    const s = emptySchedule();
    expect(setGameTimer(s, 'turn', 30_000, '4:2:human').changed).toBe(true);
    const again = setGameTimer(s, 'turn', 45_000, '4:2:human');
    expect(again.changed).toBe(false);
    expect(again.timer.at).toBe(30_000);
    // the player dropped and a CPU covers: different controller → new timer
    expect(setGameTimer(s, 'cpu', 31_000, '4:2:cover').changed).toBe(true);
    expect(s.game?.at).toBe(31_000);
  });

  it('tunables read test overrides and fall back to the protocol defaults', () => {
    expect(tunables({}).turnTimeoutMs).toBe(30_000);
    expect(tunables({ KUDO_TURN_TIMEOUT_MS: '1500' }).turnTimeoutMs).toBe(1500);
    expect(tunables({ KUDO_TURN_TIMEOUT_MS: 'nope' }).turnTimeoutMs).toBe(30_000);
    expect(tunables({ KUDO_CPU_SPEED: '0.05' }).cpuSpeed).toBe(0.05);
  });
});

describe('cpu pacing and moves', () => {
  const m: MatchState = startHand(createMatch(DEFAULT_RULES, 11)).match;

  it('think delays feel human (0.4–2.5 s at normal speed)', () => {
    for (let i = 0; i < 200; i++) {
      const d = thinkDelay(m, 1 + (i % 6));
      expect(d).toBeGreaterThanOrEqual(380);
      expect(d).toBeLessThanOrEqual(2600);
      const dd = drawDelay();
      expect(dd).toBeGreaterThanOrEqual(220);
      expect(dd).toBeLessThanOrEqual(380);
    }
    expect(thinkDelay(m, 3, 0.1, () => 0.5)).toBeCloseTo((650 + 270 + 250 + 225) * 0.1);
  });

  it('matchLegal accepts only legal moves and keeps the slam flag', () => {
    const legal = legalMoves(m);
    const pick = legal[0];
    expect(matchLegal(legal, { ...pick })).toEqual(pick);
    if (pick.kind === 'play') expect(matchLegal(legal, { ...pick, slam: true })).toEqual({ ...pick, slam: true });
    expect(matchLegal(legal, { kind: 'play', seat: pick.seat, tileId: 99, side: 'left' })).toBeNull();
    expect(matchLegal(legal, { kind: 'pass', seat: ((pick.seat + 1) % 4) })).toBeNull();
    expect(matchLegal(legal, null)).toBeNull();
  });

  it('every level returns a legal move, master within a sane CPU budget', () => {
    let mid = m;
    for (let i = 0; i < 3; i++) mid = applyMove(mid, cpuMove(mid, 'normal')).match;
    for (const lvl of ['easy', 'normal', 'hard', 'master'] as const) {
      const t0 = performance.now();
      const mv = cpuMove(mid, lvl);
      const ms = performance.now() - t0;
      expect(legalMoves(mid).some((l) => JSON.stringify(l) === JSON.stringify(mv))).toBe(true);
      if (lvl === 'master') { console.log(`master decision: ${ms.toFixed(0)} ms`); expect(ms).toBeLessThan(2000); }
    }
  });

  it('markFinishing flags the winning play only', () => {
    const play = { type: 'play', seat: 0, tile: { id: 0, a: 0, b: 0 }, side: 'left', placed: {}, ends: { left: 0, right: 0 }, tilesLeft: 0, isFirst: false } as unknown as GameEvent;
    const end = { type: 'handEnd', reason: 'domino' } as unknown as GameEvent;
    const evs = [play, end];
    markFinishing(evs);
    expect((evs[0] as { finishing?: boolean }).finishing).toBe(true);
    const evs2 = [play, { ...end, reason: 'blocked' } as GameEvent];
    markFinishing(evs2);
    expect((evs2[0] as { finishing?: boolean }).finishing).toBeUndefined();
  });
});
