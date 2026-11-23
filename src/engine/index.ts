import type { EngineApi } from '../contracts';
import { chooseMove } from './ai';
import { applyMove, chooseStarter, cpuStarter, createMatch, legalMoves, startHand, starterPreference } from './game';
import { DEFAULT_RULES, DEFAULT_RULES_INDIVIDUAL, matchTarget, RULE_PRESETS, RULE_SETTINGS, RULE_SETTINGS_INDIVIDUAL } from './rules';
import { ALL_TILES } from './tiles';

export {
  RULE_SETTINGS,
  RULE_SETTINGS_INDIVIDUAL,
  DEFAULT_RULES,
  DEFAULT_RULES_INDIVIDUAL,
  RULE_PRESETS,
  RULES_VERSION,
  normalizeRules,
  migrateRules,
  sameRules,
  matchTarget,
  scoreUnit,
  descriptorsFor,
  defaultRulesFor,
  double9Preset,
} from './rules';
export { roundPoints, CAPICUA_DOUBLE_BEFORE_ROUNDING } from './scoring';
export {
  ALL_TILES,
  DOUBLE6_TILES,
  DOUBLE9_TILES,
  TILE_SETS,
  TILE_BY_ID,
  MAX_PIP,
  MAX_TILES,
  MAX_TILE_ID,
  tileSetOf,
  tilesFor,
  tileIdsFor,
  tileById,
  tilesPerPip,
  highestDoubleId,
  handSizeFor,
} from './tiles';
export { createMatch, startHand, legalMoves, applyMove, chooseStarter, starterPreference, cpuStarter, modeOf, seatsOf, isSolo, matchTileSet, matchTiles } from './game';
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
  RULE_SETTINGS_INDIVIDUAL,
  DEFAULT_RULES_INDIVIDUAL,
};

export default engine;
