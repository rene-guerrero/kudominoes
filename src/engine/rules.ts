import type { GameMode, RulePreset, RuleSettings, SettingDescriptor, SettingValue, TileSet } from '../contracts';

const L = (es: string, en: string) => ({ es, en });
const off = { value: 0, label: L('No', 'Off') };
/** numeric options on the tens scale: labels carry {n}, shown ×10 when rounding is 'none' */
const TENS = { key: 'rounding', when: 'none', factor: 10 } as const;
const pts = (v: number) => ({ value: v, label: L('{n} puntos', '{n} points'), short: L('{n}', '{n}') });

/**
 * Version of the rule schema. 3 = points on the tens scale with rounding + the winning pair chooses its
 * opener. 4 = points held "abajo" + a tied cerrado goes to the opening team. 5 = the physical tile set
 * is a rule (`tileSet`), defaulting to double-six so every older save keeps playing the same tiles.
 */
export const RULES_VERSION = 5;

/**
 * Data-driven rule variants for Cuban double-six partners ("dominó en parejas").
 * Defaults follow how the game is played at a Cuban table: the pips of a hand are rounded up to the
 * next ten and counted in tens (65 → 70 → 7 points), a match is played to 20, capicúa doubles the hand,
 * an opening pass gives 2 points (which can never win the match by itself), small wins of a team still
 * on 0 stay "abajo" (in a shared pot) and a tied cerrado goes to the team that opened the hand.
 */
