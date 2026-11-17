import type { MatchState, Move, Pip, PlacedTile, RuleSettings, Seat } from '../contracts';
import { applyMove, createMatch, legalMoves, startHand, type EngineHand } from './game';
import { DEFAULT_RULES } from './rules';
import { ALL_TILES } from './tiles';

/** id of tile a-b (any order) */
export function tid(a: number, b: number): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return ALL_TILES.findIndex((t) => t.a === lo && t.b === hi);
}

export interface Scenario {
  rules?: RuleSettings;
  hands: number[][]; // tile ids per seat
  chain?: number[]; // tile ids on the table (geometry not validated by tests)
  ends?: { left: Pip; right: Pip } | null;
  turn: Seat;
  starter?: Seat;
  handNo?: number;
  scores?: [number, number];
  passesInRow?: number;
  passedOn?: Pip[][];
}

/** Build an arbitrary mid-hand state for focused tests. */
export function scenario(s: Scenario): MatchState {
  const m = createMatch({ ...DEFAULT_RULES, ...(s.rules ?? {}) }, 1);
  const chain: PlacedTile[] = (s.chain ?? []).map((id, i) => ({
    tile: ALL_TILES[id],
    seat: ((i + (s.starter ?? 0)) & 3) as Seat,
    side: 'right',
    outer: ALL_TILES[id].b,
  }));
  const hand: EngineHand = {
    handNo: s.handNo ?? 2,
    hands: s.hands.map((h) => h.map((id) => ALL_TILES[id])),
    chain,
    ends: s.ends === undefined ? null : s.ends,
    turn: s.turn,
    starter: s.starter ?? 0,
    passesInRow: s.passesInRow ?? 0,
    passedOn: s.passedOn ?? [[], [], [], []],
    over: false,
    pendingBonuses: [],
  };
  return { ...m, hand, scores: s.scores ?? [0, 0] };
}

export function play(m: MatchState, a: number, b: number, side: 'left' | 'right' = 'right') {
  return applyMove(m, { kind: 'play', seat: m.hand!.turn, tileId: tid(a, b), side });
}

export function pass(m: MatchState) {
  return applyMove(m, { kind: 'pass', seat: m.hand!.turn });
}

export { createMatch, startHand, legalMoves, applyMove };
export type { Move };
