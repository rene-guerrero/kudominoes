/**
 * Game loop. One GameSession per match run; it is cancellable (quit to menu) and pausable.
 * Every await on the outside world (view animations, human input, UI panels, think delays)
 * goes through `this.wait()`, which rejects with `Cancelled` once the session is cancelled, so
 * no stale continuation ever touches a dead match or the view.
 */
import type { CpuProfile, EngineApi, GameEvent, MatchState, Move, Seat, TableView } from '../contracts';

export class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

type HandEnd = Extract<GameEvent, { type: 'handEnd' }>;
type MatchEnd = Extract<GameEvent, { type: 'matchEnd' }>;

export interface SessionHooks {
  /** Called right before an event is animated (HUD updates, speech bubbles). */
  onEvent(ev: GameEvent, match: MatchState, replay: boolean): void;
  /** Called after the event animation finished. */
  onEventDone?(ev: GameEvent, match: MatchState): void;
  onTurn(seat: Seat | null, match: MatchState, humanMustPass: boolean): void;
  showHandSummary(ev: HandEnd, match: MatchState, prevScores: [number, number]): Promise<void>;
  showMatchEnd(ev: MatchEnd, match: MatchState): Promise<'rematch' | 'menu'>;
  save(match: MatchState, handEvents: GameEvent[]): void;
  /** the winning pair chooses its opener (human chooser or CPU decision); resolves with the opener */
  pickStarter?(match: MatchState): Promise<Seat>;
  /** called once after a saved match was put back on the table (instant restore) */
  onRestore?(match: MatchState): void;
  setSfxMuted(muted: boolean): void;
}

export interface SessionDeps {
  engine: EngineApi;
  view: TableView;
  hooks: SessionHooks;
  /** level + playing style of a CPU seat (1..3) */
  profile: (seat: Seat) => CpuProfile;
  /** how a CPU seat slams: chance multiplier on meaningful plays (0 = never) and max share of its plays */
  slam?: (seat: Seat) => { p: number; cap: number };
  /** think-delay multiplier: 1 = normal, 0.5 = fast */
  speed: () => number;
  /** view animation multiplier to restore after a fast-forwarded replay (1 = normal) */
  viewSpeed?: () => number;
}

export type SessionResult = 'rematch' | 'menu' | 'cancelled';

