import type { Rounding, Rules } from './rules';

/** Compact numeric rule codes used by the hot paths (engine + AI rollouts share this resolver). */
export interface ScoreRules {
  scoringAll: boolean;
  tranqueAll: boolean;
  /** 0 lowestPlayer, 1 lowestTeam, 2 blockerRisk */
  tranqueWinner: number;
  /** 0 void, 1 blockerLoses, 2 mano */
  tranqueTie: number;
  /** 0 up, 1 nearest, 2 down, 3 none */
  round: number;
}

const ROUND_CODE: Record<Rounding, number> = { up: 0, nearest: 1, down: 2, none: 3 };

export function toScoreRules(r: Rules): ScoreRules {
  return {
    scoringAll: r.scoring === 'all',
    tranqueAll: r.scoring === 'all' && r.tranqueScoring === 'same',
    tranqueWinner: r.tranqueWinner === 'lowestPlayer' ? 0 : r.tranqueWinner === 'lowestTeam' ? 1 : 2,
    tranqueTie: r.tranqueTie === 'void' ? 0 : r.tranqueTie === 'blockerLoses' ? 1 : 2,
    round: ROUND_CODE[r.rounding] ?? 0,
  };
}

/** Pips → points by rounding code (allocation-free; used by the AI rollouts too). */
export function roundCode(pips: number, code: number): number {
  switch (code) {
    case 0:
      return Math.ceil(pips / 10); // 31 → 4, 65 → 7, 60 → 6, 1 → 1, 0 → 0
    case 1:
      return Math.floor((pips + 5) / 10); // 65 → 7, 64 → 6
    case 2:
      return Math.floor(pips / 10); // 69 → 6
    default:
      return pips; // exact pips
  }
}

/** Pips → points: rounded to a multiple of ten and divided by ten (or the raw pips with 'none'). */
export function roundPoints(pips: number, mode: Rounding): number {
  return roundCode(pips, ROUND_CODE[mode] ?? 0);
}

/**
 * Order of operations for "capicúa counts double". false (the default): round first, then double
 * (65 pips → 7 → 14). Set to true to double the pips before rounding (65 → 130 → 13).
 * This is the ONLY place that decides it — the engine and the AI both go through capicuaDoubleTotal.
 */
export const CAPICUA_DOUBLE_BEFORE_ROUNDING = false;

/** Total hand points with capicúa ×2, given the raw pips and the rounding code. */
export function capicuaDoubleTotal(pips: number, code: number): number {
  return CAPICUA_DOUBLE_BEFORE_ROUNDING ? roundCode(pips * 2, code) : roundCode(pips, code) * 2;
}

/** Lower pip count within a team; ties go to the seat that comes first in play order from `starter`. */
function bestOfTeam(team: number, pips: ArrayLike<number>, starter: number): number {
  const s1 = team;
  const s2 = team + 2;
  if (pips[s1] !== pips[s2]) return pips[s1] < pips[s2] ? s1 : s2;
  const d1 = (s1 - starter + 4) & 3;
  const d2 = (s2 - starter + 4) & 3;
  return d1 < d2 ? s1 : s2;
}

/**
 * Resolve a finished hand. Allocation-free.
 * @param blocked false = domino (lastSeat went out), true = tranque (lastSeat placed the blocking tile)
 * @returns encoded result: winnerSeat = (r & 7) - 1 (-1 = void hand), points = r >> 3
 */
export function resolveHandCore(
  sr: ScoreRules,
  blocked: boolean,
  pips: ArrayLike<number>,
  lastSeat: number,
  starter: number,
): number {
  const total = pips[0] + pips[1] + pips[2] + pips[3];
  let winner = -1;
  if (!blocked) {
    winner = lastSeat;
  } else {
    let tieTeamWinner = -2; // -2 = no tie
    if (sr.tranqueWinner === 0) {
      let min = 999;
      for (let s = 0; s < 4; s++) if (pips[s] < min) min = pips[s];
      let teams = 0;
      for (let s = 0; s < 4; s++) if (pips[s] === min) teams |= 1 << (s & 1);
      if (teams === 3) tieTeamWinner = -1;
      else winner = bestOfTeam(teams === 1 ? 0 : 1, pips, starter);
    } else if (sr.tranqueWinner === 1) {
      const t0 = pips[0] + pips[2];
      const t1 = pips[1] + pips[3];
      if (t0 === t1) tieTeamWinner = -1;
      else winner = bestOfTeam(t0 < t1 ? 0 : 1, pips, starter);
    } else {
      const opp = (lastSeat + 1) & 1;
      const oppMin = Math.min(pips[opp], pips[opp + 2]);
      if (pips[lastSeat] < oppMin) winner = lastSeat;
      else if (pips[lastSeat] > oppMin) winner = bestOfTeam(opp, pips, starter);
      else tieTeamWinner = -1;
    }
    if (tieTeamWinner === -1) {
      if (sr.tranqueTie === 1) winner = bestOfTeam((lastSeat + 1) & 1, pips, starter);
      else if (sr.tranqueTie === 2) winner = bestOfTeam(starter & 1, pips, starter);
      else winner = -1;
    }
  }
  if (winner < 0) return 0;
  const team = winner & 1;
  const oppPts = pips[1 - team] + pips[3 - team];
  const all = blocked ? sr.tranqueAll : sr.scoringAll;
  const points = all ? total : oppPts;
  return (points << 3) | (winner + 1);
}
