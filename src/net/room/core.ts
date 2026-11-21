/**
 * The room itself, free of any platform: lobby messages, the authoritative match, CPUs, timers and
 * per-seat redaction. Hosts wrap it:
 *  - the Durable Object (server/src/room.ts): WebSockets, storage and the alarm;
 *  - the dev mock room (src/net/mock/room.ts) and local play: in-page sockets and setTimeout.
 * So every host runs the very same logic.
 *
 * All state is `data` (one JSON value: lobby, MatchState, timer schedule). A host stores it after every
 * call and arms one timer for nextAlarm(); when it fires it calls alarm(), which processes everything
 * that came due (it is written for a host waking late, e.g. from hibernation or a backgrounded tab).
 * Only the phrase rate limiter lives outside `data` (losing it is harmless).
 */
import type { GameEvent, Move, Seat, Team } from '../../contracts';
import { applyMove, chooseStarter, cpuStarter, createMatch, legalMoves, startHand, starterPreference } from '../../engine/game';
import {
  COVER_LEVEL,
  DISCONNECT_GRACE_MS,
  PROTOCOL_VERSION,
  ROOM_IDLE_TTL_MS,
  TURN_TIMEOUT_MS,
  isChatId,
  type ClientMsg,
  type ErrorCode,
  type RoomInfoResponse,
  type ServerMsg,
} from '../protocol';
import { character, profileOf } from '../../roster';
import { cpuMove, drawDelay, markFinishing, matchLegal, maybeCpuSlam, starterDelay, thinkDelay } from './game';
import {
  autoSeat,
  connectedHumans,
  ensureHost,
  fillSeats,
  freeSeats,
  humanCount,
  isSeat,
  isValidPlayerId,
  LobbyError,
  MAX_MEMBERS,
  newRoom,
  publicRoom,
  removeMember,
  sanitizeFace,
  sanitizeName,
  seatOf,
  setCpu,
  setMode,
  setRules,
  sit,
  type RoomData,
} from './lobby';
import { redactEvents, seatView } from './redact';
import { clearGameTimer, nextAlarm, setGameTimer, takeDue } from './schedule';

export interface Tunables {
  turnTimeoutMs: number;
  graceMs: number;
  idleTtlMs: number;
  nextHandMs: number;
  cpuSpeed: number;
}

/** pause between the end of a hand and the next deal (clients show the hand summary meanwhile) */
export const NEXT_HAND_MS = 7_000;

export const DEFAULT_TUNABLES: Tunables = {
  turnTimeoutMs: TURN_TIMEOUT_MS,
  graceMs: DISCONNECT_GRACE_MS,
  idleTtlMs: ROOM_IDLE_TTL_MS,
  nextHandMs: NEXT_HAND_MS,
  cpuSpeed: 1,
};

/** per-socket identity (a Durable Object keeps it with serializeAttachment, so it survives hibernation) */
export interface Attachment {
  /** playerId from the ?pid= query (null if absent; then hello decides) */
  pid: string | null;
  hello: boolean;
}

/** what the core needs from its host platform */
export interface CoreIO<S> {
  now(): number;
  /** a random 32-bit seed for a new match */
  seed(): number;
  /** every open socket of the room */
  sockets(): S[];
  attachment(s: S): Attachment | null;
  setAttachment(s: S, a: Attachment): void;
  send(s: S, msg: ServerMsg): void;
  close(s: S, code: number, reason: string): void;
}

type Controller = 'human' | 'cover' | 'cpu';

export const MAX_FRAME = 4096;
/** phrases: at most one per PHRASE_GAP_MS and PHRASE_BURST per PHRASE_WINDOW_MS */
const PHRASE_GAP_MS = 1200;
const PHRASE_BURST = 5;
const PHRASE_WINDOW_MS = 20_000;

export class RoomCore<S> {
  private phraseLog = new Map<string, number[]>();

  constructor(
    private io: CoreIO<S>,
    private cfg: Tunables,
    public data: RoomData | null = null,
  ) {}

  // ───────────────────────── lifecycle ─────────────────────────

