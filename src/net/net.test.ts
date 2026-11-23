import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameEvent, MatchState, Seat } from '../contracts';
import { engine } from '../engine';
import { Perspective } from './perspective';
import { applyEvent, emptyMatch } from './mirror';
import { redactEvents, redactMatch, withPlaceholders } from './redact';
import { RoomClient, type Backend, type Conn } from './client';
import { HIDDEN_TILE, PROTOCOL_VERSION, type ClientMsg, type SeatView, type ServerMsg } from './protocol';
import { normalizeCode, filterCodeChars } from './identity';
import { MockRoom, type MockSocket } from './mock/room';

describe('perspective', () => {
  it('4 players: a rotation that keeps me at seat 0; odd seats swap teams', () => {
    const p = new Perspective(1, 'pairs', [0, 1, 2, 3]);
    expect([0, 1, 2, 3].map((s) => p.seat(s as Seat))).toEqual([3, 0, 1, 2]);
    expect(p.server(0)).toBe(1);
    expect(p.scores([10, 40])).toEqual([40, 10]);
    expect(p.team(0)).toBe(1);
    expect(p.perSeat(['a', 'b', 'c', 'd'])).toEqual(['b', 'c', 'd', 'a']);
    const even = new Perspective(2, 'pairs', [0, 1, 2, 3]);
    expect(even.scores([10, 40])).toEqual([10, 40]);
  });

  it('3 players keep bottom / right / left and the turn order', () => {
    // server seats in play [0, 1, 3]; I am seat 1
    const p = new Perspective(1, 'individual', [0, 1, 3]);
    expect(p.seat(1)).toBe(0);
    expect(p.seat(3)).toBe(1);
    expect(p.seat(0)).toBe(3);
    expect(p.localSeats()).toEqual([0, 1, 3]);
  });

  it('2 players: the other one sits across', () => {
    const p = new Perspective(2, 'individual', [0, 2]);
    expect(p.seat(2)).toBe(0);
    expect(p.seat(0)).toBe(2);
  });

  it('moves go out with my server seat and come back as seat 0', () => {
    const p = new Perspective(3, 'pairs', [0, 1, 2, 3]);
    const m = p.move({ kind: 'play', seat: 3, tileId: 5, side: 'left' });
    expect(m.seat).toBe(0);
    expect(p.moveToServer({ kind: 'play', seat: 0, tileId: 5, side: 'left', slam: true })).toEqual({ kind: 'play', seat: 3, tileId: 5, side: 'left', slam: true });
  });

  it('individual: human-centric team fields are recomputed for me', () => {
    const p = new Perspective(2, 'individual', [0, 1, 2, 3]);
    const ev = {
      type: 'handEnd',
      reason: 'domino',
      winnerSeat: 2,
      winnerTeam: 1, // server: "not seat 0"
      points: 20,
      bonuses: [{ id: 'x', label: { es: '', en: '' }, points: 5, team: 1, seat: 2 }],
      pipCounts: [1, 2, 0, 4],
      remaining: [[], [], [], []],
      scores: [0, 0],
      seatScores: [0, 0, 25, 0],
    } as unknown as GameEvent;
    const out = p.event(ev) as Extract<GameEvent, { type: 'handEnd' }>;
    expect(out.winnerSeat).toBe(0);
    expect(out.winnerTeam).toBe(0);
    expect(out.bonuses[0]).toMatchObject({ seat: 0, team: 0 });
    expect(out.seatScores).toEqual([25, 0, 0, 0]);
    expect(out.pipCounts).toEqual([0, 4, 1, 2]);
  });
});

