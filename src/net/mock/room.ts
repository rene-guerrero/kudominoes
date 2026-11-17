/**
 * DEV ONLY — an in-browser room that implements src/net/protocol.ts with the real engine, so the online
 * UI can be built and clicked through without the Cloudflare server. Behaviour follows the agreed
 * design: authoritative state, per-seat redaction, 30 s turn timer (a CPU plays on timeout), CPUs fill
 * empty seats and cover dropped players after a grace period, host-only lobby controls, rematch.
 * It is NOT the real server; keep it simple.
 */
import type { GameEvent, GameMode, MatchState, Move, RuleSettings, Seat } from '../../contracts';
import { SEATS_FOR } from '../../contracts';
import { engine } from '../../engine';
import { profileOf, ROSTER } from '../../roster';
import { redactEvents, redactMatch } from '../redact';
import {
  COVER_LEVEL,
  DISCONNECT_GRACE_MS,
  MAX_NAME_LENGTH,
  PROTOCOL_VERSION,
  QUICK_PHRASES,
  TURN_TIMEOUT_MS,
  type ClientMsg,
  type PublicRoom,
  type SeatOccupant,
  type SeatView,
  type ServerMsg,
} from '../protocol';

/** the mock server's clock runs ahead of the browser's, to exercise the client's clock offset */
export const MOCK_SKEW_MS = 2500;
const now = () => Date.now() + MOCK_SKEW_MS;
const NEXT_HAND_MS = 7000;

export interface MockSocket {
  send(msg: ServerMsg): void;
  close(): void;
}

interface Member {
  pid: string;
  name: string;
  face: number;
  seat: Seat | null;
  socks: Set<MockSocket>;
  covering: boolean;
  graceTimer: ReturnType<typeof setTimeout> | null;
}

const sameMove = (a: Move, b: Move) =>
  a.kind === b.kind && a.seat === b.seat && (a.kind !== 'play' || (b.kind === 'play' && a.tileId === b.tileId && a.side === b.side));

export class MockRoom {
  phase: PublicRoom['phase'] = 'lobby';
  hostId = '';
  mode: GameMode = 'pairs';
  playerCount = 4;
  seats: SeatOccupant[] = [{ kind: 'empty' }, { kind: 'empty' }, { kind: 'empty' }, { kind: 'empty' }];
  rules: RuleSettings = { ...engine.DEFAULT_RULES };
  match: MatchState | null = null;
  private members = new Map<string, Member>();
  private sockPid = new Map<MockSocket, string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private turn: { seat: Seat; deadline: number; choosing: boolean; human: boolean } | null = null;
  private lastPhrase = new Map<string, number>();
  /** the room is gone (everyone left): the hub forgets it */
  onEmpty: (() => void) | null = null;

  constructor(readonly code: string) {}

  // ───────── connections ─────────

  attach(sock: MockSocket): void {
    this.sockPid.set(sock, '');
  }

  detach(sock: MockSocket): void {
    const pid = this.sockPid.get(sock);
    this.sockPid.delete(sock);
    if (!pid) return;
    const m = this.members.get(pid);
    if (!m) return;
    m.socks.delete(sock);
    if (m.socks.size) return;
    if (this.phase === 'lobby') {
      // in the lobby a dropped player keeps the seat for a while, then frees it
      m.graceTimer = setTimeout(() => this.removeMember(pid), 60_000);
    } else {
      m.graceTimer = setTimeout(() => {
        m.graceTimer = null;
        m.covering = true;
        this.broadcastRoom();
        if (this.turn && this.turn.human && m.seat === this.turn.seat) this.cover(m.seat, 'disconnected');
      }, DISCONNECT_GRACE_MS);
    }
    this.broadcastRoom();
  }

