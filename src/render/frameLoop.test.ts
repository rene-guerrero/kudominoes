import { describe, it, expect, vi } from 'vitest';
import { FrameLoop } from './frameLoop';
import { Animator } from './tween';
import { layoutChain } from './chainLayout';
import type { PlacedTile } from '../contracts';

/** a fake requestAnimationFrame: callbacks run on step() */
function fakeRaf() {
  let next = 1;
  const pending = new Map<number, (now: number) => void>();
  let now = 0;
  return {
    raf: (cb: (now: number) => void) => {
      const id = next++;
      pending.set(id, cb);
      return id;
    },
    caf: (id: number) => void pending.delete(id),
    get pending() {
      return pending.size;
    },
    step(ms = 16) {
      now += ms;
      const list = [...pending.values()];
      pending.clear();
      for (const cb of list) cb(now);
    },
  };
}

describe('FrameLoop', () => {
  it('a kick() during a frame never starts a second chain (quality change from frame telemetry)', () => {
    const f = fakeRaf();
    let frames = 0;
    let loop!: FrameLoop;
    loop = new FrameLoop({
      frame: () => {
        frames++;
        loop.kick(); // e.g. setQuality() → kick() from onFrameStats inside the frame
        return true;
      },
      canRun: () => true,
      raf: f.raf,
      caf: f.caf,
    });
    loop.kick();
    for (let i = 0; i < 10; i++) {
      f.step();
      expect(f.pending).toBe(1);
    }
    expect(frames).toBe(10);
  });

  it('a kick() during the last frame keeps the loop going one more frame', () => {
    const f = fakeRaf();
    let n = 0;
    let loop!: FrameLoop;
    loop = new FrameLoop({
      frame: () => {
        n++;
        if (n === 1) loop.kick();
        return false;
      },
      canRun: () => true,
      raf: f.raf,
      caf: f.caf,
    });
    loop.kick();
    f.step();
    expect(f.pending).toBe(1);
    f.step();
    expect(f.pending).toBe(0);
    expect(loop.scheduled).toBe(false);
  });

  it('a frame that throws does not end the loop (pending animations keep running)', () => {
    const f = fakeRaf();
    const errs: unknown[] = [];
    let n = 0;
    const loop = new FrameLoop({
      frame: () => {
        n++;
        if (n === 2) throw new Error('boom');
        return n < 5;
      },
      canRun: () => true,
      onError: (e) => errs.push(e),
      raf: f.raf,
      caf: f.caf,
    });
    loop.kick();
    for (let i = 0; i < 8; i++) f.step();
    expect(n).toBe(5);
    expect(errs.length).toBe(1);
    expect(loop.scheduled).toBe(false);
  });

  it('keeps failing → onFatal once, then stops spinning', () => {
    const f = fakeRaf();
    const fatal = vi.fn();
    const loop = new FrameLoop({
      frame: () => {
        throw new Error('always');
      },
      canRun: () => true,
      onFatal: fatal,
      fatalAfter: 5,
      raf: f.raf,
      caf: f.caf,
    });
    loop.kick();
    for (let i = 0; i < 20; i++) f.step();
    expect(fatal).toHaveBeenCalledTimes(1);
    expect(f.pending).toBe(0);
  });

  it('a frame cap that skips every other frame does not hide a frame that always fails when it renders', () => {
    const f = fakeRaf();
    const fatal = vi.fn();
    let k = 0;
    const loop = new FrameLoop({
      frame: () => {
        if (k++ % 2 === 0) return true; // capped: nothing rendered
        throw new Error('render fails');
      },
      canRun: () => true,
      onFatal: fatal,
      fatalAfter: 5,
      raf: f.raf,
      caf: f.caf,
    });
    loop.kick();
    for (let i = 0; i < 30; i++) f.step();
    expect(fatal).toHaveBeenCalledTimes(1);
  });

  it('cancel() while paused; kick() is a no-op until it may run again', () => {
    const f = fakeRaf();
    let paused = false;
    const loop = new FrameLoop({ frame: () => true, canRun: () => !paused, raf: f.raf, caf: f.caf });
    loop.kick();
    paused = true;
    loop.cancel();
    loop.kick();
    expect(f.pending).toBe(0);
    paused = false;
    loop.kick();
    expect(f.pending).toBe(1);
  });
});