const sleepRaw = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class GameSession {
  private cancelled = false;
  private rejectCancel!: (e: Error) => void;
  private cancelPromise: Promise<never>;
  private paused = false;
  private resumeWaiters: (() => void)[] = [];
  private match: MatchState;
  private handEvents: GameEvent[];

  constructor(
    private deps: SessionDeps,
    initial: MatchState,
    private resume = false,
    resumeEvents: GameEvent[] = [],
  ) {
    this.match = initial;
    this.handEvents = resumeEvents.slice();
    this.cancelPromise = new Promise<never>((_, rej) => (this.rejectCancel = rej));
    this.cancelPromise.catch(() => {});
  }

  get current(): MatchState {
    return this.match;
  }
  get isCancelled(): boolean {
    return this.cancelled;
  }
  get isPaused(): boolean {
    return this.paused;
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.rejectCancel(new Cancelled());
    this.resumeWaiters.splice(0).forEach((r) => r());
  }

  setPaused(p: boolean): void {
    if (this.paused === p || this.cancelled) return;
    this.paused = p;
    this.deps.view.setPaused(p);
    if (!p) this.resumeWaiters.splice(0).forEach((r) => r());
  }

  /** Race any outside promise against cancellation, then hold while paused. */
  private async wait<T>(p: Promise<T>): Promise<T> {
    const v = await Promise.race([p, this.cancelPromise]);
    await this.gate();
    return v;
  }

  private async gate(): Promise<void> {
    while (this.paused && !this.cancelled) await new Promise<void>((r) => this.resumeWaiters.push(r));
    if (this.cancelled) throw new Cancelled();
  }

  /** Sleep that only counts time while unpaused. */
  private async sleep(ms: number): Promise<void> {
    let left = ms;
    while (left > 0) {
      await this.gate();
      const step = Math.min(left, 50);
      await this.wait(sleepRaw(step));
      left -= step;
    }
  }

  private thinkDelay(m: MatchState, legalCount: number): number {
    const sp = this.deps.speed();
    const h = m.hand!;
    // forced moves are quick, the opening and mid-game choices take longer, plus jitter
    let base = legalCount <= 1 ? 380 : 650 + Math.min(legalCount, 6) * 90;
    if (!h.ends) base += 250;
    base += Math.random() * 450;
    if (Math.random() < 0.08 && legalCount > 2) base += 700; // occasional long "hmm…"
    return base * sp;
  }

  private async play(events: GameEvent[], replay = false): Promise<{ handEnd?: HandEnd; matchEnd?: MatchEnd }> {
    const out: { handEnd?: HandEnd; matchEnd?: MatchEnd } = {};
    for (let i = 0; i < events.length; i++) {
      let ev = events[i];
      const next = events[i + 1];
      // let the view know at play time that this tile wins the hand (signature finishing animation)
      if (ev.type === 'play' && next?.type === 'handEnd' && next.reason === 'domino') ev = { ...ev, finishing: true };
      // a resumed hand is replayed quietly: no slams
      if (replay && ev.type === 'play' && ev.slam) ev = { ...ev, slam: false };
      if (ev.type === 'handEnd') out.handEnd = ev;
      if (ev.type === 'matchEnd') {
        // presented after the hand summary (see run), so the stinger/popup follows the hand result
        out.matchEnd = ev;
        continue;
      }
      this.deps.hooks.onEvent(ev, this.match, replay);
      await this.wait(this.deps.view.handle(ev));
      this.deps.hooks.onEventDone?.(ev, this.match);
    }
    return out;
  }

  private plays = [0, 0, 0, 0];
  private slams = [0, 0, 0, 0];

  /**
   * CPU slams sparingly, only as a meaningful signal: playing into a suit it holds 3+ more of, or a
   * play that forces the next player to pass. How often depends on the character's style (some never
   * slam); without one: never on easy, at most ~1 in 6 of its plays.
   */
  private maybeCpuSlam(before: MatchState, seat: Seat, events: GameEvent[]): void {
    const i = events.findIndex((e) => e.type === 'play');
    if (i < 0) return;
    const ev = events[i] as Extract<GameEvent, { type: 'play' }>;
    this.plays[seat]++;
    const st = this.deps.slam?.(seat) ?? (this.deps.profile(seat).level === 'easy' ? { p: 0, cap: 0 } : { p: 1, cap: 1 / 6 });
    if (st.p <= 0 || ev.tilesLeft === 0) return;
    if ((this.slams[seat] + 1) / this.plays[seat] > st.cap) return;
    const hand = before.hand!.hands[seat].filter((t) => t.id !== ev.tile.id);
    const v = ev.placed.outer;
    const suit = hand.filter((t) => t.a === v || t.b === v).length;
    const next = events[i + 1];
    const forcesPass = next?.type === 'pass' && next.seat === ((seat + 1) % 4);
    if (suit >= 3 || forcesPass) {
      if (Math.random() < 0.6 * st.p) {
        this.slams[seat]++;
        events[i] = { ...ev, slam: true };
      }
    }
  }

  async run(): Promise<SessionResult> {
    const { engine, view, hooks } = this.deps;
    try {
      // Resume: put the saved state back on the table in one frame (no replay, no sounds).
      if (this.resume && this.match.hand) {
        const h = this.match.hand;
        hooks.setSfxMuted(true);
        try {
          await this.wait(view.restore?.({ hand: h, scores: this.match.scores, handOver: h.over }) ?? Promise.resolve());
        } finally {
          hooks.setSfxMuted(false);
        }
        hooks.onRestore?.(this.match);
      }
      for (;;) {
        if (this.match.over) {
          // finished match loaded somehow: nothing to do
          return 'menu';
        }
        if (!this.match.hand || this.match.hand.over) {
          await this.gate();
          view.setTurn(null);
          const r = engine.startHand(this.match);
          this.match = r.match;
          this.handEvents = r.events.slice();
          hooks.save(this.match, this.handEvents);
          await this.play(r.events);
        }

        // the winning pair decides which of the two opens (also after resuming a save in that state)
        const ph = this.match.hand;
        if (ph && !ph.over && ph.pendingStarterChoice != null && engine.chooseStarter) {
          const team = ph.pendingStarterChoice;
          let seat: Seat = hooks.pickStarter ? await this.wait(hooks.pickStarter(this.match)) : (engine.cpuStarter?.(this.match) ?? ph.turn);
          if ((seat & 1) !== team) seat = ph.turn;
          this.match = engine.chooseStarter(this.match, seat);
          hooks.save(this.match, this.handEvents);
        }
        let handEnd: HandEnd | undefined;
        let matchEnd: MatchEnd | undefined;
        let prevScores: [number, number] = [...this.match.scores] as [number, number];

        while (this.match.hand && !this.match.hand.over) {
          await this.gate();
          const seat = this.match.hand.turn;
          const legal = engine.legalMoves(this.match);
          if (!legal.length) throw new Error('engine returned no legal moves');
          const mustPass = legal.length === 1 && legal[0].kind === 'pass';
          view.setTurn(seat);
          hooks.onTurn(seat, this.match, mustPass);

          let move: Move;
          if (seat === 0) {
            const chosen = await this.wait(view.requestHumanMove(legal));
            move =
              legal.find((m) => sameMove(m, chosen)) ??
              legal.find((m) => m.kind === 'play' && chosen?.kind === 'play' && m.tileId === chosen.tileId) ??
              legal[0];
            // keep the human's slam flag (cosmetic) on the matched legal move
            if (move.kind === 'play' && chosen?.kind === 'play' && chosen.slam) move = { ...move, slam: true };
          } else {
            await this.sleep(this.thinkDelay(this.match, legal.length));
            const pr = this.deps.profile(seat);
            move = engine.chooseMove(this.match, pr.level, pr.style);
            if (!legal.some((m) => sameMove(m, move))) move = legal[0];
          }

          prevScores = [...this.match.scores] as [number, number];
          const before = this.match;
          const r = engine.applyMove(this.match, move);
          if (seat !== 0) this.maybeCpuSlam(before, seat, r.events);
          this.match = r.match;
          this.handEvents.push(...r.events);
          // once the hand is over, save the finished state so "Continuar" starts the next hand
          hooks.save(this.match, this.match.hand?.over ? [] : this.handEvents);
          const res = await this.play(r.events);
          handEnd = res.handEnd ?? handEnd;
          matchEnd = res.matchEnd ?? matchEnd;
        }

        view.setTurn(null);
        hooks.onTurn(null, this.match, false);
        if (handEnd) await this.wait(hooks.showHandSummary(handEnd, this.match, prevScores));
        if (this.match.over) {
          const ev: MatchEnd = matchEnd ?? { type: 'matchEnd', winner: this.match.winner ?? 0, scores: this.match.scores, bonuses: [] };
          hooks.onEvent(ev, this.match, false);
          await this.wait(view.handle(ev));
          return await this.wait(hooks.showMatchEnd(ev, this.match));
        }
      }
    } catch (e) {
      if (e instanceof Cancelled || this.cancelled) return 'cancelled';
      throw e;
    }
  }
}

function sameMove(a: Move, b: Move | undefined | null): boolean {
  if (!b || a.kind !== b.kind || a.seat !== b.seat) return false;
  if (a.kind === 'pass') return true;
  return b.kind === 'play' && a.tileId === b.tileId && a.side === b.side;
}
