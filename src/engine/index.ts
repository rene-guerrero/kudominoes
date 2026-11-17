import type { EngineApi } from '../contracts';
import { chooseMove } from './ai';
import { applyMove, chooseStarter, cpuStarter, createMatch, legalMoves, startHand, starterPreference } from './game';
import { DEFAULT_RULES, matchTarget, RULE_PRESETS, RULE_SETTINGS } from './rules';
import { ALL_TILES } from './tiles';

export { RULE_SETTINGS, DEFAULT_RULES, RULE_PRESETS, RULES_VERSION, normalizeRules, migrateRules, sameRules, matchTarget, scoreUnit } from './rules';
export { roundPoints, CAPICUA_DOUBLE_BEFORE_ROUNDING } from './scoring';
export { ALL_TILES } from './tiles';
export { createMatch, startHand, legalMoves, applyMove, chooseStarter, starterPreference, cpuStarter } from './game';
export { chooseMove, styleWeights, MASTER_MS } from './ai';
export type { AiOptions } from './ai';

export const engine: EngineApi = {
  RULE_SETTINGS,
  DEFAULT_RULES,
  ALL_TILES,
  createMatch,
  startHand,
  legalMoves,
  applyMove,
  chooseMove: (match, difficulty, style) => chooseMove(match, difficulty, {}, style),
  matchTarget,
  RULE_PRESETS,
  chooseStarter,
  starterPreference,
  cpuStarter,
};

export default engine;