describe('redaction and the client mirror', () => {
  it('other hands and the boneyard become placeholders; others draw nothing visible', () => {
    let m = engine.createMatch(engine.DEFAULT_RULES_INDIVIDUAL!, 7, { mode: 'individual', players: 2 });
    const r = engine.startHand(m);
    m = r.match;
    const red = redactEvents(r.events, 0);
    const hs = red.find((e) => e.type === 'handStart') as Extract<GameEvent, { type: 'handStart' }>;
    expect(hs.hands[0].every((t) => t.id >= 0)).toBe(true);
    expect(hs.hands[2].every((t) => t.id === HIDDEN_TILE.id)).toBe(true);
    expect(hs.hands[2].length).toBe(r.match.hand!.hands[2].length);
    expect(hs.boneyard?.every((t) => t.id === -1)).toBe(true);
    const draw: GameEvent = { type: 'draw', seat: 2, tile: { id: 3, a: 0, b: 3 }, boneyardLeft: 10, ends: { left: 0, right: 0 } };
    expect((redactEvents([draw], 0)[0] as Extract<GameEvent, { type: 'draw' }>).tile.id).toBe(-1);
    expect((redactEvents([draw], 2)[0] as Extract<GameEvent, { type: 'draw' }>).tile.id).toBe(3);
  });

  it('a seat view round-trips into a full-shaped state with placeholders', () => {
    let m = engine.createMatch(engine.DEFAULT_RULES, 3);
    m = engine.startHand(m).match;
    const r = redactMatch(m, 1);
    expect(r.match.hand!.hands[0]).toEqual([]);
    const view: SeatView = { seat: 1, match: r.match, handCounts: r.handCounts, pozoCount: r.pozoCount, legal: [], turnDeadline: null };
    const full = withPlaceholders(view);
    expect(full.hand!.hands.map((x) => x.length)).toEqual(m.hand!.hands.map((x) => x.length));
    expect(full.hand!.hands[1]).toEqual(m.hand!.hands[1]);
    expect(full.hand!.hands[0].every((t) => t.id === -1)).toBe(true);
  });

  it('a seat view does not leak the engine’s double-nine set-aside ids', () => {
    let m = engine.createMatch({ ...engine.DEFAULT_RULES, tileSet: 'double9' as const }, 7);
    m = engine.startHand(m).match;
    expect((m.hand as { setAsideIds?: number[] } | null)?.setAsideIds).toHaveLength(15);
    const r = redactMatch(m, 1);
    expect(r.match.hand).not.toHaveProperty('setAsideIds');
  });

  it('the mirror follows a whole match played by CPUs (counts, chain, scores)', () => {
    for (const me of [0, 1, 2, 3] as Seat[]) {
      let m: MatchState = engine.createMatch(engine.DEFAULT_RULES, 11 + me);
      const p = new Perspective(me, 'pairs', [0, 1, 2, 3]);
      let mirror = emptyMatch(m.rules, 'pairs', p.localSeats());
      let guard = 0;
      while (!m.over && guard++ < 2000) {
        let evs: GameEvent[];
        if (!m.hand || m.hand.over) {
          const r = engine.startHand(m);
          m = r.match;
          evs = r.events;
          if (m.hand!.pendingStarterChoice != null) m = engine.chooseStarter!(m, engine.cpuStarter!(m));
        } else {
          const r = engine.applyMove(m, engine.chooseMove(m, 'normal'));
          m = r.match;
          evs = r.events;
        }
        for (const e of redactEvents(evs, me)) mirror = applyEvent(mirror, p.event(e));
        // what I see matches the server, from my seat
        expect(mirror.scores).toEqual(p.scores(m.scores));
        if (m.hand && !m.hand.over) {
          for (const l of [0, 1, 2, 3] as Seat[]) expect(mirror.hand!.hands[l].length).toBe(m.hand.hands[p.server(l)].length);
          expect(mirror.hand!.hands[0].map((t) => t.id).sort()).toEqual(m.hand.hands[me].map((t) => t.id).sort());
          expect(mirror.hand!.chain.length).toBe(m.hand.chain.length);
        }
      }
      expect(m.over).toBe(true);
      expect(mirror.over).toBe(true);
      expect(mirror.handsWon).toEqual(p.scores(m.handsWon));
    }
  });
});

describe('room codes', () => {
  it('normalises typed and pasted codes', () => {
    expect(normalizeCode('kudo-7kqm')).toBe('7KQM');
    expect(normalizeCode(' 7kqm ')).toBe('7KQM');
    expect(normalizeCode('7KQ')).toBe('');
    expect(filterCodeChars('a0o1bc')).toBe('ABC');
  });
});

// ───────────────────────── connection manager ─────────────────────────

class FakeConn implements Conn {
  sent: ClientMsg[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((d: string) => void) | null = null;
  onclose: ((c: number) => void) | null = null;
  closed = false;
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close() {
    this.closed = true;
  }
  serverSays(m: ServerMsg) {
    this.onmessage?.(JSON.stringify(m));
  }
}

describe('RoomClient', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const conns: FakeConn[] = [];
    const backend: Backend = {
      createRoom: async () => 'ABCD',
      roomInfo: async () => ({ exists: true }),
      connect: () => {
        const c = new FakeConn();
        conns.push(c);
        return c;
      },
    };
    const got: ServerMsg[] = [];
    const fatal: string[] = [];
    const states: string[] = [];
    const client = new RoomClient({
      backend,
      code: 'ABCD',
      identity: () => ({ playerId: 'p1', name: 'Ana', face: 2 }),
      onMessage: (m) => got.push(m),
      onFatal: (c) => fatal.push(c),
      onState: (s) => states.push(s),
      random: () => 0.5,
    });
    return { client, conns, got, fatal, states };
  };

  const room = { code: 'ABCD', phase: 'lobby', hostId: 'p1', mode: 'pairs', playerCount: 4, seats: [], rules: {}, scores: null } as never;

