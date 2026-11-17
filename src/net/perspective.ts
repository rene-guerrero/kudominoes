/**
 * Seat perspective. The whole client (renderer, HUD, plates, summaries) is built around "seat 0 = me,
 * at the bottom; team 0 = my team". The server numbers seats absolutely, so every seat-, team- and
 * per-seat value coming from it is rotated here (and my moves rotated back).
 *
 * Mapping: the seats in play, in turn order, are laid onto the local seats of the same count
 * (SEATS_FOR[n]) starting with me at local 0, so the turn order and the usual table layout are kept
 * (4 players: a plain rotation; 3 players: bottom / right / left; 2 players: bottom / top).
 * Pairs: an odd server seat swaps the two teams. Individual: the "human-centric" team fields
 * (0 = me, 1 = anyone else) are recomputed from the seats.
 */
import type { Bonus, GameEvent, GameMode, MatchState, Move, PlacedTile, Seat, Team } from '../contracts';
import { SEATS_FOR } from '../contracts';

type N = 2 | 3 | 4;

export class Perspective {
  /** local seat of each server seat */
  private loc: Seat[] = [0, 1, 2, 3];
  /** server seat of each local seat */
  private srv: Seat[] = [0, 1, 2, 3];
  readonly flip: boolean;
  readonly solo: boolean;
  /** server seats in play, in turn order */
  readonly seats: Seat[];

  constructor(
    readonly me: Seat,
    readonly mode: GameMode,
    seats: readonly Seat[],
  ) {
    this.solo = mode === 'individual';
    const active = (seats.length ? seats.slice() : [0, 1, 2, 3]) as Seat[];
    active.sort((a, b) => a - b);
    this.seats = active;
    const n = Math.max(2, Math.min(4, active.length)) as N;
    const k = Math.max(0, active.indexOf(me));
    const target = SEATS_FOR[n];
    const used = new Set<number>();
    active.forEach((s, i) => {
      const l = target[(i - k + n) % n];
      this.loc[s] = l;
      used.add(s);
    });
    // seats not in play: any bijection onto the free local seats
    const freeLocal = ([0, 1, 2, 3] as Seat[]).filter((l) => !target.includes(l));
    for (const s of [0, 1, 2, 3] as Seat[]) if (!used.has(s)) this.loc[s] = freeLocal.shift() ?? s;
    for (const s of [0, 1, 2, 3] as Seat[]) this.srv[this.loc[s]] = s;
    this.flip = !this.solo && (me & 1) === 1;
  }

  /** server seat → local seat */
  seat = (s: Seat): Seat => this.loc[s & 3];
  /** local seat → server seat */
  server = (l: Seat): Seat => this.srv[l & 3];

  localSeats(): Seat[] {
    return this.seats.map(this.seat).sort((a, b) => a - b);
  }

  team(t: Team): Team {
    return (this.flip ? 1 - t : t) as Team;
  }

  scores(sc: readonly number[]): [number, number] {
    return this.flip ? [sc[1], sc[0]] : [sc[0], sc[1]];
  }

  /** a per-seat array (index = seat) re-indexed by local seat */
  perSeat<T>(arr: readonly T[]): T[] {
    return [0, 1, 2, 3].map((l) => arr[this.srv[l]]);
  }

  /** individual: 0 = me, 1 = anyone else (null stays null) */
  private soloTeam(seat: Seat | null | undefined): Team | null {
    if (seat === null || seat === undefined) return null;
    return this.seat(seat) === 0 ? 0 : 1;
  }

  bonus = (b: Bonus): Bonus => {
    if (b.seat !== undefined) return { ...b, seat: this.seat(b.seat), team: this.soloTeam(b.seat)! };
    return { ...b, team: this.team(b.team) };
  };

  private placed(p: PlacedTile): PlacedTile {
    return { ...p, seat: this.seat(p.seat) };
  }

  private seatList(s: Seat[] | undefined): Seat[] | undefined {
    return s ? s.map(this.seat).sort((a, b) => a - b) : undefined;
  }

