/**
 * Room model and the pure lobby rules: seats, host, mode/rules, CPU fill, room codes, names.
 * The Durable Object (room.ts) persists a RoomData and calls these; nothing here touches I/O.
 */
import { SEATS_FOR, type GameMode, type MatchState, type RuleSettings, type Seat } from '../../src/contracts';
import { defaultRulesFor, normalizeRules } from '../../src/engine/rules';
import {
  MAX_NAME_LENGTH,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  type PublicRoom,
  type RoomPhase,
  type SeatOccupant,
} from '../../src/net/protocol';
import { isCharacter, ROSTER } from '../../src/roster';
import { emptySchedule, type Schedule } from './schedule';

/** what a seat holds (member details live in RoomData.members) */
export type SeatSlot = { kind: 'empty' } | { kind: 'human'; playerId: string } | { kind: 'cpu'; characterId: string };

export interface Member {
  playerId: string;
  name: string;
  face: number;
  connected: boolean;
  /** a CPU plays this player's seat (disconnected past the grace period) */
  cpuCovering: boolean;
  joinedAt: number;
}

export interface RoomData {
  v: 1;
  code: string;
  createdAt: number;
  phase: RoomPhase;
  /** '' until the first player says hello (when the creator did not pass its id on creation) */
  hostId: string;
  mode: GameMode;
  playerCount: number;
  seats: SeatSlot[];
  members: Record<string, Member>;
  rules: RuleSettings;
  match: MatchState | null;
  /** bumped on every game state change (guards stale timers) */
  step: number;
  schedule: Schedule;
  /** per seat, this match: plays and slams of the CPU characters (slams are rationed) */
  slamStats: { plays: number[]; slams: number[] };
  /** this hand's opener choice: what a human partner said ("Quiero salir" = true); cleared on each deal */
  starterWish?: { seat: Seat; wants: boolean } | null;
}

export const MAX_MEMBERS = 8;

export class LobbyError extends Error {
  constructor(
    public code: 'not_host' | 'bad_request' | 'room_full',
    message?: string,
  ) {
    super(message ?? code);
  }
}

export function newRoom(code: string, now: number, hostId = ''): RoomData {
  return {
    v: 1,
    code,
    createdAt: now,
    phase: 'lobby',
    hostId,
    mode: 'pairs',
    playerCount: 4,
    seats: [{ kind: 'empty' }, { kind: 'empty' }, { kind: 'empty' }, { kind: 'empty' }],
    members: {},
    rules: normalizeRules(defaultRulesFor('pairs'), 'pairs'),
    match: null,
    step: 0,
    schedule: emptySchedule(),
    slamStats: { plays: [0, 0, 0, 0], slams: [0, 0, 0, 0] },
  };
}

// ───────────────────────── codes, names ─────────────────────────

export function generateCode(rnd: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) s += ROOM_CODE_ALPHABET[Math.floor(rnd() * ROOM_CODE_ALPHABET.length) % ROOM_CODE_ALPHABET.length];
  return s;
}

/** accepts "7kqm", "KUDO-7KQM", " 7KQM "; returns the canonical code or null */
export function normalizeCode(raw: string): string | null {
  let s = raw.trim().toUpperCase();
  if (s.startsWith('KUDO-')) s = s.slice(5);
  if (s.length !== ROOM_CODE_LENGTH) return null;
  for (const ch of s) if (!ROOM_CODE_ALPHABET.includes(ch)) return null;
  return s;
}

export const isValidPlayerId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(v);

/** control, zero-width and bidi-override characters */
const INVISIBLE = new RegExp('[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]', 'g');

export function sanitizeName(v: unknown): string {
  const s = typeof v === 'string' ? v.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim() : '';
  const chars = Array.from(s).slice(0, MAX_NAME_LENGTH).join('').trim();
  return chars || 'Jugador';
}

export const sanitizeFace = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(6, Math.floor(v))) : 0);

// ───────────────────────── seats ─────────────────────────

export const activeSeats = (mode: GameMode, count: number): Seat[] =>
  mode === 'pairs' ? [0, 1, 2, 3] : SEATS_FOR[(count === 2 || count === 3 ? count : 4) as 2 | 3 | 4].slice();

export const roomSeats = (r: RoomData): Seat[] => activeSeats(r.mode, r.playerCount);

export function seatOf(r: RoomData, playerId: string): Seat | null {
  const i = r.seats.findIndex((s) => s.kind === 'human' && s.playerId === playerId);
  return i < 0 ? null : (i as Seat);
}

