/**
 * Pure game-driving helpers for the room: CPU pacing and decisions, slams, move matching. Mirrors the
 * local game loop (src/app/controller.ts) so online CPUs feel the same.
 */
import type { Difficulty, GameEvent, MatchState, Move, PlayStyle, Seat } from '../../contracts';
import { chooseMove } from '../../engine/ai';
import { legalMoves } from '../../engine/game';

/** CPU think delay in ms (same pacing as GameSession.thinkDelay): ~0.4 s forced, ~0.8–1.8 s choices */
export function thinkDelay(m: MatchState, legalCount: number, speed = 1, rnd: () => number = Math.random): number {
  const h = m.hand!;
  let base = legalCount <= 1 ? 380 : 650 + Math.min(legalCount, 6) * 90;
  if (!h.ends) base += 250;
  base += rnd() * 450;
  if (rnd() < 0.08 && legalCount > 2) base += 700; // occasional long "hmm…"
  return base * speed;
}

/** drawing from the pozo is forced and quick, one tile after another */
export const drawDelay = (speed = 1, rnd: () => number = Math.random): number => (220 + rnd() * 160) * speed;

/** a CPU starter decision gets a short pause (the local game shows a callout) */
export const starterDelay = (speed = 1): number => 1400 * speed;

/**
 * Workers freeze the clock during synchronous execution, so the hard/master AI's wall-clock budget
 * never ends a search early; cap the work by rollouts instead (≈ the budget on a fast machine).
 */
const ROLLOUTS: Partial<Record<Difficulty, number>> = { hard: 2400, master: 5000 };

export function cpuMove(match: MatchState, level: Difficulty, style?: PlayStyle): Move {
  const legal = legalMoves(match);
  let move: Move;
  try {
    move = chooseMove(match, level, { maxRollouts: ROLLOUTS[level] }, style);
  } catch {
    move = legal[0];
  }
  return legal.find((m) => sameMove(m, move)) ?? legal[0];
}

export function sameMove(a: Move, b: Move | undefined | null): boolean {
  if (!b || a.kind !== b.kind || a.seat !== b.seat) return false;
  if (a.kind !== 'play') return true;
  return b.kind === 'play' && a.tileId === b.tileId && a.side === b.side;
}

/** shape check of an untrusted move; returns the matching legal move (with the cosmetic slam flag) */
export function matchLegal(legal: Move[], raw: unknown): Move | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const found = legal.find((l) => sameMove(l, m as unknown as Move));
  if (!found) return null;
  if (found.kind === 'play' && m.slam === true) return { ...found, slam: true };
  return found;
}

/** the play that wins the hand carries `finishing` (the local controller does the same) */
export function markFinishing(events: GameEvent[]): void {
  for (let i = 0; i < events.length - 1; i++) {
    const ev = events[i];
    const next = events[i + 1];
    if (ev.type === 'play' && next.type === 'handEnd' && next.reason === 'domino') events[i] = { ...ev, finishing: true };
  }
}

/**
 * CPU slams sparingly as a meaningful signal (a suit it holds 3+ more of, or a play that forces the
 * next player to pass), rationed by the character's slam settings (same as GameSession.maybeCpuSlam).
 */
export function maybeCpuSlam(
  before: MatchState,
  seat: Seat,
  events: GameEvent[],
  st: { p: number; cap: number },
  stats: { plays: number[]; slams: number[] },
  rnd: () => number = Math.random,
): void {
  const i = events.findIndex((e) => e.type === 'play');
  if (i < 0) return;
  const ev = events[i] as Extract<GameEvent, { type: 'play' }>;
  stats.plays[seat]++;
  if (st.p <= 0 || ev.tilesLeft === 0) return;
  if ((stats.slams[seat] + 1) / stats.plays[seat] > st.cap) return;
  const hand = before.hand!.hands[seat].filter((t) => t.id !== ev.tile.id);
  const v = ev.placed.outer;
  const suit = hand.filter((t) => t.a === v || t.b === v).length;
  const next = events[i + 1];
  const seats = before.seats ?? [0, 1, 2, 3];
  const nextSeat = seats[(seats.indexOf(seat) + 1) % seats.length];
  const forcesPass = next?.type === 'pass' && next.seat === nextSeat;
  if ((suit >= 3 || forcesPass) && rnd() < 0.6 * st.p) {
    stats.slams[seat]++;
    events[i] = { ...ev, slam: true };
  }
}