  receive(sock: MockSocket, raw: string): void {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw) as ClientMsg;
    } catch {
      return sock.send({ t: 'error', code: 'bad_request' });
    }
    if (msg.t === 'ping') return sock.send({ t: 'pong', at: msg.at, serverNow: now() });
    if (msg.t === 'hello') return this.hello(sock, msg);
    const pid = this.sockPid.get(sock);
    const m = pid ? this.members.get(pid) : undefined;
    if (!m) return sock.send({ t: 'error', code: 'bad_request', message: 'hello first' });
    const host = m.pid === this.hostId;
    const notHost = () => sock.send({ t: 'error', code: 'not_host' });
    switch (msg.t) {
      case 'sit':
        if (this.phase !== 'lobby') return sock.send({ t: 'error', code: 'bad_request' });
        return this.sit(m, msg.seat);
      case 'setCpu':
        if (!host) return notHost();
        if (this.phase !== 'lobby' || this.seats[msg.seat]?.kind === 'human') return sock.send({ t: 'error', code: 'bad_request' });
        this.seats[msg.seat] = msg.characterId ? { kind: 'cpu', characterId: msg.characterId } : { kind: 'empty' };
        return this.broadcastRoom();
      case 'setMode':
        if (!host) return notHost();
        return this.setMode(msg.mode, msg.playerCount);
      case 'setRules':
        if (!host) return notHost();
        this.rules = { ...msg.rules };
        return this.broadcastRoom();
      case 'start':
      case 'rematch':
        if (!host) return notHost();
        if (this.phase === 'playing') return sock.send({ t: 'error', code: 'bad_request' });
        return this.startMatch();
      case 'move':
        return this.humanMove(sock, m, msg.move);
      case 'chooseStarter':
        return this.humanChoose(sock, m, msg.seat);
      case 'starterWish': {
        const tt = this.turn;
        if (!tt?.choosing || !tt.human || m.seat === null || m.seat !== ((tt.seat + 2) & 3)) return sock.send({ t: 'error', code: 'not_your_turn' });
        for (const [s] of this.socketsOf()) s.send({ t: 'starterWish', seat: m.seat, wants: !!msg.wants });
        return;
      }
      case 'phrase': {
        if (m.seat === null || !(QUICK_PHRASES as readonly string[]).includes(msg.id)) return;
        const last = this.lastPhrase.get(m.pid) ?? 0;
        if (Date.now() - last < 1200) return sock.send({ t: 'error', code: 'rate_limited' });
        this.lastPhrase.set(m.pid, Date.now());
        return this.broadcast({ t: 'phrase', seat: m.seat, id: msg.id });
      }
      case 'leave':
        this.sockPid.delete(sock);
        m.socks.delete(sock);
        return this.removeMember(m.pid);
    }
  }

  private hello(sock: MockSocket, msg: Extract<ClientMsg, { t: 'hello' }>): void {
    if (msg.v !== PROTOCOL_VERSION) {
      sock.send({ t: 'error', code: 'version_mismatch' });
      return sock.close();
    }
    let m = this.members.get(msg.playerId);
    if (!m) {
      const free = this.activeSeats().find((s) => this.seats[s].kind !== 'human');
      if (this.phase !== 'lobby' || (free === undefined && this.members.size >= 4)) {
        sock.send({ t: 'error', code: 'room_full' });
        return sock.close();
      }
      m = { pid: msg.playerId, name: '', face: 0, seat: null, socks: new Set(), covering: false, graceTimer: null };
      this.members.set(m.pid, m);
      if (!this.hostId) this.hostId = m.pid;
      const empty = this.activeSeats().find((s) => this.seats[s].kind === 'empty') ?? free;
      if (empty !== undefined) this.seatMember(m, empty);
    }
    m.name = String(msg.name || '').slice(0, MAX_NAME_LENGTH) || 'Jugador';
    m.face = Math.max(0, Math.min(8, msg.face | 0));
    if (m.graceTimer) clearTimeout(m.graceTimer);
    m.graceTimer = null;
    m.covering = false;
    m.socks.add(sock);
    this.sockPid.set(sock, m.pid);
    if (m.seat !== null) this.seats[m.seat] = this.occupant(m);
    sock.send({ t: 'welcome', you: { playerId: m.pid, seat: m.seat, isHost: m.pid === this.hostId }, room: this.publicRoom(), view: this.viewFor(m.seat) });
    this.broadcastRoom(sock);
  }

  private occupant(m: Member): SeatOccupant {
    return { kind: 'human', playerId: m.pid, name: m.name, face: m.face, connected: m.socks.size > 0, cpuCovering: m.covering };
  }

  private seatMember(m: Member, s: Seat): void {
    if (m.seat !== null) this.seats[m.seat] = { kind: 'empty' };
    m.seat = s;
    this.seats[s] = this.occupant(m);
  }

  private sit(m: Member, s: Seat | null): void {
    if (s === null) {
      if (m.seat !== null) this.seats[m.seat] = { kind: 'empty' };
      m.seat = null;
    } else {
      if (!this.activeSeats().includes(s) || this.seats[s].kind === 'human') return;
      const target = this.seats[s];
      const from = m.seat;
      this.seatMember(m, s);
      if (from !== null && from !== s) this.seats[from] = target; // swap places with the CPU

    }
    this.broadcastRoom();
  }

  private removeMember(pid: string): void {
    const m = this.members.get(pid);
    if (!m) return;
    if (m.graceTimer) clearTimeout(m.graceTimer);
    this.members.delete(pid);
    for (const s of m.socks) s.close();
    if (m.seat !== null) {
      // mid-match the seat is taken over by a CPU for good
      if (this.phase === 'lobby') this.seats[m.seat] = { kind: 'empty' };
      else this.seats[m.seat] = { kind: 'cpu', characterId: this.spareCharacter() };
      if (this.turn && this.turn.seat === m.seat && this.turn.human) this.cover(m.seat, 'disconnected');
    }
    if (this.hostId === pid) {
      const next = [...this.members.values()].find((x) => x.socks.size > 0) ?? [...this.members.values()][0];
      this.hostId = next?.pid ?? '';
    }
    if (!this.members.size) {
      this.stopTimer();
      this.onEmpty?.();
      return;
    }
    this.broadcastRoom();
  }

  private setMode(mode: GameMode, count: number): void {
    if (this.phase === 'playing') return;
    this.mode = mode;
    this.playerCount = mode === 'pairs' ? 4 : Math.max(2, Math.min(4, count | 0));
    if (this.rules && mode === 'individual' && engine.DEFAULT_RULES_INDIVIDUAL && !('boneyardDraw' in this.rules)) this.rules = { ...engine.DEFAULT_RULES_INDIVIDUAL };
    if (mode === 'pairs' && 'boneyardDraw' in this.rules) this.rules = { ...engine.DEFAULT_RULES };
    const act = this.activeSeats();
    for (const s of [0, 1, 2, 3] as Seat[]) {
      if (act.includes(s)) continue;
      const o = this.seats[s];
      if (o.kind === 'human') {
        const m = this.members.get(o.playerId)!;
        const free = act.find((x) => this.seats[x].kind !== 'human');
        this.seats[s] = { kind: 'empty' };
        m.seat = null;
        if (free !== undefined) this.seatMember(m, free);
      } else this.seats[s] = { kind: 'empty' };
    }
    this.broadcastRoom();
  }

  private activeSeats(): Seat[] {
    return this.mode === 'pairs' ? [0, 1, 2, 3] : SEATS_FOR[this.playerCount as 2 | 3 | 4].slice();
  }

  private spareCharacter(): string {
    const used = new Set(this.seats.filter((o) => o.kind === 'cpu').map((o) => (o as { characterId: string }).characterId));
    const pool = ROSTER.map((c) => c.id).filter((id) => !used.has(id));
    return pool[Math.floor(Math.random() * pool.length)] ?? 'carlos';
  }

  publicRoom(): PublicRoom {
    for (const m of this.members.values()) if (m.seat !== null) this.seats[m.seat] = this.occupant(m);
    return {
      code: this.code,
      phase: this.phase,
      hostId: this.hostId,
      mode: this.mode,
      playerCount: this.playerCount,
      seats: this.seats.map((o) => ({ ...o })),
      rules: { ...this.rules },
      scores: this.match ? (this.mode === 'individual' ? (this.match.seatScores ?? [0, 0, 0, 0]).slice() : this.match.scores.slice()) : null,
    };
  }

  private viewFor(seat: Seat | null): SeatView | null {
    if (seat === null || !this.match || this.phase === 'lobby') return null;
    const r = redactMatch(this.match, seat);
    const mine = this.turn && this.turn.seat === seat && !this.turn.choosing && this.turn.human;
    return {
      seat,
      match: r.match,
      handCounts: r.handCounts,
      pozoCount: r.pozoCount,
      legal: mine && this.match.hand && !this.match.hand.over ? engine.legalMoves(this.match) : [],
      turnDeadline: this.turn ? this.turn.deadline : null,
    };
  }

  // ───────── broadcast ─────────

  private socketsOf(): [MockSocket, Member][] {
    const out: [MockSocket, Member][] = [];
    for (const m of this.members.values()) for (const s of m.socks) out.push([s, m]);
    return out;
  }

  private broadcast(msg: ServerMsg, except?: MockSocket): void {
    for (const [s] of this.socketsOf()) if (s !== except) s.send(msg);
  }

  private broadcastRoom(except?: MockSocket): void {
    const room = this.publicRoom();
    // (clients read their own seat and the host from room.seats / room.hostId)
    for (const [s] of this.socketsOf()) if (s !== except) s.send({ t: 'room', room });
  }

  private broadcastEvents(events: GameEvent[]): void {
    for (const [s, m] of this.socketsOf()) {
      if (m.seat === null) continue;
      s.send({ t: 'events', events: redactEvents(events, m.seat) });
    }
  }

  // ───────── game ─────────

  private stopTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private startMatch(): void {
    const act = this.activeSeats();
    if (!act.some((s) => this.seats[s].kind === 'human')) return;
    for (const s of act) if (this.seats[s].kind === 'empty') this.seats[s] = { kind: 'cpu', characterId: this.spareCharacter() };
    this.match = this.mode === 'individual' ? engine.createMatch(this.rules, undefined, { mode: 'individual', players: this.playerCount as 2 | 3 | 4 }) : engine.createMatch(this.rules);
    this.phase = 'playing';
    this.turn = null;
    this.broadcastRoom();
    this.nextHand();
  }

  private nextHand(): void {
    if (!this.match) return;
    const r = engine.startHand(this.match);
    this.match = r.match;
    this.broadcastEvents(r.events);
    this.advance();
  }

  private humanAt(s: Seat): Member | null {
    const o = this.seats[s];
    if (o.kind !== 'human') return null;
    return this.members.get(o.playerId) ?? null;
  }

  private advance(): void {
    this.stopTimer();
    const m = this.match;
    if (!m) return;
    if (m.over) {
      this.turn = null;
      this.phase = 'finished';
      this.broadcastRoom();
      return;
    }
    const h = m.hand;
    if (!h || h.over) {
      this.turn = null;
      this.timer = setTimeout(() => this.nextHand(), NEXT_HAND_MS);
      return;
    }
    if (h.pendingStarterChoice != null) {
      const team = h.pendingStarterChoice;
      const order = ([h.turn, ((h.turn + 2) & 3) as Seat] as Seat[]).filter((s) => (s & 1) === team);
      const human = order.find((s) => {
        const mm = this.humanAt(s);
        return mm && mm.socks.size > 0 && !mm.covering;
      });
      if (human !== undefined) {
        const deadline = now() + TURN_TIMEOUT_MS;
        this.turn = { seat: human, deadline, choosing: true, human: true };
        const partner = ((human + 2) & 3) as Seat;
        const partnerCpu = this.seats[partner].kind === 'cpu';
        for (const [s, x] of this.socketsOf())
          s.send({
            t: 'turn',
            seat: human,
            deadline,
            legal: [],
            choosingStarter: true,
            starterTeam: team,
            starterChooser: human,
            ...(partnerCpu && x.seat === human && engine.starterPreference ? { partnerWants: engine.starterPreference(m, partner) } : {}),
          });
        this.timer = setTimeout(() => this.applyChoice(engine.cpuStarter!(m)), TURN_TIMEOUT_MS);
      } else {
        this.turn = { seat: h.turn, deadline: now() + 1500, choosing: true, human: false };
        this.timer = setTimeout(() => this.applyChoice(engine.cpuStarter!(m)), 1200);
      }
      return;
    }
    const seat = h.turn;
    const legal = engine.legalMoves(m);
    const mm = this.humanAt(seat);
    const human = !!mm && !mm.covering;
    const deadline = now() + (human ? TURN_TIMEOUT_MS : 2500);
    this.turn = { seat, deadline, choosing: false, human };
    for (const [s, x] of this.socketsOf()) s.send({ t: 'turn', seat, deadline, legal: human && x.seat === seat ? legal : [] });
    if (human) {
      this.timer = setTimeout(() => this.cover(seat, 'timeout'), TURN_TIMEOUT_MS);
    } else {
      const forced = legal.length === 1;
      const ms = legal[0]?.kind === 'draw' ? 350 : forced ? 700 : 900 + Math.random() * 900;
      this.timer = setTimeout(() => this.cpuMove(seat), ms);
    }
  }

  private cpuMove(seat: Seat): void {
    const m = this.match;
    if (!m || !m.hand || m.hand.turn !== seat) return;
    const o = this.seats[seat];
    const pr = o.kind === 'cpu' ? profileOf(o.characterId) : { level: COVER_LEVEL, style: undefined };
    let move = engine.chooseMove(m, pr.level, pr.style);
    const legal = engine.legalMoves(m);
    if (!legal.some((x) => sameMove(x, move))) move = legal[0];
    this.apply(move);
  }

  private cover(seat: Seat, reason: 'timeout' | 'disconnected'): void {
    const m = this.match;
    if (!m) return;
    this.stopTimer();
    if (this.turn?.choosing) {
      this.broadcast({ t: 'covered', seat, reason });
      return this.applyChoice(engine.cpuStarter!(m));
    }
    if (!m.hand || m.hand.turn !== seat) return;
    this.broadcast({ t: 'covered', seat, reason });
    const move = engine.chooseMove(m, COVER_LEVEL);
    const legal = engine.legalMoves(m);
    this.apply(legal.some((x) => sameMove(x, move)) ? move : legal[0]);
  }

  private apply(move: Move): void {
    if (!this.match) return;
    const r = engine.applyMove(this.match, move);
    this.match = r.match;
    this.turn = null;
    this.broadcastEvents(r.events);
    if (r.events.some((e) => e.type === 'handEnd')) this.broadcastRoom();
    this.advance();
  }

  private applyChoice(seat: Seat): void {
    if (!this.match?.hand || this.match.hand.pendingStarterChoice == null) return;
    this.stopTimer();
    this.match = engine.chooseStarter!(this.match, seat);
    this.turn = null;
    this.advance();
  }

  private humanMove(sock: MockSocket, m: Member, move: Move): void {
    const match = this.match;
    if (this.phase !== 'playing' || !match?.hand || m.seat === null) return sock.send({ t: 'error', code: 'bad_request' });
    if (match.hand.turn !== m.seat || !this.turn || this.turn.choosing || !this.turn.human) return sock.send({ t: 'error', code: 'not_your_turn' });
    const legal = engine.legalMoves(match);
    const found = legal.find((x) => sameMove(x, move));
    if (!found) return sock.send({ t: 'error', code: 'bad_move' });
    this.stopTimer();
    this.apply(move.kind === 'play' && move.slam && found.kind === 'play' ? { ...found, slam: true } : found);
  }

  private humanChoose(sock: MockSocket, m: Member, seat: Seat): void {
    const h = this.match?.hand;
    if (!h || h.pendingStarterChoice == null || !this.turn?.choosing || m.seat === null || m.seat !== this.turn.seat) return sock.send({ t: 'error', code: 'not_your_turn' });
    if ((seat & 1) !== h.pendingStarterChoice) return sock.send({ t: 'error', code: 'bad_request' });
    this.applyChoice(seat);
  }
}