export const RULE_SETTINGS: SettingDescriptor[] = [
  // ── Salida ──
  {
    key: 'tileSet',
    group: 'salida',
    type: 'select',
    default: 'double6',
    options: [
      { value: 'double6', label: L('Doble seis (28 fichas)', 'Double six (28 tiles)'), short: L('Doble 6', 'Double 6') },
      { value: 'double9', label: L('Doble nueve (55 fichas)', 'Double nine (55 tiles)'), short: L('Doble 9', 'Double 9') },
    ],
    label: L('Juego de fichas', 'Tile set'),
    short: L('Fichas', 'Tiles'),
    help: L(
      'Doble seis: 28 fichas y 7 por jugador. Doble nueve: 55 fichas y 10 por jugador; las sobrantes quedan apartadas o forman el pozo en Individual.',
      'Double six: 28 tiles and 7 per player. Double nine: 55 tiles and 10 per player; leftovers are set aside or form the boneyard in Individual.',
    ),
  },
  {
    key: 'firstStarter',
    group: 'salida',
    type: 'select',
    default: 'double6',
    options: [
      { value: 'double6', label: L('Sale el doble más alto', 'Highest double opens'), short: L('Doble más alto', 'Highest double') },
      { value: 'double6Free', label: L('El del doble más alto sale con cualquiera', 'Highest-double holder opens with any tile'), short: L('Doble más alto, cualquiera', 'Highest double, any') },
      { value: 'random', label: L('Jugador al azar', 'Random player'), short: L('Al azar', 'Random') },
    ],
    label: L('Salida de la primera mano', 'Opening of the first hand'),
    short: L('1.ª mano', '1st hand'),
    help: L(
      'Quién abre la primera mano y si está obligado a salir con el doble más alto (6-6 en doble seis, 9-9 en doble nueve).',
      'Who opens the first hand and whether they must lead the highest double (6-6 in double-six, 9-9 in double-nine).',
    ),
  },
  {
    key: 'nextStarter',
    group: 'salida',
    type: 'select',
    default: 'winnerTeam',
    options: [
      { value: 'rotate', label: L('Rota a la derecha', 'Rotates to the right'), short: L('rota', 'rotates') },
      { value: 'winner', label: L('Sale el que ganó', 'Hand winner opens'), short: L('sale el ganador', 'winner opens') },
      { value: 'winnerTeam', label: L('Sale la pareja ganadora: elige quién', 'Winning pair opens: they choose who'), short: L('sale la pareja ganadora', 'winning pair opens') },
      { value: 'double6', label: L('Siempre el doble más alto', 'Always the highest double'), short: L('siempre doble más alto', 'always highest double') },
    ],
    label: L('Salida de las siguientes manos', 'Opening of later hands'),
    short: L('Después', 'Later'),
    help: L(
      'Pareja ganadora: la pareja que ganó la mano anterior decide, después de ver sus fichas, cuál de los dos sale. Rotación: sale el siguiente jugador. Si la mano es nula, vuelve a salir el mismo jugador, salvo con rotación.',
      'Winning pair: the pair that won the previous hand decides, after seeing their tiles, which of the two opens. Rotation: the next player opens. After a void hand the same player opens again, except in rotation.',
    ),
  },
  {
    key: 'redealFiveDoubles',
    group: 'salida',
    type: 'toggle',
    default: false,
    label: L('Repartir de nuevo con cinco dobles', 'Reshuffle on five doubles'),
    short: L('Reparto con 5 dobles', 'Redeal on 5 doubles'),
    help: L('Si un jugador recibe 5 o más dobles se vuelven a repartir las fichas.', 'If anyone is dealt 5 or more doubles the tiles are reshuffled.'),
  },
  // ── Puntuación ──
  {
    key: 'target',
    group: 'puntuacion',
    type: 'select',
    default: 20,
    scale: TENS,
    options: [10, 15, 20, 30, 50, 100, 150, 200].map(pts),
    label: L('Partida a', 'Play to'),
    short: L('A', 'To'),
    help: L(
      'La primera pareja en llegar a estos puntos gana la partida. Sin redondeo se cuentan los puntos exactos de las fichas, por eso la meta es diez veces mayor.',
      'First team to reach this score wins the match. Without rounding the exact pips are counted, so the target is ten times larger.',
    ),
  },
  {
    key: 'rounding',
    group: 'puntuacion',
    type: 'select',
    default: 'up',
    options: [
      { value: 'up', label: L('Hacia arriba', 'Up'), short: L('redondeo hacia arriba', 'round up') },
      { value: 'nearest', label: L('Al más cercano', 'Nearest'), short: L('redondeo al más cercano', 'round to nearest') },
      { value: 'down', label: L('Hacia abajo', 'Down'), short: L('redondeo hacia abajo', 'round down') },
      { value: 'none', label: L('Sin redondeo', 'No rounding'), short: L('puntos exactos', 'exact pips') },
    ],
    label: L('Redondeo de los puntos', 'Rounding of points'),
    short: L('Redondeo', 'Rounding'),
    help: L(
      'Los puntos de la mano se redondean a la decena y se dividen entre diez. Hacia arriba: 31 → 40 → 4 puntos, 65 → 70 → 7. Al más cercano: el 5 sube (65 → 7, 64 → 6). Hacia abajo: 69 → 6. Sin redondeo: se suman los puntos exactos (65).',
      'The hand’s pips are rounded to a multiple of ten and divided by ten. Up: 31 → 40 → 4 points, 65 → 70 → 7. Nearest: 5 rounds up (65 → 7, 64 → 6). Down: 69 → 6. No rounding: the exact pips are added (65).',
    ),
  },
  {
    key: 'scoring',
    group: 'puntuacion',
    type: 'select',
    default: 'all',
    options: [
      { value: 'all', label: L('Todos los puntos de la mesa', 'All pips left (incl. partner)'), short: L('todas las manos', 'all hands') },
      { value: 'opponents', label: L('Solo los puntos de los contrarios', "Opponents' pips only"), short: L('solo contrarios', 'opponents only') },
    ],
    label: L('Puntos para el ganador', 'Points for the winner'),
    short: L('Cuenta', 'Counts'),
    help: L(
      'Al estilo cubano se cuentan las fichas que quedan en las cuatro manos.',
      'Cuban style counts the tiles left in all four hands.',
    ),
  },
  {
    key: 'abajo',
    group: 'puntuacion',
    type: 'toggle',
    default: true,
    label: L('Puntos abajo', 'Points held “abajo”'),
    short: L('puntos abajo', 'points abajo'),
    help: L(
      'Si una pareja que todavía tiene 0 puntos gana una mano de 2 puntos o menos (20 o menos en fichas, contando ya la capicúa), esos puntos no se le anotan: quedan abajo, en un fondo común que sigue creciendo. La próxima mano que se anote normalmente se lleva también todo lo de abajo. El pase de salida de una pareja con 0 también queda abajo. Lo que siga abajo al terminar la partida se pierde.',
      'If a team still on 0 wins a hand worth 2 points or less (20 pips or less, capicúa included), those points are not scored: they stay “abajo”, in a shared pot that keeps growing. The next hand that scores normally also takes everything held abajo. The opening pass of a team on 0 also goes abajo. Whatever is still abajo when the match ends is lost.',
    ),
  },
  // ── Cerrado ──
  {
    key: 'tranqueWinner',
    group: 'tranque',
    type: 'select',
    default: 'lowestPlayer',
    options: [
      { value: 'lowestPlayer', label: L('Gana el jugador con menos puntos', 'Lowest individual hand wins'), short: L('gana el jugador con menos', 'lowest player wins') },
      { value: 'lowestTeam', label: L('Gana la pareja con menos puntos', 'Lowest team total wins'), short: L('gana la pareja con menos', 'lowest team wins') },
      { value: 'blockerRisk', label: L('El que cierra el juego arriesga', 'Blocker takes the risk'), short: L('el que cierra arriesga', 'blocker risks') },
    ],
    label: L('Quién gana el juego cerrado', 'Who wins a blocked hand'),
    short: L('Gana', 'Winner'),
    help: L(
      'Con «El que cierra el juego arriesga», la pareja del que cerró gana solo si este tiene menos puntos que ambos contrarios.',
      'With "blocker takes the risk", the blocker\'s team wins only if the blocker has fewer pips than both opponents.',
    ),
  },
  {
    key: 'tranqueTie',
    group: 'tranque',
    type: 'select',
    default: 'mano',
    options: [
      { value: 'mano', label: L('Gana la pareja que salió (la mano)', 'Opening team wins (la mano)'), short: L('empate: gana la mano', 'tie: opener wins') },
      { value: 'void', label: L('Mano nula', 'Hand is void'), short: L('empate: mano nula', 'tie: void') },
      { value: 'blockerLoses', label: L('Pierde el que cerró', 'The blocker loses'), short: L('empate: pierde el que cerró', 'tie: blocker loses') },
    ],
    label: L('Empate en el juego cerrado', 'Tie in a blocked hand'),
    short: L('Empate', 'Tie'),
    help: L(
      'Qué pasa si las dos parejas empatan en el juego cerrado. Al estilo cubano gana la pareja que salió en esa mano (la mano) y se anota los puntos como en cualquier cerrado. También puede anularse la mano o perderla el que cerró.',
      'What happens when both teams tie in a blocked hand. Cuban style, the team that opened that hand (la mano) wins and scores the points like any blocked hand. The hand can also be void, or lost by the blocker.',
    ),
  },
  {
    key: 'tranqueScoring',
    group: 'tranque',
    type: 'select',
    default: 'same',
    options: [
      { value: 'same', label: L('Igual que el dominó', 'Same as a domino'), short: L('cuenta igual', 'scored the same') },
      { value: 'opponents', label: L('Solo los puntos de los perdedores', "Losers' pips only"), short: L('solo perdedores', 'losers only') },
    ],
    label: L('Puntos del juego cerrado', 'Points in a blocked hand'),
    short: L('Puntos', 'Points'),
    help: L(
      'Los puntos del cerrado se redondean igual que los de un dominó.',
      'Blocked-hand points are rounded just like a domino.',
    ),
  },
  // ── Bonos ──
  {
    key: 'capicua',
    group: 'bonos',
    type: 'select',
    default: 'double',
    scale: TENS,
    options: [
      { value: 0, label: L('No', 'Off'), short: L('no', 'off') },
      { value: 'double', label: L('Vale doble', 'Counts double'), short: L('×2', '×2') },
      { value: 1, label: L('+{n} puntos', '+{n} points'), short: L('+{n}', '+{n}') },
      { value: 2, label: L('+{n} puntos', '+{n} points'), short: L('+{n}', '+{n}') },
      { value: 3, label: L('+{n} puntos', '+{n} points'), short: L('+{n}', '+{n}') },
    ],
    label: L('Capicúa', 'Capicúa'),
    help: L(
      'Ganar la mano con una ficha que entraba por los dos extremos. «Vale doble»: primero se redondea y después se dobla (65 → 7, ×2 = 14). También puede dar un premio fijo.',
      'Going out with a tile that fits both ends. "Counts double": round first, then double (65 → 7, ×2 = 14). It can also give a fixed bonus.',
    ),
  },
  {
    key: 'paseSalida',
    group: 'bonos',
    type: 'select',
    default: 2,
    scale: TENS,
    options: [{ value: 0, label: L('No', 'Off'), short: L('no', 'off') }, pts(1), pts(2)],
    label: L('Pase de salida', 'Opening pass'),
    help: L(
      'Si la primera ficha de la mano hace pasar al siguiente jugador, la pareja que salió suma estos puntos en ese momento.',
      'If the first tile of the hand makes the next player pass, the opening team scores these points right away.',
    ),
  },
  {
    key: 'paseSalidaNoWin',
    group: 'bonos',
    type: 'toggle',
    default: true,
    label: L('El pase de salida no puede ganar la partida', 'The opening pass cannot win the match'),
    short: L('sin ganar con el pase', 'cannot win'),
    help: L(
      'Si con el pase de salida la pareja llegaría a la meta (por ejemplo, tiene 18 o 19 de 20), no se suma nada. La partida solo se gana al terminar una mano.',
      'If the opening pass would take the team to the target (say 18 or 19 of 20), nothing is added. The match is only won when a hand ends.',
    ),
  },
  {
    key: 'paseCorrido',
    group: 'bonos',
    type: 'select',
    default: 0,
    scale: TENS,
    options: [{ ...off, short: L('no', 'off') }, pts(1), pts(2), pts(3)],
    label: L('Pase de los tres', 'Triple pass'),
    help: L(
      'Premio cuando una ficha hace pasar a los otros tres y el turno vuelve al mismo jugador. Se suma al terminar la mano.',
      'Bonus when one play makes the other three pass and the turn comes back. Paid when the hand ends.',
    ),
  },
  {
    key: 'chuchazo',
    group: 'bonos',
    type: 'select',
    default: 0,
    scale: TENS,
    options: [{ ...off, short: L('no', 'off') }, pts(1), pts(2), pts(3)],
    label: L('Cierre con doble blanco', 'Double-blank finish'),
    short: L('Doble blanco', 'Double blank'),
    help: L('Premio por ganar la mano con el doble blanco.', 'Bonus for going out with the double blank.'),
  },
  {
    key: 'pollona',
    group: 'bonos',
    type: 'select',
    default: 'off',
    options: [
      { value: 'off', label: L('No', 'Off'), short: L('no', 'off') },
      { value: 'double', label: L('Vale doble', 'Counts double'), short: L('×2', '×2') },
      { value: 'halfTarget', label: L('Gana a mitad de partida', 'Wins at half target'), short: L('a la mitad', 'at half') },
    ],
    label: L('Blanqueo', 'Shutout'),
    help: L(
      'Ganar sin que los contrarios anoten: dobla los puntos finales, o termina la partida al llegar a la mitad.',
      'Winning while the opponents have zero: doubles the final score, or ends the match at half the target.',
    ),
  },
];

