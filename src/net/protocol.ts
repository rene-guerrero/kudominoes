import type { FaceSpec } from 'kuavatars/faces';
/**
 * ONLINE MULTIPLAYER PROTOCOL — the single contract between the room server (server/, Cloudflare
 * Worker + one Durable Object per room) and the game client (src/net/**, online UI in src/ui/**).
 *
 * Design (agreed with the user): family & friends, private rooms joined by a short code or link, no
 * accounts (a random device id + a name stored on the phone), no spectators, 30 s turn timer after
 * which a CPU plays for that seat, CPUs fill empty seats and take over disconnected players until they
 * return. The SERVER IS AUTHORITATIVE: it owns MatchState, runs the existing engine (src/engine) and
 * CPU, and sends every player only what their seat may see (never other players' hands or the pozo).
 *
 * Transport: JSON text frames over one WebSocket per player:
 *   GET  {SERVER}/api/rooms/{code}/ws?pid={playerId}   (upgrade)
 *   POST {SERVER}/api/rooms                            → CreateRoomResponse (creates a code)
 *   GET  {SERVER}/api/rooms/{code}                     → RoomInfoResponse (exists? joinable?)
 *
 * Adding OPTIONAL fields is fine; renaming/removing anything requires updating both sides.
 */
import type { Difficulty, GameEvent, GameMode, Move, RuleSettings, Seat, Team } from '../contracts';

export const PROTOCOL_VERSION = 1;
/** room codes: 4 chars from an unambiguous alphabet (no 0/O/1/I), shown as KUDO-XXXX */
export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 4;
export const TURN_TIMEOUT_MS = 30_000;
/** a disconnected player's seat is played by a CPU after this grace period (they can rejoin any time) */
export const DISCONNECT_GRACE_MS = 8_000;
/** rooms with nobody connected are deleted after this */
export const ROOM_IDLE_TTL_MS = 2 * 60 * 60 * 1000;
export const MAX_NAME_LENGTH = 16;

// ───────────────────────── HTTP ─────────────────────────

export interface CreateRoomResponse {
  code: string; // e.g. "7KQM" (display as KUDO-7KQM)
}
export interface RoomInfoResponse {
  exists: boolean;
  phase?: RoomPhase;
  /** free human seats (0 when the match is running and every human seat is taken) */
  freeSeats?: number;
}

// ───────────────────────── room state (what everyone sees) ─────────────────────────

export type RoomPhase = 'lobby' | 'playing' | 'finished';

export type SeatOccupant =
  | { kind: 'empty' }
  /** a human player; `connected` false = dropped (a CPU plays for them after the grace period) */
  | { kind: 'human'; playerId: string; name: string; face: number | FaceSpec; connected: boolean; cpuCovering: boolean }
  /** a roster character filling the seat (src/roster.ts id, e.g. 'elena', 'papi-zorg') */
  | { kind: 'cpu'; characterId: string };

export interface PublicRoom {
  code: string;
  phase: RoomPhase;
  hostId: string; // playerId of the host (creator; passes to the next connected human if they leave)
  mode: GameMode;
  /** 2–4 in individual mode, always 4 in pairs */
  playerCount: number;
  /** index = Seat. In pairs mode seats 0&2 vs 1&3. Length = 4 (unused seats in individual = empty). */
  seats: SeatOccupant[];
  rules: RuleSettings;
  /** running match summary (null in lobby) */
  scores: number[] | null;
}

// ───────────────────────── per-player view (private) ─────────────────────────

/**
 * Everything one seat may know right now, sent on (re)join and whenever a resync is needed.
 * The client builds its local display from this (instant restore — no replay).
 */
export interface SeatView {
  seat: Seat;
  /** a MatchState with every hidden part REDACTED for this seat: other seats' hands replaced by
   *  tile COUNTS (see handCounts) and their hand arrays emptied; pozo emptied (see pozoCount). */
  match: unknown; // MatchState (redacted) — typed loosely to keep the server free to strip fields
  handCounts: number[]; // index = Seat
  pozoCount: number;
  /** legal moves if it's this seat's turn (else []) and the absolute turn deadline (ms epoch) */
  legal: Move[];
  turnDeadline: number | null;
}

// ───────────────────────── client → server ─────────────────────────