  it('says hello on open and passes messages on', () => {
    const { client, conns, got } = setup();
    client.start();
    conns[0].onopen!();
    expect(conns[0].sent[0]).toEqual({ t: 'hello', v: PROTOCOL_VERSION, playerId: 'p1', name: 'Ana', face: 2 });
    expect(conns[0].sent[1].t).toBe('ping');
    conns[0].serverSays({ t: 'welcome', you: { playerId: 'p1', seat: 0, isHost: true }, room, view: null });
    expect(got[0].t).toBe('welcome');
    expect(client.connState).toBe('open');
  });

  it('estimates the server clock from pongs', () => {
    const { client, conns } = setup();
    vi.setSystemTime(1_000_000);
    client.start();
    conns[0].onopen!();
    const ping = conns[0].sent.find((m) => m.t === 'ping') as { at: number };
    vi.setSystemTime(1_000_100); // 100 ms round trip
    conns[0].serverSays({ t: 'pong', at: ping.at, serverNow: 1_005_050 });
    // server was 1_005_050 at local 1_000_050 → +5000
    expect(client.clockOffset).toBe(5000);
    expect(client.toLocal(1_010_000)).toBe(1_005_000);
  });

  it('reconnects with backoff and says hello again', () => {
    const { client, conns, states } = setup();
    client.start();
    conns[0].onopen!();
    conns[0].serverSays({ t: 'welcome', you: { playerId: 'p1', seat: 0, isHost: true }, room, view: null });
    conns[0].onclose!(1006);
    expect(states).toContain('reconnecting');
    expect(conns.length).toBe(1);
    vi.advanceTimersByTime(500);
    expect(conns.length).toBe(2);
    conns[1].onopen!();
    expect(conns[1].sent[0].t).toBe('hello');
  });

  it('stops on a fatal error and never reconnects', () => {
    const { client, conns, fatal } = setup();
    client.start();
    conns[0].onopen!();
    conns[0].serverSays({ t: 'error', code: 'room_not_found' });
    expect(fatal).toEqual(['room_not_found']);
    conns[0].onclose?.(1000);
    vi.advanceTimersByTime(20_000);
    expect(conns.length).toBe(1);
    expect(client.connState).toBe('closed');
  });

  it('leave tells the server and closes for good', () => {
    const { client, conns } = setup();
    client.start();
    conns[0].onopen!();
    conns[0].serverSays({ t: 'welcome', you: { playerId: 'p1', seat: 0, isHost: true }, room, view: null });
    client.leave();
    expect(conns[0].sent.at(-1)).toEqual({ t: 'leave' });
    expect(conns[0].closed).toBe(true);
    vi.advanceTimersByTime(20_000);
    expect(conns.length).toBe(1);
  });

  it('a silent socket is dropped and replaced', () => {
    const { client, conns } = setup();
    client.start();
    conns[0].onopen!();
    vi.advanceTimersByTime(26_000);
    expect(conns[0].closed).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(conns.length).toBe(2);
  });
});

// ───────────────────────── the dev mock room ─────────────────────────

describe('mock room (dev server stand-in)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const sock = () => {
    const inbox: ServerMsg[] = [];
    const s: MockSocket & { inbox: ServerMsg[] } = { inbox, send: (m) => inbox.push(m), close: () => {} };
    return s;
  };

  it('redacts per seat, times out a silent human and plays a whole match', () => {
    const room = new MockRoom('TEST');
    const a = sock();
    const b = sock();
    room.attach(a);
    room.attach(b);
    room.receive(a, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, playerId: 'pid-A', name: 'Ana', face: 1 }));
    room.receive(b, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, playerId: 'pid-B', name: 'Beto', face: 2 }));
    const wa = a.inbox.find((m) => m.t === 'welcome') as Extract<ServerMsg, { t: 'welcome' }>;
    expect(wa.you.isHost).toBe(true);
    room.receive(a, JSON.stringify({ t: 'start' }));
    const ev = a.inbox.find((m) => m.t === 'events') as Extract<ServerMsg, { t: 'events' }>;
    const hs = ev.events[0] as Extract<GameEvent, { type: 'handStart' }>;
    const seatA = wa.you.seat!;
    for (let s = 0; s < 4; s++) expect(hs.hands[s].every((t) => (s === seatA ? t.id >= 0 : t.id === -1))).toBe(true);
    // nobody moves: timers and CPUs finish the match
    for (let i = 0; i < 400 && room.phase === 'playing'; i++) vi.advanceTimersByTime(31_000);
    expect(room.phase).toBe('finished');
    expect(a.inbox.some((m) => m.t === 'covered' && m.reason === 'timeout')).toBe(true);
    expect(b.inbox.some((m) => m.t === 'events' && m.events.some((e) => e.type === 'matchEnd'))).toBe(true);
  });
});