export const DEFAULT_RULES: RuleSettings = Object.freeze(
  Object.fromEntries(RULE_SETTINGS.map((d) => [d.key, d.default])),
) as RuleSettings;

// ───────────────────────── individual mode ─────────────────────────

const byKey = (k: string): SettingDescriptor => RULE_SETTINGS.find((d) => d.key === k)!;
/** a pairs descriptor reused in individual mode, in that mode's group and wording */
const shared = (k: string, group: string, help?: { es: string; en: string }): SettingDescriptor => ({ ...byKey(k), group, ...(help ? { help } : {}) });

/**
 * Rule variants of individual play (every player for themselves, 2–4 players). Rules that are the same
 * game rule as in pairs reuse the pairs descriptors (with individual wording); the values are kept per
 * mode, so each mode has its own "Cubano clásico". No abajo, no pase de los tres, no blanqueo here.
 */
export const RULE_SETTINGS_INDIVIDUAL: SettingDescriptor[] = [
  // ── Reparto y pozo ──
  {
    key: 'boneyardDraw',
    group: 'pozo',
    type: 'toggle',
    default: true,
    label: L('Robar del pozo', 'Draw from the boneyard'),
    short: L('se roba del pozo', 'draw from the boneyard'),
    help: L(
      'Con doble seis sobran fichas con 2 o 3 jugadores; con doble nueve sobran con cualquier número. Si no puedes jugar, robas del pozo una a una hasta que salga una que sirva, y la juegas; si el pozo se acaba, pasas. Desactivado: las fichas que sobran quedan apartadas y el que no puede jugar pasa.',
      'With double-six there are leftovers with 2 or 3 players; with double-nine there are leftovers with any count. If you cannot play, you draw one at a time until one fits, and you play it; when the boneyard runs out, you pass. Off: the leftover tiles are set aside and whoever cannot play passes.',
    ),
  },
  shared('tileSet', 'pozo'),
  shared('redealFiveDoubles', 'pozo'),
  // ── Puntuación ──
  shared(
    'target',
    'puntuacion',
    L(
      'El primer jugador en llegar a estos puntos gana la partida. Sin redondeo se cuentan los puntos exactos de las fichas, por eso la meta es diez veces mayor.',
      'First player to reach this score wins the match. Without rounding the exact pips are counted, so the target is ten times larger.',
    ),
  ),
  shared(
    'rounding',
    'puntuacion',
    L(
      'El ganador de la mano suma los puntos de las fichas que les quedan a todos los demás jugadores (las del pozo no cuentan), redondeados a la decena y divididos entre diez. Hacia arriba: 31 → 40 → 4 puntos. Al más cercano: el 5 sube (65 → 7, 64 → 6). Hacia abajo: 69 → 6. Sin redondeo: se suman los puntos exactos.',
      'The hand winner scores the pips left in every other player’s hand (the boneyard does not count), rounded to a multiple of ten and divided by ten. Up: 31 → 40 → 4 points. Nearest: 5 rounds up (65 → 7, 64 → 6). Down: 69 → 6. No rounding: the exact pips are added.',
    ),
  ),
  // ── Cerrado ──
  {
    key: 'soloTie',
    group: 'tranque',
    type: 'select',
    default: 'mano',
    options: [
      { value: 'mano', label: L('Gana el más cercano a la salida', 'Closest to the opener wins'), short: L('empate: gana la mano', 'tie: opener wins') },
      { value: 'void', label: L('Mano nula', 'Hand is void'), short: L('empate: mano nula', 'tie: void') },
    ],
    label: L('Empate en el juego cerrado', 'Tie in a blocked hand'),
    short: L('Empate', 'Tie'),
    help: L(
      'En el cerrado gana el jugador con menos puntos y se anota los de todos los demás. Si empatan varios, gana el que salió en esa mano o, si no está entre ellos, el primero de los empatados que juega después de él. También puede anularse la mano.',
      'In a blocked hand the player with the fewest pips wins and scores everyone else’s. If several tie, the player who opened that hand wins or, if they are not among them, the first of the tied players to play after the opener. The hand can also be void.',
    ),
  },
  // ── Bonos ──
  shared('capicua', 'bonos'),
  shared(
    'paseSalida',
    'bonos',
    L(
      'Si el jugador que sigue al que salió no puede jugar sobre la primera ficha con las fichas que le repartieron (tiene que robar o pasar), el que salió suma estos puntos en ese momento.',
      'If the player after the opener cannot play on the first tile with the tiles they were dealt (they have to draw or pass), the opener scores these points right away.',
    ),
  ),
  shared(
    'paseSalidaNoWin',
    'bonos',
    L(
      'Si con el pase de salida el jugador llegaría a la meta (por ejemplo, tiene 18 o 19 de 20), no se suma nada. La partida solo se gana al terminar una mano.',
      'If the opening pass would take the player to the target (say 18 or 19 of 20), nothing is added. The match is only won when a hand ends.',
    ),
  ),
  shared('chuchazo', 'bonos'),
];

