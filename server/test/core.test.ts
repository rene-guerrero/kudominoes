/**
 * The room core driven end to end with a fake platform (sockets + clock): whole matches with humans
 * that answer from their 'turn' messages (or let the clock run out), checking that the game always
 * moves on and that no message ever carries a tile the receiver may not see.
 */
import { describe, expect, it } from 'vitest';
import type { GameEvent, Move, Seat } from '../../src/contracts';
import { PROTOCOL_VERSION, type ServerMsg } from '../../src/net/protocol';
import { RoomCore, type Attachment, type CoreIO, type Tunables } from '../../src/net/room/core';

interface Sock {
  id: number;
  att: Attachment | null;
  open: boolean;
  inbox: ServerMsg[];
}

const CFG: Tunables = { turnTimeoutMs: 3000, graceMs: 500, idleTtlMs: 60_000, nextHandMs: 1000, cpuSpeed: 0.2 };

function rig(seed = 1) {
  let now = 1_000_000;
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff), x / 0x7fffffff);
  const socks: Sock[] = [];
  const io: CoreIO<Sock> = {
    now: () => now,
    seed: () => (rnd() * 0x7fffffff) | 0,
    sockets: () => socks.filter((s) => s.open),
    attachment: (s) => s.att,
    setAttachment: (s, a) => (s.att = a),
    send: (s, m) => {
      if (s.open) s.inbox.push(JSON.parse(JSON.stringify(m)));
    },
    close: (s) => (s.open = false),
  };
  const core = new RoomCore(io, CFG);
  core.create('ABCD', 'pid-1');
  const open = (pid: string | null): Sock => {
    const s: Sock = { id: socks.length, att: null, open: true, inbox: [] };
    socks.push(s);
    core.accept(s, pid);
    return s;
  };
  const join = (pid: string, v = PROTOCOL_VERSION): Sock => {
    const s = open(pid);
    core.message(s, JSON.stringify({ t: 'hello', v, playerId: pid, name: pid, face: 0 }));
    return s;
  };
  const send = (s: Sock, msg: unknown) => core.message(s, JSON.stringify(msg));
  const drop = (s: Sock) => {
    s.open = false;
    core.socketGone(s);
  };
  /** let time pass, firing alarms as they come due */
  const run = (ms: number) => {
    const end = now + ms;
    for (let guard = 0; guard < 10_000; guard++) {
      const at = core.nextAlarm();
      if (at === null || at > end) break;
      now = Math.max(now, at);
      if (core.alarm() === 'deleted') break;
    }
    now = end;
  };
  return { core, open, join, send, drop, run, socks };
}

const seatOfPid = (core: RoomCore<Sock>, pid: string): Seat | null => {
  const i = core.data!.seats.findIndex((s) => s.kind === 'human' && s.playerId === pid);
  return i < 0 ? null : (i as Seat);
};

/** during a hand a client sees only its own tiles; others' hands, their draws and the pozo are id -1 */
function checkNoLeak(msg: ServerMsg, seat: Seat | null): void {
  if (msg.t === 'events') {
    for (const ev of msg.events as GameEvent[]) {
      if (ev.type === 'handStart') {
        ev.hands.forEach((h, s) => {
          if (s !== seat) expect(h.every((t) => t.id === -1)).toBe(true);
        });
        if (ev.boneyard) expect(ev.boneyard.every((t) => t.id === -1)).toBe(true);
      }
      if (ev.type === 'draw' && ev.seat !== seat) expect(ev.tile.id).toBe(-1);
    }
  }
  if (msg.t === 'turn') for (const m of msg.legal) expect(m.seat).toBe(seat);
  if (msg.t === 'welcome' && msg.view) {
    const m = msg.view.match as { rng: number; hand: { hands: unknown[][]; boneyard?: unknown[] } | null };
    expect(m.rng).toBe(0);
    if (m.hand) {
      m.hand.hands.forEach((h, s) => {
        if (s !== seat) expect(h).toEqual([]);
      });
      if (m.hand.boneyard) expect(m.hand.boneyard).toEqual([]);
    }
  }
}

/** play a whole match: humans answer from their latest 'turn' (first legal move), or idle */
function playMatch(humans: number, opts: { idle?: boolean; seed?: number; individual?: 2 | 3 | 4 } = {}) {
  const t = rig(opts.seed ?? 7);
  const pids = Array.from({ length: humans }, (_, i) => `pid-${i + 1}`);
  const socks = pids.map((p) => t.join(p));
  if (opts.individual) t.send(socks[0], { t: 'setMode', mode: 'individual', playerCount: opts.individual });
  t.send(socks[0], { t: 'start' });
  const core = t.core;
  expect(core.data!.phase).toBe('playing');
  const read = socks.map(() => 0);
  let moves = 0;
  for (let step = 0; step < 6000 && core.data!.phase === 'playing'; step++) {
    // invariant: a live match always has a timer pending (it can never stall)
    expect(core.nextAlarm()).not.toBeNull();
    socks.forEach((s, i) => {
      const seat = seatOfPid(core, pids[i]);
      for (const msg of s.inbox.slice(read[i])) checkNoLeak(msg, seat);
    });
    if (!opts.idle) {
      socks.forEach((s, i) => {
        const fresh = s.inbox.slice(read[i]);
        const turn = [...fresh].reverse().find((m) => m.t === 'turn') as Extract<ServerMsg, { t: 'turn' }> | undefined;
        if (turn?.choosingStarter && turn.starterChooser === seatOfPid(core, pids[i])) t.send(s, { t: 'chooseStarter', seat: turn.starterChooser });
        else if (turn && turn.legal.length) {
          t.send(s, { t: 'move', move: turn.legal[0] as Move });
          moves++;
        }
      });
    }
    socks.forEach((s, i) => (read[i] = s.inbox.length));
    t.run(500);
  }
  return { ...t, socks, moves };
}