const isLobbyLike = (r: RoomData): boolean => r.phase === 'lobby' || r.phase === 'finished';

/** seats a newcomer may take: empty ones first (lobby only), then CPU seats (they replace the CPU) */
export function freeSeatList(r: RoomData): Seat[] {
  const act = roomSeats(r);
  const empty = isLobbyLike(r) ? act.filter((s) => r.seats[s].kind === 'empty') : [];
  const cpu = act.filter((s) => r.seats[s].kind === 'cpu');
  return [...empty, ...cpu];
}

export const freeSeats = (r: RoomData): number => freeSeatList(r).length;

/**
 * A player arriving (or re-arriving) gets a seat: the one they hold, else the first free one. In a
 * running match that means taking over a CPU seat (with its hand). Returns null when nothing is free.
 */
export function autoSeat(r: RoomData, playerId: string): Seat | null {
  const mine = seatOf(r, playerId);
  if (mine !== null) return mine;
  const s = freeSeatList(r)[0];
  if (s === undefined) return null;
  r.seats[s] = { kind: 'human', playerId };
  return s;
}

/** lobby: take / move to a seat (null = stand up) */
export function sit(r: RoomData, playerId: string, seat: Seat | null): void {
  if (!isLobbyLike(r)) throw new LobbyError('bad_request', 'seats are fixed during a match');
  const cur = seatOf(r, playerId);
  if (seat === null) {
    if (cur !== null) r.seats[cur] = { kind: 'empty' };
    return;
  }
  if (!isSeat(seat) || !roomSeats(r).includes(seat)) throw new LobbyError('bad_request', 'seat not in play');
  if (cur === seat) return;
  const target = r.seats[seat];
  if (target.kind === 'human') throw new LobbyError('room_full', 'seat taken');
  // swap: whatever sat in the target seat (a CPU or nothing) takes the player's old seat
  if (cur !== null) r.seats[cur] = target;
  r.seats[seat] = { kind: 'human', playerId };
}

export const isSeat = (v: unknown): v is Seat => v === 0 || v === 1 || v === 2 || v === 3;

function requireHost(r: RoomData, playerId: string): void {
  if (r.hostId !== playerId) throw new LobbyError('not_host');
}

/** lobby, host only: a roster CPU in a seat (null = empty it) */
export function setCpu(r: RoomData, playerId: string, seat: Seat, characterId: string | null): void {
  requireHost(r, playerId);
  if (!isLobbyLike(r)) throw new LobbyError('bad_request', 'not in the lobby');
  if (!isSeat(seat) || !roomSeats(r).includes(seat)) throw new LobbyError('bad_request', 'seat not in play');
  if (r.seats[seat].kind === 'human') throw new LobbyError('bad_request', 'a player sits there');
  if (characterId === null) {
    r.seats[seat] = { kind: 'empty' };
    return;
  }
  if (!isCharacter(characterId)) throw new LobbyError('bad_request', 'unknown character');
  if (r.seats.some((s, i) => i !== seat && s.kind === 'cpu' && s.characterId === characterId)) throw new LobbyError('bad_request', 'character already seated');
  r.seats[seat] = { kind: 'cpu', characterId };
}

/** lobby, host only. Players in seats that go out of play move to free seats (or stand up). */
export function setMode(r: RoomData, playerId: string, mode: GameMode, playerCount: number): void {
  requireHost(r, playerId);
  if (!isLobbyLike(r)) throw new LobbyError('bad_request', 'not in the lobby');
  if (mode !== 'pairs' && mode !== 'individual') throw new LobbyError('bad_request', 'bad mode');
  const count = mode === 'pairs' ? 4 : playerCount;
  if (count !== 2 && count !== 3 && count !== 4) throw new LobbyError('bad_request', 'bad player count');
  if (mode !== r.mode) r.rules = normalizeRules(defaultRulesFor(mode), mode);
  r.mode = mode;
  r.playerCount = count;
  const act = activeSeats(mode, count);
  const displaced: string[] = [];
  for (let s = 0 as Seat; s < 4; s++) {
    if (act.includes(s as Seat)) continue;
    const slot = r.seats[s];
    if (slot.kind === 'human') displaced.push(slot.playerId);
    r.seats[s] = { kind: 'empty' };
  }
  for (const pid of displaced) {
    const free = act.find((s) => r.seats[s].kind === 'empty') ?? act.find((s) => r.seats[s].kind === 'cpu');
    if (free !== undefined) r.seats[free] = { kind: 'human', playerId: pid };
  }
}