export const DEFAULT_RULES_INDIVIDUAL: RuleSettings = Object.freeze(
  Object.fromEntries(RULE_SETTINGS_INDIVIDUAL.map((d) => [d.key, d.default])),
) as RuleSettings;

/** the descriptor list of a mode */
export const descriptorsFor = (mode: GameMode = 'pairs'): SettingDescriptor[] => (mode === 'individual' ? RULE_SETTINGS_INDIVIDUAL : RULE_SETTINGS);
/** the default rules of a mode */
export const defaultRulesFor = (mode: GameMode = 'pairs'): RuleSettings => (mode === 'individual' ? DEFAULT_RULES_INDIVIDUAL : DEFAULT_RULES);

/** A Cuban double-nine game: 55 tiles, 10 per player and a 100-point match. */
const D9_OVERRIDES: RuleSettings = { tileSet: 'double9', target: 100 };

/** Named rule sets. The first one is the classic default (pairs); then the individual classic. */
export const RULE_PRESETS: RulePreset[] = [
  { id: 'cubano', mode: 'pairs', label: L('Cubano clásico', 'Classic Cuban'), rules: DEFAULT_RULES },
  { id: 'cubanoIndividual', mode: 'individual', label: L('Cubano clásico', 'Classic Cuban'), rules: DEFAULT_RULES_INDIVIDUAL },
  { id: 'cubanoDoble9', mode: 'pairs', label: L('Cubano doble 9', 'Cuban double nine'), rules: { ...DEFAULT_RULES, ...D9_OVERRIDES } },
  { id: 'cubanoIndividualDoble9', mode: 'individual', label: L('Cubano doble 9', 'Cuban double nine'), rules: { ...DEFAULT_RULES_INDIVIDUAL, ...D9_OVERRIDES } },
];

