/**
 * The renderer's requestAnimationFrame chain, kept to exactly one pending frame.
 *
 * - kick() during a frame (e.g. a quality change triggered from the frame's own telemetry) is deferred
 *   to the end of that frame instead of starting a second chain (two chains = double work per frame on
 *   phones that are already slow, and a stray chain the pause logic can't cancel).
 * - an exception thrown by a frame never ends the chain: it is reported and the next frame is still
 *   requested, so pending tweens (and the game awaiting them) keep going. Before, one thrown frame left
 *   the loop asleep with animations pending until something else kicked it (e.g. pause → resume).
 * - requestAnimationFrame can stall while the page still counts as visible (seen in background panes;
 *   suspected in Android WebViews, where "minimize and come back" revived a frozen game): a frame not
 *   delivered within `stallMs` runs from a timer instead, so animations — and the game awaiting them —
 *   keep going (slower) until frames flow again.
 * - after many failing frames (without 10 clean frames in between) `onFatal` is called once (the app
 *   shows its error screen).
 */
export type RafFn = (cb: (now: number) => void) => number;
export type CafFn = (id: number) => void;

export interface FrameLoopOpts {
  /** one frame; returns true when another frame is wanted */
  frame(now: number): boolean;
  /** false while paused / disposed: nothing is scheduled */
  canRun(): boolean;
  /** every failed frame (logged by the caller, throttled) */
  onError?(err: unknown, consecutive: number): void;
  /** called once after `fatalAfter` consecutive failed frames */
  onFatal?(err: unknown): void;
  fatalAfter?: number;
  raf?: RafFn;
  caf?: CafFn;
  /** a requested frame that has not arrived after this many ms runs from a timer (default 400) */
  stallMs?: number;
  setTimer?: (cb: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
  now?: () => number;
  /** the first frame of a stall (rAF stopped delivering) */
  onStalled?(): void;
}

export class FrameLoop {
  private id = 0;
  private inFrame = false;
  private again = false;
  private fails = 0;
  /** frames without an error since the last failure (capped frames that skip rendering count too) */
  private okStreak = 0;
  private fatalSent = false;
  private readonly raf: RafFn;
  private readonly caf: CafFn;
  private timer = 0;
  private stalled = false;
  /** inside a run of timer-driven frames (reset by the next frame rAF delivers) */
  private stallRun = false;

  constructor(private o: FrameLoopOpts) {
    this.raf = o.raf ?? ((cb) => requestAnimationFrame(cb));
    this.caf = o.caf ?? ((id) => cancelAnimationFrame(id));
  }

  /** the current frame runs from the stall timer (rAF did not deliver): allow a bigger time step */
  get fromTimer(): boolean {
    return this.stalled;
  }

  private request(): void {
    this.id = this.raf(this.tick);
    if (!this.timer) {
      const set = this.o.setTimer ?? ((cb, ms) => setTimeout(cb, ms) as unknown as number);
      this.timer = set(this.onStall, this.o.stallMs ?? 400);
    }
  }

  private clearStall(): void {
    if (this.timer) (this.o.clearTimer ?? ((id) => clearTimeout(id)))(this.timer);
    this.timer = 0;
  }

  private onStall = (): void => {
    this.timer = 0;
    if (!this.id) return;
    this.caf(this.id);
    if (!this.stallRun) {
      this.stallRun = true;
      try {
        this.o.onStalled?.();
      } catch {
        /* ignore */
      }
    }
    this.stalled = true;
    try {
      this.tick((this.o.now ?? (() => performance.now()))());
    } finally {
      this.stalled = false;
    }
  };

  /** a frame is pending */
  get scheduled(): boolean {
    return this.id !== 0;
  }

  /** consecutive failed frames so far */
  get failures(): number {
    return this.fails;
  }

  kick(): void {
    if (this.inFrame) {
      this.again = true;
      return;
    }
    if (this.id || !this.o.canRun()) return;
    this.request();
  }

  cancel(): void {
    if (this.id) this.caf(this.id);
    this.id = 0;
    this.again = false;
    this.clearStall();
  }

  private tick = (now: number): void => {
    this.id = 0;
    this.clearStall();
    if (!this.stalled) this.stallRun = false;
    if (!this.o.canRun()) return;
    this.inFrame = true;
    this.again = false;
    let more = true;
    try {
      more = this.o.frame(now);
      // recovered only after a run of clean frames: a frame cap that skips every other frame (and so
      // never fails) must not hide a frame that fails every time it renders
      if (++this.okStreak >= 10) this.fails = 0;
    } catch (e) {
      this.okStreak = 0;
      this.fails++;
      try {
        this.o.onError?.(e, this.fails);
      } catch {
        /* ignore */
      }
      const fatal = this.fails >= (this.o.fatalAfter ?? 90);
      // a frame that keeps failing stops spinning (a later kick() tries again)
      if (fatal) more = false;
      if (fatal && !this.fatalSent) {
        this.fatalSent = true;
        try {
          this.o.onFatal?.(e);
        } catch {
          /* ignore */
        }
      }
    } finally {
      this.inFrame = false;
    }
    if ((more || this.again) && !this.id && this.o.canRun()) this.request();
    this.again = false;
  };
}