export function setRules(r: RoomData, playerId: string, rules: unknown): void {
  requireHost(r, playerId);
  if (!isLobbyLike(r)) throw new LobbyError('bad_request', 'not in the lobby');
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) throw new LobbyError('bad_request', 'bad rules');
  r.rules = normalizeRules(rules as RuleSettings, r.mode);
}

/** start: unseated members sit down first, then empty seats get distinct random roster CPUs */
export function fillSeats(r: RoomData, rnd: () => number = Math.random): void {
  const act = roomSeats(r);
  const unseated = Object.values(r.members)
    .filter((m) => m.connected && seatOf(r, m.playerId) === null)
    .sort((a, b) => a.joinedAt - b.joinedAt);
  for (const m of unseated) {
    const s = act.find((x) => r.seats[x].kind === 'empty');
    if (s === undefined) break;
    r.seats[s] = { kind: 'human', playerId: m.playerId };
  }
  for (const s of act) if (r.seats[s].kind === 'empty') r.seats[s] = { kind: 'cpu', characterId: pickCharacter(r, rnd) };
}

/** a roster character nobody at the table is (optionally of one level) */
export function pickCharacter(r: RoomData, rnd: () => number = Math.random, level?: string): string {
  const used = new Set(r.seats.filter((s) => s.kind === 'cpu').map((s) => (s as { characterId: string }).characterId));
  let pool = ROSTER.filter((c) => !used.has(c.id) && (!level || c.level === level));
  if (!pool.length) pool = ROSTER.filter((c) => !used.has(c.id));
  if (!pool.length) pool = ROSTER;
  return pool[Math.floor(rnd() * pool.length) % pool.length].id;
}

export const humanCount = (r: RoomData): number => roomSeats(r).filter((s) => r.seats[s].kind === 'human').length;

/**
 * The host passes to the next connected human: seated players in turn order after the host's seat,
 * then unseated members by arrival. Keeps the host while they are connected.
 */
export function ensureHost(r: RoomData): boolean {
  const cur = r.members[r.hostId];
  if (cur && cur.connected) return false;
  const from = seatOf(r, r.hostId) ?? 0;
  const order: string[] = [];
  for (let i = 1; i <= 4; i++) {
    const slot = r.seats[(from + i) % 4];
    if (slot.kind === 'human') order.push(slot.playerId);
  }
  for (const m of Object.values(r.members).sort((a, b) => a.joinedAt - b.joinedAt)) if (!order.includes(m.playerId)) order.push(m.playerId);
  const next = order.find((pid) => r.members[pid]?.connected);
  if (!next) {
    // nobody connected: keep the current host if still a member (they may come back)
    if (cur) return false;
    const any = order.find((pid) => r.members[pid]);
    if (any && any !== r.hostId) {
      r.hostId = any;
      return true;
    }
    return false;
  }
  if (next === r.hostId) return false;
  r.hostId = next;
  return true;
}

/** a player leaves for good: lobby seat empties; in a match a CPU character takes the seat */
export function removeMember(r: RoomData, playerId: string, rnd: () => number = Math.random): void {
  const s = seatOf(r, playerId);
  if (s !== null) r.seats[s] = r.phase === 'playing' ? { kind: 'cpu', characterId: pickCharacter(r, rnd, 'normal') } : { kind: 'empty' };
  delete r.members[playerId];
  if (r.hostId === playerId) {
    r.hostId = '';
    ensureHost(r);
  }
}

export const connectedHumans = (r: RoomData): Member[] => Object.values(r.members).filter((m) => m.connected);

export function roomScores(r: RoomData): number[] | null {
  const m = r.match;
  if (!m || r.phase === 'lobby') return null;
  return m.mode === 'individual' ? (m.seatScores ?? [0, 0, 0, 0]).slice() : m.scores.slice();
}

export function publicRoom(r: RoomData): PublicRoom {
  const seats: SeatOccupant[] = r.seats.map((slot) => {
    if (slot.kind === 'empty') return { kind: 'empty' };
    if (slot.kind === 'cpu') return { kind: 'cpu', characterId: slot.characterId };
    const m = r.members[slot.playerId];
    return {
      kind: 'human',
      playerId: slot.playerId,
      name: m?.name ?? 'Jugador',
      face: m?.face ?? 0,
      connected: !!m?.connected,
      cpuCovering: !!m?.cpuCovering,
    };
  });
  return {
    code: r.code,
    phase: r.phase,
    hostId: r.hostId,
    mode: r.mode,
    playerCount: r.playerCount,
    seats,
    rules: { ...r.rules },
    scores: roomScores(r),
  };
}
