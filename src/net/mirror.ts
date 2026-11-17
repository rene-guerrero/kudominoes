/**
 * The client's copy of the match during online play, kept in step by applying the (redacted, local
 * perspective) events in order. The server owns the real state; this copy only feeds what the local
 * UI reads (HUD, callouts, summaries, the renderer's restore): other players' tiles are HIDDEN_TILE
 * placeholders, the boneyard is a row of placeholders.
 */
import type { GameEvent, GameMode, MatchState, Pip, RuleSettings, Seat, Tile } from '../contracts';
import { HIDDEN_TILE } from './protocol';
import { isHidden } from './redact';

export function emptyMatch(rules: RuleSettings, mode: GameMode, seats: Seat[]): MatchState {
  return {
    rules,
    scores: [0, 0],
    handsWon: [0, 0],
    hand: null,
    lastHandWinner: null,
    over: false,
    winner: null,
    rng: 0,
    abajo: 0,
    mode,
    seats: seats.slice(),
    ...(mode === 'individual' ? { seatScores: [0, 0, 0, 0], seatHandsWon: [0, 0, 0, 0], winnerSeat: null } : {}),
  };
}

const next = (seats: Seat[] | undefined, s: Seat): Seat => {
  const list = seats && seats.length ? seats : ([0, 1, 2, 3] as Seat[]);
  const i = list.indexOf(s);
  return list[(i + 1) % list.length];
};

/** apply one event (pure: returns a new state) */
export function applyEvent(m: MatchState, ev: GameEvent): MatchState {
  switch (ev.type) {
    case 'handStart': {
      const seats = ev.seats ?? m.seats;
      return {
        ...m,
        seats,
        scores: [ev.scores[0], ev.scores[1]],
        seatScores: ev.seatScores ? ev.seatScores.slice() : m.seatScores,
        hand: {
          handNo: ev.handNo,
          hands: ev.hands.map((h) => h.slice()),
          chain: [],
          ends: null,
          turn: ev.starter,
          starter: ev.starter,
          passesInRow: 0,
          passedOn: [[], [], [], []],
          over: false,
          pendingStarterChoice: null,
          boneyard: ev.boneyard ? ev.boneyard.slice() : undefined,
          openTile: null,
        },
      };
    }
    case 'play': {
      const h = m.hand;
      if (!h) return m;
      const hands = h.hands.map((x) => x.slice());
      const mine = hands[ev.seat] ?? [];
      let k = mine.findIndex((t) => t.id === ev.tile.id);
      if (k < 0) k = mine.findIndex((t) => isHidden(t));
      if (k >= 0) mine.splice(k, 1);
      // the count is authoritative
      while (mine.length > ev.tilesLeft && mine.some(isHidden)) mine.splice(mine.findIndex(isHidden), 1);
      return {
        ...m,
        hand: { ...h, hands, chain: [...h.chain, ev.placed], ends: { ...ev.ends }, turn: next(m.seats, ev.seat), passesInRow: 0, openTile: null },
      };
    }
    case 'pass': {
      const h = m.hand;
      if (!h) return m;
      const passedOn = h.passedOn.map((x) => x.slice());
      for (const v of [ev.ends.left, ev.ends.right] as Pip[]) if (!passedOn[ev.seat].includes(v)) passedOn[ev.seat].push(v);
      return {
        ...m,
        scores: ev.scores ? [ev.scores[0], ev.scores[1]] : m.scores,
        seatScores: ev.seatScores ? ev.seatScores.slice() : m.seatScores,
        abajo: ev.abajoPot ?? m.abajo,
        hand: { ...h, passedOn, turn: next(m.seats, ev.seat), passesInRow: h.passesInRow + 1 },
      };
    }
    case 'draw': {
      const h = m.hand;
      if (!h) return m;
      const hands = h.hands.map((x) => x.slice());
      hands[ev.seat].push(isHidden(ev.tile) ? ({ ...HIDDEN_TILE } as Tile) : ev.tile);
      const boneyard = h.boneyard ? h.boneyard.slice(0, Math.max(0, ev.boneyardLeft)) : undefined;
      if (boneyard) while (boneyard.length < ev.boneyardLeft) boneyard.push({ ...HIDDEN_TILE } as Tile);
      return { ...m, seatScores: ev.seatScores ? ev.seatScores.slice() : m.seatScores, hand: { ...h, hands, boneyard } };
    }
    case 'handEnd': {
      const h = m.hand;
      const handsWon: [number, number] = [m.handsWon[0], m.handsWon[1]];
      const solo = m.mode === 'individual';
      if (!solo && ev.winnerTeam !== null) handsWon[ev.winnerTeam]++;
      const seatHandsWon = m.seatHandsWon ? m.seatHandsWon.slice() : undefined;
      if (solo && seatHandsWon && ev.winnerSeat !== null) seatHandsWon[ev.winnerSeat]++;
      // the remaining tiles are public now
      const hands = h ? h.hands.map((x, s) => (ev.remaining[s] && ev.remaining[s].every((t) => !isHidden(t)) ? ev.remaining[s].slice() : x.slice())) : [];
      return {
        ...m,
        scores: [ev.scores[0], ev.scores[1]],
        seatScores: ev.seatScores ? ev.seatScores.slice() : m.seatScores,
        handsWon,
        seatHandsWon,
        abajo: ev.abajoPot ?? (ev.winnerTeam !== null ? 0 : m.abajo),
        lastHandWinner: ev.winnerSeat,
        hand: h ? { ...h, hands, over: true } : h,
      };
    }
    case 'matchEnd':
      return {
        ...m,
        over: true,
        winner: ev.winner,
        winnerSeat: ev.winnerSeat ?? m.winnerSeat,
        scores: [ev.scores[0], ev.scores[1]],
        seatScores: ev.seatScores ? ev.seatScores.slice() : m.seatScores,
      };
  }
}