describe('RoomCore', () => {
  it('plays a whole pairs match with two active humans, never leaking tiles', () => {
    const { core, socks, moves } = playMatch(2);
    expect(core.data!.phase).toBe('finished');
    expect(moves).toBeGreaterThan(5);
    expect(socks[1].inbox.some((m) => m.t === 'events' && m.events.some((e) => e.type === 'matchEnd'))).toBe(true);
  });

  it('finishes a match when nobody moves (turn timeouts are covered by a CPU)', () => {
    const { core, socks } = playMatch(2, { idle: true, seed: 3 });
    expect(core.data!.phase).toBe('finished');
    expect(socks[0].inbox.some((m) => m.t === 'covered' && m.reason === 'timeout')).toBe(true);
  });

  it('plays an individual 3-player match', () => {
    const { core } = playMatch(1, { individual: 3, seed: 11 });
    expect(core.data!.phase).toBe('finished');
  });

  it('a dropped player is covered after the grace period and takes the seat back on return', () => {
    const t = rig();
    const a = t.join('pid-1');
    const b = t.join('pid-2');
    t.send(a, { t: 'start' });
    t.drop(b);
    expect(t.core.data!.members['pid-2'].connected).toBe(false);
    t.run(CFG.graceMs + 10);
    expect(t.core.data!.members['pid-2'].cpuCovering).toBe(true);
    const b2 = t.join('pid-2');
    expect(t.core.data!.members['pid-2'].cpuCovering).toBe(false);
    const w = b2.inbox.find((m) => m.t === 'welcome') as Extract<ServerMsg, { t: 'welcome' }>;
    expect(w.you.seat).toBe(seatOfPid(t.core, 'pid-2'));
    expect(w.view).not.toBeNull();
  });

  it('a second socket of the same player replaces the first', () => {
    const t = rig();
    const a1 = t.join('pid-1');
    const a2 = t.join('pid-1');
    expect(a1.open).toBe(false);
    expect(a2.open).toBe(true);
    expect(t.core.data!.members['pid-1'].connected).toBe(true);
  });

  it('chat: quick phrases and avatar gestures are broadcast, unknown ids rejected, bursts rate limited', () => {
    const t = rig();
    const a = t.join('pid-1');
    const b = t.join('pid-2');
    t.send(a, { t: 'phrase', id: 'hello' });
    expect(b.inbox.some((m) => m.t === 'phrase' && m.id === 'hello')).toBe(true);
    t.run(1300);
    t.send(a, { t: 'phrase', id: 'g:wave' });
    expect(b.inbox.some((m) => m.t === 'phrase' && m.id === 'g:wave')).toBe(true);
    t.run(1300);
    t.send(a, { t: 'phrase', id: 'g:nope' });
    t.send(a, { t: 'phrase', id: 'insult' });
    expect(a.inbox.filter((m) => m.t === 'error' && m.code === 'bad_request').length).toBe(2);
    t.send(a, { t: 'phrase', id: 'gg' });
    t.send(a, { t: 'phrase', id: 'thanks' });
    expect(a.inbox.some((m) => m.t === 'error' && m.code === 'rate_limited')).toBe(true);
  });

  it('rejects a wrong protocol version, unknown rooms and moves out of turn', () => {
    const t = rig();
    const bad = t.join('pid-9', PROTOCOL_VERSION + 1);
    expect(bad.inbox.some((m) => m.t === 'error' && m.code === 'version_mismatch')).toBe(true);
    expect(bad.open).toBe(false);
    const a = t.join('pid-1');
    t.send(a, { t: 'move', move: { kind: 'pass', seat: 0 } });
    expect(a.inbox.some((m) => m.t === 'error' && m.code === 'not_your_turn')).toBe(true);
    const other = new RoomCore<Sock>({ now: () => 0, seed: () => 1, sockets: () => [], attachment: () => null, setAttachment: () => {}, send: (s, m) => s.inbox.push(m), close: (s) => (s.open = false) }, CFG);
    const s: Sock = { id: 0, att: null, open: true, inbox: [] };
    other.accept(s, 'pid-1');
    expect(s.inbox[0]).toEqual({ t: 'error', code: 'room_not_found' });
    expect(s.open).toBe(false);
  });

  it('only the host may start; info reports free seats', () => {
    const t = rig();
    const a = t.join('pid-1');
    const b = t.join('pid-2');
    expect(t.core.info()).toEqual({ exists: true, phase: 'lobby', freeSeats: 2 });
    t.send(b, { t: 'start' });
    expect(b.inbox.some((m) => m.t === 'error' && m.code === 'not_host')).toBe(true);
    t.send(a, { t: 'start' });
    expect(t.core.data!.phase).toBe('playing');
  });

  it('an empty room is deleted after the idle time', () => {
    const t = rig();
    const a = t.join('pid-1');
    t.drop(a);
    t.run(CFG.idleTtlMs + CFG.graceMs + 10);
    expect(t.core.data).toBeNull();
    expect(t.core.info()).toEqual({ exists: false });
  });

  it('data survives a JSON round trip (a host can save and resume it)', () => {
    const t = rig();
    const a = t.join('pid-1');
    t.join('pid-2');
    t.send(a, { t: 'start' });
    t.run(2000);
    const saved = JSON.parse(JSON.stringify(t.core.data));
    expect(saved).toEqual(t.core.data);
  });
});