/** The double-nine preset of a base mode, used by the "Aplicar reglas doble 9" editor action. */
export const double9Preset = (mode: GameMode): RulePreset => RULE_PRESETS[mode === 'individual' ? 3 : 2];

/** Fill missing keys with defaults and replace invalid values with defaults (the mode's rule list). */
export function normalizeRules(rules: RuleSettings | undefined, mode: GameMode = 'pairs'): RuleSettings {
  const out: RuleSettings = {};
  for (const d of descriptorsFor(mode)) {
    const v: SettingValue | undefined = rules?.[d.key];
    let ok = false;
    if (v !== undefined) {
      if (d.type === 'toggle') ok = typeof v === 'boolean';
      else ok = !!d.options?.some((o) => o.value === v);
    }
    out[d.key] = ok ? (v as SettingValue) : d.default;
  }
  return out;
}

/** Keys whose meaning is the same in rule schema 1 (raw pips) and 2 (tens scale). */
const PORTABLE_V1_KEYS = ['firstStarter', 'nextStarter', 'redealFiveDoubles', 'scoring', 'tranqueWinner', 'tranqueTie', 'tranqueScoring', 'pollona'];
/** the old defaults: a stored value equal to these was never chosen by the player, so it takes the new default */
const OLD_DEFAULTS: RuleSettings = { firstStarter: 'double6', nextStarter: 'rotate', redealFiveDoubles: false, scoring: 'all', tranqueWinner: 'lowestPlayer', tranqueTie: 'void', tranqueScoring: 'same', pollona: 'off' };