describe('FrameLoop rAF stall', () => {
  it('a frame that requestAnimationFrame never delivers runs from the stall timer', () => {
    const f = fakeRaf();
    const timers = new Map<number, () => void>();
    let tid = 1;
    let frames = 0;
    let fromTimer = 0;
    let loop!: FrameLoop;
    loop = new FrameLoop({
      frame: () => {
        frames++;
        if (loop.fromTimer) fromTimer++;
        return frames < 4;
      },
      canRun: () => true,
      raf: f.raf,
      caf: f.caf,
      stallMs: 400,
      setTimer: (cb) => (timers.set(tid, cb), tid++),
      clearTimer: (id) => void timers.delete(id),
      now: () => 0,
    });
    loop.kick();
    // rAF stalls: only the timers fire
    for (let i = 0; i < 10 && timers.size; i++) {
      const [id, cb] = [...timers.entries()][0];
      timers.delete(id);
      cb();
    }
    expect(frames).toBe(4);
    expect(fromTimer).toBe(4);
    expect(f.pending).toBe(0); // the stalled rAF requests were cancelled
    expect(loop.scheduled).toBe(false);
  });

  it('frames delivered by rAF clear the stall timer', () => {
    const f = fakeRaf();
    const timers = new Map<number, () => void>();
    let tid = 1;
    const loop = new FrameLoop({
      frame: () => true,
      canRun: () => true,
      raf: f.raf,
      caf: f.caf,
      setTimer: (cb) => (timers.set(tid, cb), tid++),
      clearTimer: (id) => void timers.delete(id),
    });
    loop.kick();
    for (let i = 0; i < 5; i++) f.step();
    expect(timers.size).toBe(1); // only the one for the frame now pending
    loop.cancel();
    expect(timers.size).toBe(0);
  });
});

describe('Animator robustness', () => {
  it('a tween that throws ends (resolves) instead of failing every frame', async () => {
    const a = new Animator();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let done = false;
    void a
      .tween(1, () => {
        throw new Error('bad tween');
      })
      .then(() => (done = true));
    a.update(0.1);
    await Promise.resolve();
    expect(done).toBe(true);
    expect(a.active).toBe(false);
    err.mockRestore();
  });

  it('a NaN / negative dt never poisons the clock', async () => {
    const a = new Animator();
    let done = false;
    void a.wait(0.5).then(() => (done = true));
    a.update(NaN);
    a.update(-3);
    a.update(Infinity);
    expect(Number.isFinite(a.time)).toBe(true);
    a.update(0.6);
    await Promise.resolve();
    expect(done).toBe(true);
  });
});

describe('layoutChain bounds', () => {
  it('returns (no endless scan) for a zero-sized / NaN area', () => {
    const tile = { id: 27, a: 6, b: 6 } as const;
    const chain: PlacedTile[] = [{ tile, seat: 0, side: 'right', outer: 6 }];
    for (const b of [
      { cx: 0, cz: 0, w: 0, h: 0 },
      { cx: NaN, cz: NaN, w: NaN, h: NaN },
    ]) {
      const r = layoutChain(chain, b);
      expect(r.poses.length).toBe(1);
    }
    const r2 = layoutChain(chain, { cx: 0, cz: 0, w: 10, h: 10 }, { maxCell: NaN });
    expect(r2.poses.length).toBe(1);
    const r3 = layoutChain(chain, { cx: 0, cz: 0, w: 10, h: 10 }, { maxCell: 1, minCell: -1 });
    expect(r3.poses.length).toBe(1);
  });
});
