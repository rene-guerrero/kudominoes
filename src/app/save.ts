import type { GameEvent, Lineup, MatchState } from '../contracts';
import { DEFAULT_LINEUP, sanitizeLineup } from '../roster';

const KEY = 'kudominoes.save.v1';

/**
 * v2: tens-scale Cuban scoring. v1 saves (raw-pip scores under the old rules) cannot be mapped
 * faithfully onto the new scale, so they are discarded on load. A v2 save from before the characters
 * (it stored `cpuLevels` instead of a lineup) continues with the characters those seats always had
 * (Carlos / Elena / Andrés); the old levels are dropped.
 */
export interface SavedGame {
  v: 2;
  savedAt: number;
  match: MatchState;
  /** events of the current hand (kept for diagnostics; resume restores the state directly) */
  handEvents: GameEvent[];
  /** the characters in seats 1..3 (always set after loadSave) */
  lineup: Lineup;
}

export function saveGame(match: MatchState, handEvents: GameEvent[], lineup: Lineup): void {
  try {
    if (match.over) return clearSave();
    const data: SavedGame = { v: 2, savedAt: Date.now(), match, handEvents, lineup };
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* non-fatal */
  }
}

export function loadSave(): SavedGame | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as SavedGame | { v: 1 };
    if (s?.v !== 2) {
      // old raw-pip save: drop it
      clearSave();
      return null;
    }
    if (!s.match || s.match.over || !Array.isArray(s.match.scores) || !s.match.rules || !('rounding' in s.match.rules)) return null;
    if (!Array.isArray(s.handEvents)) s.handEvents = [];
    s.lineup = sanitizeLineup(s.lineup) ?? { ...DEFAULT_LINEUP };
    delete (s as { cpuLevels?: unknown }).cpuLevels;
    // individual mode: seats and per-seat scores must be sane; saves from before the mode existed are pairs
    if (s.match.mode === 'individual') {
      const seats = s.match.seats;
      const sc = s.match.seatScores;
      const okSeats = Array.isArray(seats) && [2, 3, 4].includes(seats.length) && seats.every((x) => x === 0 || x === 1 || x === 2 || x === 3);
      if (!okSeats || !Array.isArray(sc) || sc.length !== 4) return null;
      if (!Array.isArray(s.match.seatHandsWon) || s.match.seatHandsWon.length !== 4) s.match.seatHandsWon = [0, 0, 0, 0];
    } else {
      delete s.match.mode;
      // a match saved before "puntos abajo" existed keeps the rules it started with (no abajo) and an empty pot
      if (!('abajo' in s.match.rules)) s.match.rules = { ...s.match.rules, abajo: false };
    }
    const pot = s.match.abajo;
    s.match.abajo = typeof pot === 'number' && Number.isFinite(pot) && pot >= 0 ? pot : 0;
    const h = s.match.hand;
    if (h && (!Array.isArray(h.hands) || h.hands.length !== 4 || !Array.isArray(h.chain))) return null;
    return s;
  } catch {
    return null;
  }
}

export function hasSave(): boolean {
  return loadSave() !== null;
}

/** the menu's "Continuar" line: hand number and scores (individual: yours against the best opponent's) */
export function saveSummary(s: SavedGame): { hand: number; us: number; them: number } {
  const m = s.match;
  const hand = m.hand?.handNo ?? 0;
  const sc = m.seatScores;
  if (m.mode === 'individual' && sc) return { hand, us: sc[0] ?? 0, them: Math.max(0, ...(m.seats ?? []).filter((x) => x !== 0).map((x) => sc[x] ?? 0)) };
  return { hand, us: m.scores[0], them: m.scores[1] };
}

export function clearSave(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