/**
 * Bring stored rules up to RULES_VERSION. From schema 1 (raw-pip targets and bonuses such as
 * 100 / 25) only the structural choices are kept; everything on the points scale takes the new
 * Cuban defaults (the old numbers have no faithful tens-scale equivalent).
 */
export function migrateRules(stored: RuleSettings | undefined, fromVersion: number | undefined): RuleSettings {
  const from = fromVersion ?? 1;
  if (from >= RULES_VERSION) return normalizeRules(stored);
  // schema 4 → 5: every stored choice is kept; the new tile-set rule takes its double-six default.
  if (from === 4) return normalizeRules(stored);
  // schema 3 → 4: a player still on the old "Cubano clásico" (never changed anything) moves to the new
  // one (abajo on, tied cerrado → la mano). A customised set ("Personalizado") keeps every stored choice,
  // including the tie rule; the new abajo key takes its default.
  if (from === 3) return sameRules(stored ?? {}, V3_DEFAULTS) ? { ...DEFAULT_RULES } : normalizeRules(stored);
  const base: RuleSettings = { ...DEFAULT_RULES };
  for (const k of PORTABLE_V1_KEYS) if (stored && stored[k] !== undefined && stored[k] !== OLD_DEFAULTS[k]) base[k] = stored[k];
  return normalizeRules(base);
}

