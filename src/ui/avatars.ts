/**
 * Kudominoes' side of the animated avatars. The faces, moods, idle life and reactions live in the
 * shared KuAvatars library (also used by KuCards); this file only maps Kudominoes onto it: which face
 * each seat wears, where the name plates put the faces, and which game events trigger which reactions.
 */
import { AvatarController as AvatarTable, HUMAN_FACES, sanitizeFace, type AvatarExpr, type FaceSpec } from 'kuavatars';
import type { GameEvent, SeatPlate } from '../contracts';
import { character, DEFAULT_LINEUP } from '../roster';

export { FACE_COUNT, HUMAN_FACES, liveFace, staticFace, type AvatarExpr } from 'kuavatars';

/** the face each seat wears (seat 0 = the human's pick; 1..3 = the seated characters) */
const seatFaces: FaceSpec[] = [HUMAN_FACES[0], character(DEFAULT_LINEUP[1]).face, character(DEFAULT_LINEUP[2]).face, character(DEFAULT_LINEUP[3]).face];
export function setHumanFace(face: number | FaceSpec): void {
  seatFaces[0] = sanitizeFace(face);
}
export const faceOfSeat = (seat: number): FaceSpec => seatFaces[seat] ?? HUMAN_FACES[0];

type HandEnd = Extract<GameEvent, { type: 'handEnd' }>;
const SEATS = [0, 1, 2, 3] as const;

export class AvatarController extends AvatarTable {
  private lastEvent: GameEvent | null = null;

  constructor() {
    super({ seats: 4, faces: seatFaces });
  }

  /** the human's chosen face (Ajustes → Avatares) */
  setHumanFace(face: number | FaceSpec): void {
    setHumanFace(face);
    this.setFace(0, faceOfSeat(0));
  }

  /** the character seated at a CPU seat */
  setSeatFace(seat: 1 | 2 | 3, spec: FaceSpec): void {
    seatFaces[seat] = spec;
    this.setFace(seat, spec);
  }

  /** plate centres (CSS px) and the table centre, for glances */
  override setPositions(plates: readonly SeatPlate[], center: { x: number; y: number }): void {
    // the face sits at the left of a row plate, at the top of a stack plate
    super.setPositions(
      plates.map((p) => ({
        x: p.layout === 'row' ? p.x - p.w / 2 + p.d / 2 : p.x,
        y: p.layout === 'row' ? p.y : p.y - p.h / 2 + p.d / 2,
      })),
      center,
    );
  }

  override reset(): void {
    this.lastEvent = null;
    super.reset();
  }

  /** a game event: the faces react (replay = rebuilding a saved hand, no reactions) */
  onEvent(ev: GameEvent, replay: boolean): void {
    const prev = this.lastEvent;
    this.lastEvent = ev;
    if (replay || this.isQuiet) {
      if (ev.type === 'handStart') this.calmAll();
      return;
    }
    switch (ev.type) {
      case 'handStart':
        this.onRoundStart();
        break;
      case 'play':
        this.onPlay(ev.seat, !!(ev.slam || ev.finishing));
        break;
      case 'pass': {
        // the player who forced it (previous seat, an opponent) is pleased; everyone else is impressed
        const forcer = prev && prev.type === 'play' && prev.seat === (ev.seat + 3) % 4 ? prev.seat : null;
        this.onPass(ev.seat, forcer);
        break;
      }
      case 'handEnd':
        this.onHandEnd(ev);
        break;
      case 'matchEnd':
        // individual: only the winning player (pairs: the winning team)
        this.onMatchEnd(SEATS.map((s) => (ev.winnerSeat !== undefined ? s === ev.winnerSeat : s % 2 === ev.winner)));
        break;
    }
  }

  private onHandEnd(ev: HandEnd): void {
    const big = ev.reason === 'blocked' || ev.bonuses.length > 0;
    const result = SEATS.map((s): AvatarExpr => {
      if (ev.winnerTeam === null) return 'meh';
      const won = ev.seats ? s === ev.winnerSeat : s % 2 === ev.winnerTeam;
      return won ? 'happy' : 'sad';
    });
    this.onRoundEnd(result, big);
  }
}
