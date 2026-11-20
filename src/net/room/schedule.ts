/**
 * Timer schedule of one room. A Durable Object has a single alarm, so every pending timer lives here
 * (persisted with the room) and the alarm is always set to the earliest due time. Pure functions only.
 *
 *  - game:  at most one game timer at a time (a human's turn deadline, a CPU's think delay, the pause
 *           before the next deal). `key` identifies the situation it was set for (state step + who
 *           acts), so re-evaluating the same situation never resets a running turn clock.
 *  - grace: per disconnected player, when a CPU starts covering their seat.
 *  - idle:  when the room is deleted (only set while nobody is connected).
 */

export type GameTimerKind = 'turn' | 'cpu' | 'starter' | 'cpuStarter' | 'nextHand';

export interface GameTimer {
  kind: GameTimerKind;
  at: number;
  key: string;
}

export interface Schedule {
  game: GameTimer | null;
  grace: Record<string, number>;
  idle: number | null;
}

export const emptySchedule = (): Schedule => ({ game: null, grace: {}, idle: null });

/** earliest due time, or null when nothing is pending */
export function nextAlarm(s: Schedule): number | null {
  let t: number | null = s.game ? s.game.at : null;
  for (const at of Object.values(s.grace)) if (t === null || at < t) t = at;
  if (s.idle !== null && (t === null || s.idle < t)) t = s.idle;
  return t;
}

export interface DueItems {
  game: GameTimer | null;
  grace: string[];
  idle: boolean;
}

/** what is due at `now`; the due entries are removed from the (mutated) schedule */
export function takeDue(s: Schedule, now: number): DueItems {
  const out: DueItems = { game: null, grace: [], idle: false };
  if (s.game && s.game.at <= now) {
    out.game = s.game;
    s.game = null;
  }
  for (const [pid, at] of Object.entries(s.grace)) {
    if (at <= now) {
      out.grace.push(pid);
      delete s.grace[pid];
    }
  }
  if (s.idle !== null && s.idle <= now) {
    out.idle = true;
    s.idle = null;
  }
  return out;
}

/**
 * Set the game timer for a situation. If a timer with the same key is already pending it is kept
 * (so a running turn deadline is not extended); returns the timer in effect.
 */
export function setGameTimer(s: Schedule, kind: GameTimerKind, at: number, key: string): { timer: GameTimer; changed: boolean } {
  if (s.game && s.game.key === key && s.game.kind === kind) return { timer: s.game, changed: false };
  s.game = { kind, at, key };
  return { timer: s.game, changed: true };
}

export function clearGameTimer(s: Schedule): void {
  s.game = null;
}
