/**
 * Per-seat redaction. Everything the server sends about the game goes through here, so the rule
 * "a client never learns another seat's tiles or the pozo" is enforced in one pure, tested place.
 *
 * What is hidden:
 *  - other seats' hands (handStart: HIDDEN_TILE placeholders of the right length; SeatView: emptied)
 *  - the boneyard / set-aside tiles (handStart: placeholders; SeatView: emptied, see pozoCount)
 *  - the tile of a 'draw' by another seat (HIDDEN_TILE)
 *  - MatchState.rng: the deal is a deterministic function of it (and the step is invertible), so it
 *    would reveal every hand and the pozo. Replaced by 0.
 * Public (as at a real table): plays, passes, the chain, passes per pip, scores, the hands revealed in
 * handEnd.remaining, counts of tiles in each hand and in the pozo.
 */
import type { GameEvent, MatchState, Move, Seat, Tile } from '../../src/contracts';
import { HIDDEN_TILE, type SeatView } from '../../src/net/protocol';

const hidden = (n: number): Tile[] => Array.from({ length: n }, () => ({ ...HIDDEN_TILE }) as Tile);

/** redact one event for the receiving seat (null = a member without a seat: sees no private tiles) */
export function redactEvent(ev: GameEvent, seat: Seat | null): GameEvent {
  switch (ev.type) {
    case 'handStart': {
      const out: GameEvent = { ...ev, hands: ev.hands.map((h, s) => (s === seat ? h.map((t) => ({ ...t })) : hidden(h.length))) };
      if (ev.boneyard) out.boneyard = hidden(ev.boneyard.length);
      return out;
    }
    case 'draw':
      return ev.seat === seat ? { ...ev, tile: { ...ev.tile } } : { ...ev, tile: { ...HIDDEN_TILE } as Tile };
    default:
      return ev;
  }
}

export const redactEvents = (events: readonly GameEvent[], seat: Seat | null): GameEvent[] => events.map((e) => redactEvent(e, seat));

/** the redacted MatchState plus the counts the client needs (see SeatView) */
export function seatView(match: MatchState, seat: Seat, legal: Move[], turnDeadline: number | null): SeatView {
  const hand = match.hand;
  const handCounts = [0, 0, 0, 0];
  let pozoCount = 0;
  let redHand: unknown = null;
  if (hand) {
    for (let s = 0; s < 4; s++) handCounts[s] = hand.hands[s]?.length ?? 0;
    pozoCount = hand.boneyard?.length ?? 0;
    // the hand is over: what remains was revealed by handEnd anyway, but keep it simple and uniform
    const hands = hand.hands.map((h, s) => (s === seat ? h.map((t) => ({ ...t })) : []));
    const h: Record<string, unknown> = { ...hand, hands };
    if (hand.boneyard) h.boneyard = [];
    redHand = JSON.parse(JSON.stringify(h));
  }
  const m = JSON.parse(JSON.stringify({ ...match, hand: null })) as Record<string, unknown>;
  m.rng = 0;
  m.hand = redHand;
  return { seat, match: m, handCounts, pozoCount, legal: legal.map((x) => ({ ...x })), turnDeadline };
}