  /** a new room under `code` (false: the code is taken) */
  create(code: string, host: string | null): boolean {
    if (this.data) return false;
    const now = this.io.now();
    this.data = newRoom(code, now, host && isValidPlayerId(host) ? host : '');
    this.data.schedule.idle = now + this.cfg.idleTtlMs; // nobody ever joins → cleaned up
    return true;
  }

  info(): RoomInfoResponse {
    const r = this.data;
    return r ? { exists: true, phase: r.phase, freeSeats: freeSeats(r) } : { exists: false };
  }

  /** a socket opened (?pid= from the URL); a missing room answers room_not_found and closes */
  accept(s: S, pid: string | null): void {
    this.io.setAttachment(s, { pid: pid && isValidPlayerId(pid) ? pid : null, hello: false });
    if (!this.data) {
      this.io.send(s, { t: 'error', code: 'room_not_found' });
      this.io.close(s, 4004, 'room_not_found');
    }
  }

  /** when alarm() should next run (null = nothing pending) */
  nextAlarm(): number | null {
    return this.data ? nextAlarm(this.data.schedule) : null;
  }

  /** the host's timer fired: process everything due; 'deleted' = the idle room is gone (data is null) */
  alarm(): 'deleted' | void {
    const r = this.data;
    if (!r) return;
    const now = this.io.now();
    const due = takeDue(r.schedule, now);
    if (due.idle && connectedHumans(r).length === 0 && this.live().length === 0) {
      this.data = null;
      return 'deleted';
    }
    let roomChanged = false;
    for (const pid of due.grace) {
      const m = r.members[pid];
      if (!m || m.connected) continue;
      if (r.phase === 'playing' && seatOf(r, pid) !== null) m.cpuCovering = true;
      roomChanged = true;
    }
    if (due.grace.length && ensureHost(r)) roomChanged = true;
    if (roomChanged) this.broadcastRoom();
    if (due.game) this.onGameTimer(due.game.kind, due.game.key);
    this.advance();
  }

  // ───────────────────────── sockets ─────────────────────────

  /** sockets that said hello, with their player id */
  private live(except?: S): { s: S; pid: string }[] {
    const out: { s: S; pid: string }[] = [];
    for (const s of this.io.sockets()) {
      if (s === except) continue;
      const a = this.io.attachment(s);
      if (a?.hello && a.pid) out.push({ s, pid: a.pid });
    }
    return out;
  }

  private err(s: S, code: ErrorCode, message?: string): void {
    this.io.send(s, message ? { t: 'error', code, message } : { t: 'error', code });
  }

  private broadcast(make: (pid: string, seat: Seat | null) => ServerMsg | null): void {
    const r = this.data!;
    for (const { s, pid } of this.live()) {
      const msg = make(pid, seatOf(r, pid));
      if (msg) this.io.send(s, msg);
    }
  }

  private broadcastRoom(): void {
    const room = publicRoom(this.data!);
    this.broadcast(() => ({ t: 'room', room }));
  }

  private broadcastEvents(events: GameEvent[]): void {
    this.broadcast((_pid, seat) => ({ t: 'events', events: redactEvents(events, seat) }));
  }

  /** a socket closed or failed */
  socketGone(s: S): void {
    const r = this.data;
    if (!r) return;
    const a = this.io.attachment(s);
    if (!a?.hello || !a.pid) return;
    const pid = a.pid;
    const m = r.members[pid];
    if (!m || !m.connected) return;
    if (this.live(s).some((x) => x.pid === pid)) return; // another socket of theirs is open
    const now = this.io.now();
    m.connected = false;
    r.schedule.grace[pid] = now + this.cfg.graceMs;
    if (connectedHumans(r).length === 0) r.schedule.idle = now + this.cfg.idleTtlMs;
    this.broadcastRoom();
    this.advance();
  }

  // ───────────────────────── messages ─────────────────────────