export type ClientMsg =
  /** first message after the socket opens (also on every reconnect) */
  | { t: 'hello'; v: number; playerId: string; name: string; face: number | FaceSpec }
  /** lobby: take / move to a seat (null = leave seat, stay in room) */
  | { t: 'sit'; seat: Seat | null }
  /** lobby, host only: put a roster CPU in a seat (null = empty it) */
  | { t: 'setCpu'; seat: Seat; characterId: string | null }
  /** lobby, host only */
  | { t: 'setMode'; mode: GameMode; playerCount: number }
  | { t: 'setRules'; rules: RuleSettings }
  /** lobby/finished, host only: start (empty seats are auto-filled with roster CPUs) */
  | { t: 'start' }
  /** in game: play / pass / draw — must be one of the server's legal moves for your seat */
  | { t: 'move'; move: Move }
  /** in game (pairs, winning team chooses opener): pick which partner opens */
  | { t: 'chooseStarter'; seat: Seat }
  /** in game, while the partner (starterChooser) picks the opener: "Quiero salir" (true) / "Sal tú" (false) */
  | { t: 'starterWish'; wants: boolean }
  /** quick phrase / emote by id (see QUICK_PHRASES); rate-limited server-side */
  | { t: 'phrase'; id: string }
  /** the human slams a tile: sent as part of the move (move.slam) — no separate message */
  | { t: 'rematch' }
  | { t: 'leave' }
  | { t: 'ping'; at: number };

// ───────────────────────── server → client ─────────────────────────

export type ServerMsg =
  /** answer to hello: who you are + full snapshot */
  | { t: 'welcome'; you: { playerId: string; seat: Seat | null; isHost: boolean }; room: PublicRoom; view: SeatView | null }
  /** lobby/room metadata changed (seats, host, rules, presence) */
  | { t: 'room'; room: PublicRoom }
  /**
   * game progress, REDACTED for the receiving seat: other players' tiles in handStart.hands are
   * hidden (arrays of the right length filled with HIDDEN_TILE placeholders), a 'draw' event by another
   * seat carries no tile; plays reveal the played tile as usual. Animate them in order like local events.
   */
  | { t: 'events'; events: GameEvent[] }
  /** whose turn it is now; `legal` is non-empty only for the receiving seat when it is theirs */
  | {
      t: 'turn';
      seat: Seat;
      deadline: number;
      legal: Move[];
      choosingStarter?: boolean;
      /** optional (with choosingStarter): the team that picks its opener (timeout: CPU decides) */
      starterTeam?: Team;
      /**
       * optional (with choosingStarter): the one seat that may send chooseStarter: the last hand's winner
       * (or its human partner when the winner is a CPU / covered). Its partner may send starterWish.
       */
      starterChooser?: Seat;
      /** optional (with choosingStarter, only to the chooser): the partner's spoken wish to open (CPU, or a human who said it) */
      partnerWants?: boolean;
    }
  /** full private resync (after reconnect, or if the client reports it's out of sync) */
  | { t: 'sync'; room: PublicRoom; view: SeatView }
  | { t: 'phrase'; seat: Seat; id: string }
  /** a player said whether they want to open ("Quiero salir" / "Sal tú"): shown as a bubble */
  | { t: 'starterWish'; seat: Seat; wants: boolean }
  /** a CPU just played for a human seat (timer ran out or player disconnected) */
  | { t: 'covered'; seat: Seat; reason: 'timeout' | 'disconnected' }
  | { t: 'error'; code: ErrorCode; message?: string }
  | { t: 'pong'; at: number; serverNow: number };

export type ErrorCode =
  | 'room_not_found'
  | 'room_full'
  | 'not_host'
  | 'bad_move'
  | 'not_your_turn'
  | 'bad_request'
  | 'version_mismatch'
  | 'rate_limited';

/** placeholder for a hidden tile in redacted events (id -1 never collides with real ids 0..27) */
export const HIDDEN_TILE = { id: -1, a: 0, b: 0 } as const;

/** CPU level used when a CPU covers a human seat (timeout / disconnect) */
export const COVER_LEVEL: Difficulty = 'normal';

/** quick phrases (ids are stable; text lives in the client i18n) — neutral Spanish, no slang */
export const QUICK_PHRASES = ['hello', 'nice', 'oops', 'thinking', 'hurry', 'gg', 'thanks', 'wow'] as const;
export type QuickPhraseId = (typeof QUICK_PHRASES)[number];
/** avatar hand gestures sent through the same 'phrase' message as `g:<gesture>` (names as in KuAvatars) */
export const CHAT_GESTURES = ['thumbsUp', 'thumbsDown', 'rub', 'clap', 'wave', 'shrug', 'facepalm', 'chin', 'mewing'] as const;
export type ChatGesture = (typeof CHAT_GESTURES)[number];
/** a quick phrase id or a gesture id ('g:wave') */
export const isChatId = (id: string): boolean =>
  (QUICK_PHRASES as readonly string[]).includes(id) || (id.startsWith('g:') && (CHAT_GESTURES as readonly string[]).includes(id.slice(2)));
