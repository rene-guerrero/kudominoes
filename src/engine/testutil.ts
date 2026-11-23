import type { MatchState, Move, Pip, PlacedTile, RuleSettings, Seat, TileSet } from '../contracts';
import { applyMove, createMatch, legalMoves, startHand, type EngineHand } from './game';
import { DEFAULT_RULES } from './rules';
import { tileById, tilesFor, tileSetOf } from './tiles';

/** id of tile a-b in a set (any order); defaults to the classic double-six set. */
export function tid(a: number, b: number, set: TileSet = 'double6'): number {
  const t = tilesFor(set).find((t) => (t.a === Math.min(a, b) && t.b === Math.max(a, b)));
  if (!t) throw new Error(`tile ${a}-${b} is not in ${set}`);
  return t.id;
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
  /** pairs: ids intentionally left out of the deal (double-nine leftovers) */
  setAsideIds?: number[];
}

/** Build an arbitrary mid-hand state for focused tests. */
export function scenario(s: Scenario): MatchState {
  const m = createMatch({ ...DEFAULT_RULES, ...(s.rules ?? {}) }, 1);
  const set = tileSetOf(s.rules ?? m.rules);
  const at = (id: number) => tileById(set, id);
  const chain: PlacedTile[] = (s.chain ?? []).map((id, i) => ({
    tile: at(id),
    seat: ((i + (s.starter ?? 0)) & 3) as Seat,
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
    passesInRow: s.passesInRow ?? 0,
    passedOn: s.passedOn ?? [[], [], [], []],
    over: false,
    pendingBonuses: [],
    ...(s.setAsideIds?.length ? { setAsideIds: s.setAsideIds.slice() } : {}),
  };
  return { ...m, hand, scores: s.scores ?? [0, 0] };
}

export function play(m: MatchState, a: number, b: number, side: 'left' | 'right' = 'right') {
  return applyMove(m, { kind: 'play', seat: m.hand!.turn, tileId: tid(a, b, tileSetOf(m.rules)), side });
}

export function pass(m: MatchState) {
  return applyMove(m, { kind: 'pass', seat: m.hand!.turn });
}

export { createMatch, startHand, legalMoves, applyMove };
export type { Move };
