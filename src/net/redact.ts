/**
 * Hidden information, both ways:
 *  - redact*: what one seat may see (used by the dev mock server; the real server does the same);
 *  - withPlaceholders: the client side, turning a redacted MatchState + counts back into a full-shaped
 *    state whose unknown tiles are HIDDEN_TILE placeholders (what the renderer's restore expects).
 */
import type { GameEvent, MatchState, Seat, Tile } from '../contracts';
import { HIDDEN_TILE, type SeatView } from './protocol';

const hidden = (n: number): Tile[] => Array.from({ length: n }, () => ({ ...HIDDEN_TILE }) as Tile);

export const isHidden = (t: Tile | undefined | null): boolean => !t || t.id < 0;

/** events as `seat` may see them: other hands and the boneyard become placeholders, others' draws carry no tile */
export function redactEvents(events: readonly GameEvent[], seat: Seat): GameEvent[] {
  return events.map((ev) => {
    switch (ev.type) {
      case 'handStart':
        return {
          ...ev,
          hands: ev.hands.map((h, s) => (s === seat ? h.slice() : hidden(h.length))),
          boneyard: ev.boneyard ? hidden(ev.boneyard.length) : undefined,
        };
      case 'draw':
        return ev.seat === seat ? ev : { ...ev, tile: { ...HIDDEN_TILE } as Tile };
      default:
        return ev;
    }
  });
}

/** the private snapshot of one seat */
export function redactMatch(match: MatchState, seat: Seat): { match: MatchState; handCounts: number[]; pozoCount: number } {
  const h = match.hand;
  const handCounts = [0, 1, 2, 3].map((s) => h?.hands[s]?.length ?? 0);
  const pozoCount = h?.boneyard?.length ?? 0;
  if (!h) return { match: { ...match }, handCounts, pozoCount };
  // a finished hand is public (the remaining tiles were revealed)
  const hands = h.over ? h.hands.map((x) => x.slice()) : h.hands.map((x, s) => (s === seat ? x.slice() : []));
  const safeHand = { ...h, hands, boneyard: h.boneyard ? [] : undefined } as Record<string, unknown>;
  // the engine uses this to detect blocks, but a client must not learn which tiles were never dealt
  delete safeHand.setAsideIds;
  return { match: { ...match, hand: safeHand as unknown as typeof h }, handCounts, pozoCount };
}

/** client: a SeatView's match with every unknown tile as a placeholder (other hands, the boneyard) */
export function withPlaceholders(view: SeatView): MatchState {
  const m = view.match as MatchState;
  const h = m.hand;
  if (!h) return m;
  const hands = [0, 1, 2, 3].map((s) => {
    const known = (h.hands[s] ?? []).filter((t) => !isHidden(t));
    const n = view.handCounts[s] ?? known.length;
    return known.length >= n ? known : [...known, ...hidden(n - known.length)];
  });
  const boneyard = view.pozoCount > 0 || h.boneyard ? hidden(view.pozoCount) : undefined;
  return { ...m, hand: { ...h, hands, boneyard } };
}