  /** one frame from a socket (untrusted) */
  message(s: S, raw: unknown): void {
    if (typeof raw !== 'string' || raw.length > MAX_FRAME) return this.err(s, 'bad_request', 'frame');
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.err(s, 'bad_request', 'json');
    }
    if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') return this.err(s, 'bad_request');
    if (msg.t === 'ping') {
      this.io.send(s, { t: 'pong', at: typeof msg.at === 'number' ? msg.at : 0, serverNow: this.io.now() });
      return;
    }
    const r = this.data;
    if (!r) {
      this.io.send(s, { t: 'error', code: 'room_not_found' });
      this.io.close(s, 4004, 'room_not_found');
      return;
    }
    const att = this.io.attachment(s) ?? { pid: null, hello: false };
    try {
      if (msg.t === 'hello') this.onHello(s, att, msg);
      else {
        if (!att.hello || !att.pid || !r.members[att.pid]) return this.err(s, 'bad_request', 'say hello first');
        this.onMessage(s, att.pid, msg);
      }
    } catch (e) {
      if (e instanceof LobbyError) this.err(s, e.code, e.message);
      else {
        console.error('room error', e);
        this.err(s, 'bad_request', 'internal');
      }
    }
  }

  private onHello(s: S, att: Attachment, msg: Extract<ClientMsg, { t: 'hello' }>): void {
    const r = this.data!;
    if (msg.v !== PROTOCOL_VERSION) {
      this.err(s, 'version_mismatch', `server speaks v${PROTOCOL_VERSION}`);
      this.io.close(s, 4000, 'version_mismatch');
      return;
    }
    const pid = msg.playerId;
    if (!isValidPlayerId(pid) || (att.pid && att.pid !== pid) || (att.hello && att.pid !== pid)) {
      this.err(s, 'bad_request', 'bad playerId');
      return;
    }
    const now = this.io.now();
    let m = r.members[pid];
    if (!m) {
      if (Object.keys(r.members).length >= MAX_MEMBERS || freeSeats(r) === 0) {
        this.err(s, 'room_full');
        this.io.close(s, 4003, 'room_full');
        return;
      }
      m = { playerId: pid, name: '', face: 0, connected: false, cpuCovering: false, joinedAt: now };
      r.members[pid] = m;
      if (autoSeat(r, pid) === null && r.phase === 'playing') {
        delete r.members[pid];
        this.err(s, 'room_full');
        this.io.close(s, 4003, 'room_full');
        return;
      }
    }
    m.name = sanitizeName(msg.name);
    m.face = sanitizeFace(msg.face);
    m.connected = true;
    m.cpuCovering = false;
    delete r.schedule.grace[pid];
    r.schedule.idle = null;
    if (!r.hostId || !r.members[r.hostId]) r.hostId = pid;
    ensureHost(r);

    // this socket is now the player's; older sockets of the same player are replaced
    this.io.setAttachment(s, { pid, hello: true });
    for (const x of this.live(s)) if (x.pid === pid) this.io.close(x.s, 4001, 'replaced');

    const seat = seatOf(r, pid);
    const room = publicRoom(r);
    this.io.send(s, { t: 'welcome', you: { playerId: pid, seat, isHost: r.hostId === pid }, room, view: this.viewFor(seat) });
    for (const x of this.live(s)) this.io.send(x.s, { t: 'room', room });
    // a returning player takes their seat back from the covering CPU (new turn clock if it is theirs)
    if (!this.advance()) {
      const turn = this.turnMsgFor(pid);
      if (turn) this.io.send(s, turn);
    }
  }

  private onMessage(s: S, pid: string, msg: ClientMsg): void {
    const r = this.data!;
    switch (msg.t) {
      case 'sit':
        if (msg.seat !== null && !isSeat(msg.seat)) throw new LobbyError('bad_request');
        sit(r, pid, msg.seat);
        this.broadcastRoom();
        return;
      case 'setCpu':
        setCpu(r, pid, msg.seat, msg.characterId ?? null);
        this.broadcastRoom();
        return;
      case 'setMode':
        setMode(r, pid, msg.mode, msg.playerCount);
        this.broadcastRoom();
        return;
      case 'setRules':
        setRules(r, pid, msg.rules);
        this.broadcastRoom();
        return;
      case 'start':
      case 'rematch':
        this.startMatch(pid);
        return;
      case 'move':
        return this.onMove(s, pid, msg.move);
      case 'chooseStarter':
        return this.onChooseStarter(s, pid, msg.seat);
      case 'starterWish':
        return this.onStarterWish(s, pid, msg.wants);
      case 'phrase':
        return this.onPhrase(s, pid, msg.id);
      case 'leave':
        removeMember(r, pid);
        delete r.schedule.grace[pid];
        if (connectedHumans(r).length === 0) r.schedule.idle = this.io.now() + this.cfg.idleTtlMs;
        this.io.setAttachment(s, { pid, hello: false });
        this.io.close(s, 1000, 'left');
        this.broadcastRoom();
        this.advance();
        return;
      default:
        throw new LobbyError('bad_request', 'unknown message');
    }
  }

  private startMatch(pid: string): void {
    const r = this.data!;
    if (r.hostId !== pid) throw new LobbyError('not_host');
    if (r.phase === 'playing') throw new LobbyError('bad_request', 'already playing');
    if (humanCount(r) === 0 && !seatOf(r, pid)) {
      // the host stood up and nobody sits: put the host back at the table
      autoSeat(r, pid);
    }
    fillSeats(r);
    r.match = createMatch(r.rules, this.io.seed(), r.mode === 'individual' ? { mode: 'individual', players: r.playerCount as 2 | 3 | 4 } : undefined);
    r.phase = 'playing';
    r.slamStats = { plays: [0, 0, 0, 0], slams: [0, 0, 0, 0] };
    for (const m of Object.values(r.members)) m.cpuCovering = !m.connected && seatOf(r, m.playerId) !== null;
    this.broadcastRoom();
    this.dealNext();
  }

  private dealNext(): void {
    const r = this.data!;
    const res = startHand(r.match!);
    r.match = res.match;
    r.starterWish = null;
    r.step++;
    this.broadcastEvents(res.events);
    this.advance();
  }

  private onMove(s: S, pid: string, raw: Move): void {
    const r = this.data!;
    const hand = r.match?.hand;
    if (r.phase !== 'playing' || !hand || hand.over) return this.err(s, 'not_your_turn');
    const seat = seatOf(r, pid);
    if (seat === null || hand.pendingStarterChoice != null || hand.turn !== seat) return this.err(s, 'not_your_turn');
    const move = matchLegal(legalMoves(r.match!), raw);
    if (!move) return this.err(s, 'bad_move');
    this.apply(move, null);
  }

  private onChooseStarter(s: S, pid: string, pick: Seat): void {
    const r = this.data!;
    const hand = r.match?.hand;
    const seat = seatOf(r, pid);
    if (r.phase !== 'playing' || !hand || hand.over || hand.pendingStarterChoice == null || seat === null) return this.err(s, 'not_your_turn');
    const team = hand.pendingStarterChoice;
    if (seat !== this.starterChooser()) return this.err(s, 'not_your_turn');
    if (!isSeat(pick) || pick % 2 !== team) return this.err(s, 'bad_request', 'seat not in your team');
    r.match = chooseStarter(r.match!, pick);
    r.starterWish = null;
    r.step++;
    this.advance();
  }

  /** the chooser's partner says whether they want to open (once per hand) */
  private onStarterWish(s: S, pid: string, wants: boolean): void {
    const r = this.data!;
    const hand = r.match?.hand;
    const seat = seatOf(r, pid);
    const chooser = this.starterChooser();
    if (r.phase !== 'playing' || !hand || hand.over || chooser === null || seat === null || seat !== (((chooser + 2) % 4) as Seat)) return this.err(s, 'not_your_turn');
    if (r.starterWish) return;
    r.starterWish = { seat, wants: !!wants };
    this.broadcast(() => ({ t: 'starterWish', seat, wants: !!wants }));
    this.broadcast((p) => this.turnMsgFor(p));
  }

  /**
   * Who picks the opener while a choice is pending: the last hand's winner when a human plays that seat,
   * else its partner when that one is human; null = nobody (the CPU decides after a short pause).
   */
  private starterChooser(): Seat | null {
    const m = this.data!.match;
    const hand = m?.hand;
    if (!m || !hand || hand.over || hand.pendingStarterChoice == null) return null;
    const team = hand.pendingStarterChoice;
    const w = (m.lastHandWinner !== null && m.lastHandWinner % 2 === team ? m.lastHandWinner : team) as Seat;
    const p = ((w + 2) % 4) as Seat;
    if (this.controller(w) === 'human') return w;
    if (this.controller(p) === 'human') return p;
    return null;
  }

  /** timeout / nobody to choose: a human partner's spoken wish counts, else the CPU rule */
  private autoStarter(): Seat {
    const r = this.data!;
    const m = r.match!;
    const wish = r.starterWish;
    const chooser = this.starterChooser();
    if (wish && chooser !== null) return wish.wants ? wish.seat : chooser;
    return cpuStarter(m);
  }

  /** a quick phrase or an avatar gesture ('g:<gesture>'), rate limited per player */
  private onPhrase(s: S, pid: string, id: string): void {
    const r = this.data!;
    const seat = seatOf(r, pid);
    if (seat === null || typeof id !== 'string' || !isChatId(id)) return this.err(s, 'bad_request');
    const now = this.io.now();
    const log = (this.phraseLog.get(pid) ?? []).filter((t) => now - t < PHRASE_WINDOW_MS);
    if ((log.length && now - log[log.length - 1] < PHRASE_GAP_MS) || log.length >= PHRASE_BURST) {
      this.phraseLog.set(pid, log);
      return this.err(s, 'rate_limited');
    }
    log.push(now);
    this.phraseLog.set(pid, log);
    this.broadcast(() => ({ t: 'phrase', seat, id }));
  }

  // ───────────────────────── game flow ─────────────────────────

  private controller(seat: Seat): Controller {
    const r = this.data!;
    const slot = r.seats[seat];
    if (slot.kind !== 'human') return 'cpu';
    const m = r.members[slot.playerId];
    // a dropped player keeps their turn clock during the grace period; after it a CPU covers them
    return m && !m.cpuCovering ? 'human' : 'cover';
  }

  /** apply a (validated) move; `cover` = a CPU played it for a human seat */
  private apply(move: Move, cover: 'timeout' | 'disconnected' | null): void {
    const r = this.data!;
    const before = r.match!;
    const res = applyMove(before, move);
    const events = res.events;
    const slot = r.seats[move.seat];
    if (slot.kind === 'cpu') maybeCpuSlam(before, move.seat, events, character(slot.characterId).slam, r.slamStats);
    markFinishing(events);
    r.match = res.match;
    r.step++;
    if (cover) this.broadcast(() => ({ t: 'covered', seat: move.seat, reason: cover }));
    this.broadcastEvents(events);
    if (res.match.hand?.over) {
      if (res.match.over) r.phase = 'finished';
      this.broadcastRoom(); // scores (and phase)
    }
    this.advance();
  }

  private onGameTimer(kind: string, key: string): void {
    const r = this.data!;
    const m = r.match;
    if (r.phase !== 'playing' || !m || !key.startsWith(`${r.step}:`)) return; // stale
    if (kind === 'nextHand') {
      if (!m.over && (!m.hand || m.hand.over)) this.dealNext();
      return;
    }
    const hand = m.hand;
    if (!hand || hand.over) return;
    if (kind === 'starter' || kind === 'cpuStarter') {
      if (hand.pendingStarterChoice == null) return;
      r.match = chooseStarter(m, this.autoStarter());
      r.starterWish = null;
      r.step++;
      return;
    }
    if (hand.pendingStarterChoice != null) return;
    const seat = hand.turn;
    if (kind === 'turn') {
      this.apply(cpuMove(m, COVER_LEVEL), 'timeout');
      return;
    }
    if (kind === 'cpu') {
      const slot = r.seats[seat];
      if (slot.kind === 'cpu') {
        const p = profileOf(slot.characterId);
        this.apply(cpuMove(m, p.level, p.style), null);
      } else this.apply(cpuMove(m, COVER_LEVEL), 'disconnected');
    }
  }

  /**
   * Make sure the right game timer is pending for the current situation and tell everyone whose turn
   * it is when the situation is new. Returns true when a turn message was broadcast.
   */
  private advance(): boolean {
    const r = this.data!;
    const m = r.match;
    const sch = r.schedule;
    if (r.phase !== 'playing' || !m || m.over) {
      clearGameTimer(sch);
      return false;
    }
    // nobody connected: the table waits (no CPU-vs-CPU games burning alarms)
    if (connectedHumans(r).length === 0) {
      clearGameTimer(sch);
      return false;
    }
    const now = this.io.now();
    const sp = this.cfg.cpuSpeed;
    const hand = m.hand;
    if (!hand || hand.over) {
      setGameTimer(sch, 'nextHand', now + this.cfg.nextHandMs, `${r.step}:next`);
      return false;
    }
    if (hand.pendingStarterChoice != null) {
      const chooser = this.starterChooser();
      const t = chooser !== null
        ? setGameTimer(sch, 'starter', now + this.cfg.turnTimeoutMs, `${r.step}:starter:${chooser}`)
        : setGameTimer(sch, 'cpuStarter', now + starterDelay(sp), `${r.step}:cpuStarter`);
      if (t.changed) this.broadcast((pid) => this.turnMsgFor(pid));
      return t.changed;
    }
    const seat = hand.turn;
    const ctl = this.controller(seat);
    let t;
    if (ctl === 'human') t = setGameTimer(sch, 'turn', now + this.cfg.turnTimeoutMs, `${r.step}:${seat}:human`);
    else {
      const legal = legalMoves(m);
      const delay = legal.length === 1 && legal[0].kind === 'draw' ? drawDelay(sp) : thinkDelay(m, legal.length, sp);
      t = setGameTimer(sch, 'cpu', now + delay, `${r.step}:${seat}:${ctl}`);
    }
    if (t.changed) this.broadcast((pid) => this.turnMsgFor(pid));
    return t.changed;
  }

  /** the current 'turn' message as `pid` should see it (null when no turn is pending) */
  private turnMsgFor(pid: string): ServerMsg | null {
    const r = this.data!;
    const m = r.match;
    const hand = m?.hand;
    const timer = r.schedule.game;
    if (r.phase !== 'playing' || !m || !hand || hand.over || !timer || timer.kind === 'nextHand') return null;
    const mySeat = seatOf(r, pid);
    if (hand.pendingStarterChoice != null) {
      const team = hand.pendingStarterChoice as Team;
      const chooser = this.starterChooser();
      const msg: Extract<ServerMsg, { t: 'turn' }> = { t: 'turn', seat: chooser ?? hand.turn, deadline: timer.at, legal: [], choosingStarter: true, starterTeam: team };
      if (chooser !== null) msg.starterChooser = chooser;
      if (chooser !== null && mySeat === chooser) {
        const partner = ((mySeat + 2) % 4) as Seat;
        const wish = r.starterWish;
        if (this.controller(partner) !== 'human') msg.partnerWants = starterPreference(m, partner);
        else if (wish && wish.seat === partner) msg.partnerWants = wish.wants;
      }
      return msg;
    }
    const legal = mySeat === hand.turn && this.controller(hand.turn) === 'human' ? legalMoves(m) : [];
    return { t: 'turn', seat: hand.turn, deadline: timer.at, legal };
  }

  private viewFor(seat: Seat | null) {
    const r = this.data!;
    if (seat === null || !r.match) return null;
    const hand = r.match.hand;
    const timer = r.schedule.game;
    const myTurn = r.phase === 'playing' && hand && !hand.over && hand.pendingStarterChoice == null && hand.turn === seat;
    const legal = myTurn && this.controller(seat) === 'human' ? legalMoves(r.match) : [];
    const deadline = timer && timer.kind !== 'nextHand' ? timer.at : null;
    return seatView(r.match, seat, legal, deadline);
  }
}
