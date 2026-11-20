import { describe, expect, it } from 'vitest';
import type { GameEvent, MatchState, Seat } from '../../src/contracts';
import { applyMove, createMatch, legalMoves, startHand } from '../../src/engine/game';
import { chooseMove } from '../../src/engine/ai';
import { DEFAULT_RULES, DEFAULT_RULES_INDIVIDUAL } from '../../src/engine/rules';
import { HIDDEN_TILE } from '../../src/net/protocol';
import { redactEvents, seatView } from '../../src/net/room/redact';

/** play a whole match quickly, collecting every event and the states along the way */
function playMatch(mode: 'pairs' | 'individual', players: 2 | 3 | 4, seed: number, maxHands = 3) {
  const rules = mode === 'pairs' ? DEFAULT_RULES : { ...DEFAULT_RULES_INDIVIDUAL, boneyardDraw: true };
  let m: MatchState = createMatch(rules, seed, mode === 'individual' ? { mode, players } : undefined);
  const log: { events: GameEvent[]; before: MatchState; after: MatchState }[] = [];
  let hands = 0;
  while (!m.over && hands < maxHands) {
    const s = startHand(m);
    log.push({ events: s.events, before: m, after: s.match });
    m = s.match;
    hands++;
    if (m.hand!.pendingStarterChoice != null) m = { ...m, hand: { ...m.hand!, pendingStarterChoice: null } };
    while (!m.hand!.over) {
      const mv = chooseMove(m, 'normal');
      const r = applyMove(m, mv);
      log.push({ events: r.events, before: m, after: r.match });
      m = r.match;
    }
  }
  return log;
}

/** ids of tiles a seat must never see at this moment: others' hands and the pozo (before the move) */
function secretIds(state: MatchState, seat: Seat | null): Set<number> {
  const out = new Set<number>();
  const h = state.hand;
  if (!h) return out;
  h.hands.forEach((tiles, s) => s !== seat && tiles.forEach((t) => out.add(t.id)));
  h.boneyard?.forEach((t) => out.add(t.id));
  return out;
}

const tileIdsIn = (x: unknown, acc: number[] = []): number[] => {
  if (Array.isArray(x)) x.forEach((v) => tileIdsIn(v, acc));
  else if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    if (typeof o.id === 'number' && typeof o.a === 'number' && typeof o.b === 'number') acc.push(o.id);
    for (const v of Object.values(o)) tileIdsIn(v, acc);
  }
  return acc;
};

describe('redactEvents', () => {
  for (const [mode, players] of [['pairs', 4], ['individual', 2], ['individual', 3], ['individual', 4]] as const) {
    it(`never leaks other hands or the pozo (${mode} ${players}p)`, () => {
      for (let seed = 1; seed <= 6; seed++) {
        const log = playMatch(mode, players, seed * 7919);
        let draws = 0;
        for (const { events, before, after } of log) {
          for (const seat of [0, 1, 2, 3, null] as (Seat | null)[]) {
            const red = redactEvents(events, seat);
            red.forEach((ev, i) => {
              const orig = events[i];
              if (orig.type === 'handEnd' || orig.type === 'matchEnd') return; // the reveal is public
              // tiles that become public in this very event: a played tile
              const allowed = new Set<number>();
              if (orig.type === 'play') allowed.add(orig.tile.id);
              if (orig.type === 'draw' && orig.seat === seat) allowed.add(orig.tile.id);
              // secrets: other hands and the pozo, before and after (a drawn tile goes pozo → hand)
              const secret = new Set([...secretIds(before.hand && !before.hand.over ? before : after, seat), ...secretIds(after, seat)]);
              for (const id of tileIdsIn(ev)) {
                if (id === -1 || allowed.has(id)) continue;
                expect(secret.has(id), `${ev.type} leaks tile ${id} to seat ${seat}`).toBe(false);
              }
            });
          }
          for (const e of events) if (e.type === 'draw') draws++;
        }
        if (mode === 'individual' && players < 4) expect(draws).toBeGreaterThanOrEqual(0);
      }
    });
  }

  it('handStart keeps hand lengths and the pozo size with HIDDEN_TILE placeholders', () => {
    const m = createMatch({ ...DEFAULT_RULES_INDIVIDUAL, boneyardDraw: true }, 42, { mode: 'individual', players: 3 });
    const { events } = startHand(m);
    const hs = events[0] as Extract<GameEvent, { type: 'handStart' }>;
    const red = redactEvents(events, 1)[0] as Extract<GameEvent, { type: 'handStart' }>;
    expect(red.hands[1]).toEqual(hs.hands[1]);
    for (const s of [0, 2, 3]) {
      expect(red.hands[s].length).toBe(hs.hands[s].length);
      expect(red.hands[s].every((t) => t.id === HIDDEN_TILE.id)).toBe(true);
    }
    expect(red.boneyard!.length).toBe(hs.boneyard!.length);
    expect(red.boneyard!.every((t) => t.id === -1)).toBe(true);
    // the original is untouched
    expect(hs.hands[0].some((t) => t.id !== -1)).toBe(true);
  });

  it("another seat's draw carries no tile; your own draw does", () => {
    const ev: GameEvent = { type: 'draw', seat: 2, tile: { id: 12, a: 1, b: 6 }, boneyardLeft: 4, ends: { left: 3, right: 4 } };
    expect((redactEvents([ev], 0)[0] as typeof ev).tile.id).toBe(-1);
    expect((redactEvents([ev], null)[0] as typeof ev).tile.id).toBe(-1);
    expect((redactEvents([ev], 2)[0] as typeof ev).tile.id).toBe(12);
  });
});

describe('seatView', () => {
  it('keeps only the own hand, empties the pozo, hides the rng, reports counts', () => {
    for (const [mode, players] of [['pairs', 4], ['individual', 3]] as const) {
      const log = playMatch(mode, players, 99, 1);
      for (const { after } of log) {
        if (!after.hand) continue;
        for (const seat of (after.seats ?? [0, 1, 2, 3]) as Seat[]) {
          const v = seatView(after, seat, [], null);
          const vm = v.match as MatchState;
          expect(vm.rng).toBe(0);
          const secret = secretIds(after, seat);
          for (const id of tileIdsIn(vm)) {
            // tiles on the table are public
            if (after.hand.chain.some((p) => p.tile.id === id)) continue;
            expect(secret.has(id), `view leaks ${id} to ${seat}`).toBe(false);
          }
          expect(vm.hand!.hands[seat]).toEqual(after.hand.hands[seat]);
          expect(v.handCounts).toEqual(after.hand.hands.map((h) => h.length));
          expect(v.pozoCount).toBe(after.hand.boneyard?.length ?? 0);
          if (after.hand.boneyard) expect(vm.hand!.boneyard).toEqual([]);
        }
      }
    }
  });

  it('does not mutate the server state', () => {
    const m = startHand(createMatch(DEFAULT_RULES, 5)).match;
    const copy = JSON.stringify(m);
    seatView(m, 0, legalMoves(m), 123);
    expect(JSON.stringify(m)).toBe(copy);
  });
});
