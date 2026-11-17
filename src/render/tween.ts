/** Tiny tween/timeline system. Allocates only when a tween starts, never per frame. */

export type Ease = (t: number) => number;

export const ease = {
  linear: (t: number) => t,
  inQuad: (t: number) => t * t,
  outQuad: (t: number) => t * (2 - t),
  inOutQuad: (t: number) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  inCubic: (t: number) => t * t * t,
  outCubic: (t: number) => {
    const u = t - 1;
    return u * u * u + 1;
  },
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1),
  outBack: (t: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    const u = t - 1;
    return 1 + c3 * u * u * u + c1 * u * u;
  },
  outBackBig: (t: number) => {
    const c1 = 3.2;
    const c3 = c1 + 1;
    const u = t - 1;
    return 1 + c3 * u * u * u + c1 * u * u;
  },
  outElastic: (t: number) => {
    if (t === 0 || t === 1) return t;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
  },
  /** anticipation: dips back first, then shoots forward */
  inBack: (t: number) => {
    const c1 = 1.70158;
    return (c1 + 1) * t * t * t - c1 * t * t;
  },
};

interface Tween {
  start: number;
  dur: number;
  ease: Ease;
  fn: (k: number, raw: number) => void;
  onStart?: () => void;
  started: boolean;
  resolve: () => void;
}

export class Animator {
  /** animation-time seconds (scaled by speed, frozen while paused) */
  time = 0;
  speed = 1;
  private list: Tween[] = [];

  get active(): boolean {
    return this.list.length > 0;
  }

  /** Run fn(k) over `dur` seconds after `delay`. Resolves after the k=1 call. */
  tween(dur: number, fn: (k: number, raw: number) => void, e: Ease = ease.linear, delay = 0, onStart?: () => void): Promise<void> {
    return new Promise<void>((resolve) => {
      this.list.push({ start: this.time + delay, dur: Math.max(1e-4, dur), ease: e, fn, onStart, started: false, resolve });
    });
  }

  wait(sec: number): Promise<void> {
    return this.tween(sec, noop);
  }

  update(dt: number): void {
    this.time += dt * this.speed;
    const t = this.time;
    const list = this.list;
    for (let i = 0; i < list.length; i++) {
      const tw = list[i];
      if (t < tw.start) continue;
      if (!tw.started) {
        tw.started = true;
        tw.onStart?.();
      }
      let raw = (t - tw.start) / tw.dur;
      if (raw >= 1) raw = 1;
      tw.fn(tw.ease(raw), raw);
      if (raw >= 1) {
        list[i] = list[list.length - 1];
        list.pop();
        i--;
        tw.resolve();
      }
    }
  }

  /** jump every tween to its end state and resolve it */
  finishAll(): void {
    // tweens resolved here may schedule new ones through promise callbacks (async), which is fine
    const list = this.list;
    this.list = [];
    for (const tw of list) {
      if (!tw.started) tw.onStart?.();
      tw.fn(tw.ease(1), 1);
      tw.resolve();
    }
  }

  clear(): void {
    this.list.length = 0;
  }
}

function noop(): void {}

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