/** "Cubano clásico" as it was in rule schema 3 (before abajo existed, with a void tied cerrado). */
const V3_DEFAULTS: RuleSettings = { ...DEFAULT_RULES, tranqueTie: 'void' };

/** True when two rule sets are the same (after normalizing). */
export function sameRules(a: RuleSettings, b: RuleSettings, mode: GameMode = 'pairs'): boolean {
  const na = normalizeRules(a, mode);
  const nb = normalizeRules(b, mode);
  return descriptorsFor(mode).every((d) => na[d.key] === nb[d.key]);
}

export type Rounding = 'up' | 'nearest' | 'down' | 'none';

/** Typed view over normalized rules. Numeric bonuses and target are on the tens scale (see `unit`). */
export interface Rules {
  /** physical set: the "double6" opener rule means 6-6 here and 9-9 in double-nine */
  tileSet: TileSet;
  target: number;
  rounding: Rounding;
  firstStarter: 'double6' | 'double6Free' | 'random';
  nextStarter: 'rotate' | 'winner' | 'winnerTeam' | 'double6';
  redealFiveDoubles: boolean;
  scoring: 'all' | 'opponents';
  /** small wins (≤ ABAJO_MAX points, see scoring.ts) of a team on 0 go to the shared abajo pot */
  abajo: boolean;
  tranqueWinner: 'lowestPlayer' | 'lowestTeam' | 'blockerRisk';
  tranqueTie: 'void' | 'blockerLoses' | 'mano';
  tranqueScoring: 'same' | 'opponents';
  capicua: 0 | 'double' | number;
  chuchazo: number;
  paseSalida: number;
  paseSalidaNoWin: boolean;
  paseCorrido: number;
  pollona: 'off' | 'double' | 'halfTarget';
  /** individual: a player who cannot play draws from the boneyard (2–3 players) */
  boneyardDraw: boolean;
  /** individual: a tied cerrado goes to the tied player closest to the opener ('mano') or is void */
  soloTie: 'mano' | 'void';
}

/** the pairs-only rules as they apply in individual mode (off / neutral) */
const INDIVIDUAL_FIXED: RuleSettings = {
  firstStarter: 'double6',
  nextStarter: 'winner',
  scoring: 'all',
  abajo: false,
  tranqueWinner: 'lowestPlayer',
  tranqueTie: 'mano',
  tranqueScoring: 'same',
  paseCorrido: 0,
  pollona: 'off',
};
/** the individual-only rules as they apply in pairs */
const PAIRS_FIXED: RuleSettings = { boneyardDraw: false, soloTie: 'mano' };

export function readRules(r: RuleSettings, mode: GameMode = 'pairs'): Rules {
  if (mode === 'individual') return { ...INDIVIDUAL_FIXED, ...normalizeRules(r, 'individual') } as unknown as Rules;
  return { ...normalizeRules(r), ...PAIRS_FIXED } as unknown as Rules;
}

/** Points per tens-scale unit: 1 when rounding to tens, 10 when exact pips are counted. */
export function scoreUnit(r: Pick<Rules, 'rounding'>): number {
  return r.rounding === 'none' ? 10 : 1;
}

/** The effective match target in points for these rules. */
export function matchTarget(rules: RuleSettings): number {
  const r = readRules(rules);
  return r.target * scoreUnit(r);
}
