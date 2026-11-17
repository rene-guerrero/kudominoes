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

export function clearSave(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