  move(m: Move): Move {
    return { ...m, seat: this.seat(m.seat) };
  }

  moveToServer(m: Move): Move {
    return { ...m, seat: this.server(m.seat) };
  }

  event(ev: GameEvent): GameEvent {
    switch (ev.type) {
      case 'handStart':
        return {
          ...ev,
          hands: this.perSeat(ev.hands),
          starter: this.seat(ev.starter),
          scores: this.scores(ev.scores),
          seats: this.seatList(ev.seats),
          seatScores: ev.seatScores && this.perSeat(ev.seatScores),
        };
      case 'play':
        return { ...ev, seat: this.seat(ev.seat), placed: this.placed(ev.placed) };
      case 'pass':
        return {
          ...ev,
          seat: this.seat(ev.seat),
          bonus: ev.bonus && this.bonus(ev.bonus),
          bonusBlocked: ev.bonusBlocked && this.bonus(ev.bonusBlocked),
          bonusAbajo: ev.bonusAbajo && this.bonus(ev.bonusAbajo),
          scores: ev.scores && this.scores(ev.scores),
          seatScores: ev.seatScores && this.perSeat(ev.seatScores),
        };
      case 'draw':
        return {
          ...ev,
          seat: this.seat(ev.seat),
          bonus: ev.bonus && this.bonus(ev.bonus),
          bonusBlocked: ev.bonusBlocked && this.bonus(ev.bonusBlocked),
          seatScores: ev.seatScores && this.perSeat(ev.seatScores),
        };
      case 'handEnd':
        return {
          ...ev,
          winnerSeat: ev.winnerSeat === null ? null : this.seat(ev.winnerSeat),
          winnerTeam: this.solo ? this.soloTeam(ev.winnerSeat) : ev.winnerTeam === null ? null : this.team(ev.winnerTeam),
          bonuses: ev.bonuses.map(this.bonus),
          earlyBonuses: ev.earlyBonuses?.map(this.bonus),
          pipCounts: this.perSeat(ev.pipCounts) as [number, number, number, number],
          remaining: this.perSeat(ev.remaining),
          scores: this.scores(ev.scores),
          seatScores: ev.seatScores && this.perSeat(ev.seatScores),
          seats: this.seatList(ev.seats),
        };
      case 'matchEnd':
        return {
          ...ev,
          winner: this.solo && ev.winnerSeat !== undefined ? this.soloTeam(ev.winnerSeat)! : this.team(ev.winner),
          scores: this.scores(ev.scores),
          bonuses: ev.bonuses.map(this.bonus),
          winnerSeat: ev.winnerSeat === undefined ? undefined : this.seat(ev.winnerSeat),
          seatScores: ev.seatScores && this.perSeat(ev.seatScores),
        };
    }
  }

  match(m: MatchState): MatchState {
    const h = m.hand;
    return {
      ...m,
      scores: this.scores(m.scores),
      handsWon: this.scores(m.handsWon),
      lastHandWinner: m.lastHandWinner === null || m.lastHandWinner === undefined ? null : this.seat(m.lastHandWinner),
      winner: m.winner === null || m.winner === undefined ? null : this.solo ? this.soloTeam(m.winnerSeat ?? null) : this.team(m.winner),
      seats: this.seatList(m.seats),
      seatScores: m.seatScores && this.perSeat(m.seatScores),
      seatHandsWon: m.seatHandsWon && this.perSeat(m.seatHandsWon),
      winnerSeat: m.winnerSeat === null || m.winnerSeat === undefined ? m.winnerSeat : this.seat(m.winnerSeat),
      hand: h
        ? {
            ...h,
            hands: this.perSeat(h.hands),
            chain: h.chain.map((p) => this.placed(p)),
            turn: this.seat(h.turn),
            starter: this.seat(h.starter),
            passedOn: this.perSeat(h.passedOn),
            pendingStarterChoice: h.pendingStarterChoice === null || h.pendingStarterChoice === undefined ? h.pendingStarterChoice : this.team(h.pendingStarterChoice),
          }
        : null,
    };
  }
}
