import type { RulePreset, RuleSettings, SettingDescriptor, SettingValue } from '../contracts';

const L = (es: string, en: string) => ({ es, en });
const off = { value: 0, label: L('No', 'Off') };
/** numeric options on the tens scale: labels carry {n}, shown ×10 when rounding is 'none' */
const TENS = { key: 'rounding', when: 'none', factor: 10 } as const;
const pts = (v: number) => ({ value: v, label: L('{n} puntos', '{n} points'), short: L('{n}', '{n}') });

/** Version of the rule schema. 3 = points on the tens scale with rounding + the winning pair chooses its opener. */
export const RULES_VERSION = 3;

/**
 * Data-driven rule variants for Cuban double-six partners ("dominó en parejas").
 * Defaults follow how the game is played at a Cuban table: the pips of a hand are rounded up to the
 * next ten and counted in tens (65 → 70 → 7 points), a match is played to 20, capicúa doubles the hand
 * and an opening pass gives 2 points (which can never win the match by itself).
 */
export const RULE_SETTINGS: SettingDescriptor[] = [
  // ── Salida ──
  {
    key: 'firstStarter',
    group: 'salida',
    type: 'select',
    default: 'double6',
    options: [
      { value: 'double6', label: L('Sale el doble seis', 'Double six opens'), short: L('Doble seis', 'Double six') },
      { value: 'double6Free', label: L('El del doble seis sale con cualquiera', 'Double-six holder opens with any tile'), short: L('Doble seis, cualquiera', 'Double six, any') },
      { value: 'random', label: L('Jugador al azar', 'Random player'), short: L('Al azar', 'Random') },
    ],
    label: L('Salida de la primera mano', 'Opening of the first hand'),
    short: L('1.ª mano', '1st hand'),
    help: L(
      'Quién abre la primera mano y si está obligado a salir con el doble seis.',
      'Who opens the first hand and whether they must lead the double six.',
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
      { value: 'double6', label: L('Siempre el doble seis', 'Always the double six'), short: L('siempre doble seis', 'always double six') },
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
    options: [10, 15, 20, 30].map(pts),
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
    default: 'void',
    options: [
      { value: 'void', label: L('Mano nula', 'Hand is void'), short: L('empate: mano nula', 'tie: void') },
      { value: 'blockerLoses', label: L('Pierde el que cerró', 'The blocker loses'), short: L('empate: pierde el que cerró', 'tie: blocker loses') },
      { value: 'mano', label: L('Gana la pareja que salió', 'Opening team wins'), short: L('empate: gana la salida', 'tie: opener wins') },
    ],
    label: L('Empate en el juego cerrado', 'Tie in a blocked hand'),
    short: L('Empate', 'Tie'),
    help: L('Qué pasa si las dos parejas empatan en el juego cerrado.', 'What happens when both teams tie in a blocked hand.'),
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

/** Named rule sets. The first one is the classic default. */
export const RULE_PRESETS: RulePreset[] = [{ id: 'cubano', label: L('Cubano clásico', 'Classic Cuban'), rules: DEFAULT_RULES }];

/** Fill missing keys with defaults and replace invalid values with defaults. */
export function normalizeRules(rules: RuleSettings | undefined): RuleSettings {
  const out: RuleSettings = {};
  for (const d of RULE_SETTINGS) {
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
  if ((fromVersion ?? 1) >= RULES_VERSION) return normalizeRules(stored);
  const base: RuleSettings = { ...DEFAULT_RULES };
  for (const k of PORTABLE_V1_KEYS) if (stored && stored[k] !== undefined && stored[k] !== OLD_DEFAULTS[k]) base[k] = stored[k];
  return normalizeRules(base);
}

/** True when two rule sets are the same (after normalizing). */
export function sameRules(a: RuleSettings, b: RuleSettings): boolean {
  const na = normalizeRules(a);
  const nb = normalizeRules(b);
  return RULE_SETTINGS.every((d) => na[d.key] === nb[d.key]);
}

export type Rounding = 'up' | 'nearest' | 'down' | 'none';

/** Typed view over normalized rules. Numeric bonuses and target are on the tens scale (see `unit`). */
export interface Rules {
  target: number;
  rounding: Rounding;
  firstStarter: 'double6' | 'double6Free' | 'random';
  nextStarter: 'rotate' | 'winner' | 'winnerTeam' | 'double6';
  redealFiveDoubles: boolean;
  scoring: 'all' | 'opponents';
  tranqueWinner: 'lowestPlayer' | 'lowestTeam' | 'blockerRisk';
  tranqueTie: 'void' | 'blockerLoses' | 'mano';
  tranqueScoring: 'same' | 'opponents';
  capicua: 0 | 'double' | number;
  chuchazo: number;
  paseSalida: number;
  paseSalidaNoWin: boolean;
  paseCorrido: number;
  pollona: 'off' | 'double' | 'halfTarget';
}

export function readRules(r: RuleSettings): Rules {
  return normalizeRules(r) as unknown as Rules;
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
