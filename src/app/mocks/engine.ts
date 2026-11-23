/**
 * DEV MOCK ENGINE (selected with ?mock=1). A small but complete Cuban-ish engine so the UI and
 * controller can be exercised end-to-end before the real src/engine exists. Not used in production.
 */
import type {
  Bonus,
  Difficulty,
  EngineApi,
  GameEvent,
  HandState,
  MatchState,
  Move,
  Pip,
  PlacedTile,
  RuleSettings,
  Seat,
  SettingDescriptor,
  Team,
  Tile,
} from '../../contracts';
import { teamOf } from '../../contracts';

const ALL_TILES: Tile[] = [];
for (let a = 0; a <= 6; a++) for (let b = a; b <= 6; b++) ALL_TILES.push({ id: ALL_TILES.length, a: a as Pip, b: b as Pip });

const RULE_SETTINGS: SettingDescriptor[] = [
  {
    // display-only here: this dev mock still deals the double-six set; the selector is for exercising the UI
    key: 'tileSet',
    group: 'salida',
    type: 'select',
    default: 'double6',
    options: [
      { value: 'double6', label: { es: 'Doble seis (28 fichas)', en: 'Double six (28 tiles)' } },
      { value: 'double9', label: { es: 'Doble nueve (55 fichas)', en: 'Double nine (55 tiles)' } },
    ],
    label: { es: 'Juego de fichas', en: 'Tile set' },
    help: {
      es: 'Este mock solo reparte doble seis; el selector sirve para probar la interfaz.',
      en: 'This mock only deals double six; the selector is for exercising the UI.',
    },
  },
  {
    key: 'target',
    group: 'puntuacion',
    type: 'select',
    default: 100,
    options: [
      { value: 50, label: { es: '50 (rápida)', en: '50 (quick)' } },
      { value: 100, label: { es: '100', en: '100' } },
      { value: 150, label: { es: '150', en: '150' } },
      { value: 200, label: { es: '200', en: '200' } },
    ],
    label: { es: 'Partida a', en: 'Play to' },
    help: { es: 'Puntos que hay que alcanzar para ganar la partida.', en: 'Points needed to win the match.' },
  },
  {
    key: 'countMode',
    group: 'puntuacion',
    type: 'select',
    default: 'all',
    options: [
      { value: 'all', label: { es: 'Todas las fichas', en: 'All tiles' } },
      { value: 'opponents', label: { es: 'Solo los contrarios', en: 'Opponents only' } },
    ],
    label: { es: 'Qué se cuenta', en: 'What counts' },
    help: { es: 'Al ganar la mano, se suman los puntos de todos o solo de la pareja contraria.', en: 'On domino, add up everyone’s pips or only the opponents’.' },
  },
  {
    key: 'firstHandDoubleSix',
    group: 'salida',
    type: 'toggle',
    default: true,
    label: { es: 'Sale el doble seis', en: 'Double six opens' },
    help: { es: 'La primera mano la abre quien tenga el doble seis (6-6).', en: 'The first hand is opened by whoever holds the 6-6.' },
  },
  {
    key: 'capicua',
    group: 'bonos',
    type: 'toggle',
    default: true,
    label: { es: 'Capicúa', en: 'Capicúa' },
    help: { es: 'Bono de 25 si la última ficha cuadra por las dos puntas.', en: '25 bonus if the last tile fits both ends.' },
  },
  {
    key: 'tranqueRule',
    group: 'tranque',
    type: 'select',
    default: 'team',
    options: [
      { value: 'team', label: { es: 'Gana la pareja con menos', en: 'Lowest team wins' } },
      { value: 'player', label: { es: 'Gana el jugador con menos', en: 'Lowest player wins' } },
    ],
    label: { es: 'Quién gana el juego cerrado', en: 'Who wins a blocked game' },
  },
];

const DEFAULT_RULES: RuleSettings = Object.fromEntries(RULE_SETTINGS.map((d) => [d.key, d.default]));

function rand(m: { rng: number }): number {
  // mulberry32
  let t = (m.rng = (m.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const pips = (t: Tile) => t.a + t.b;
const next = (s: Seat) => ((s + 1) % 4) as Seat;

function createMatch(rules: RuleSettings, seed?: number): MatchState {
  return {
    rules: { ...DEFAULT_RULES, ...rules },
    scores: [0, 0],
    handsWon: [0, 0],
    hand: null,
    lastHandWinner: null,
    over: false,
    winner: null,
    rng: seed ?? (Math.random() * 2 ** 31) | 0,
  };
}

function startHand(match0: MatchState) {
  const m = clone(match0);
  const deck = ALL_TILES.slice();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand(m) * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const hands = [0, 1, 2, 3].map((s) => deck.slice(s * 7, s * 7 + 7).sort((x, y) => x.id - y.id));
  const handNo = (m.hand?.handNo ?? 0) + 1;
  let starter: Seat;
  if (handNo === 1 && m.rules.firstHandDoubleSix !== false) starter = hands.findIndex((h) => h.some((t) => t.id === 27)) as Seat;
  else starter = m.lastHandWinner ?? (m.hand ? next(m.hand.starter) : 0);
  const hand: HandState = { handNo, hands, chain: [], ends: null, turn: starter, starter, passesInRow: 0, passedOn: [[], [], [], []], over: false };
  m.hand = hand;
  const events: GameEvent[] = [{ type: 'handStart', handNo, hands: clone(hands), starter, scores: [...m.scores] as [number, number] }];
  return { match: m, events };
}

function fits(t: Tile, v: Pip) {
  return t.a === v || t.b === v;
}

function legalFor(h: HandState, seat: Seat): Move[] {
  const hand = h.hands[seat];
  if (!h.ends) {
    const opening = h.handNo === 1 ? hand.filter((t) => t.id === 27) : [];
    return (opening.length ? opening : hand).map((t) => ({ kind: 'play', seat, tileId: t.id, side: 'right' }) as Move);
  }
  const moves: Move[] = [];
  for (const t of hand) {
    if (fits(t, h.ends.left)) moves.push({ kind: 'play', seat, tileId: t.id, side: 'left' });
    if (fits(t, h.ends.right) && !(h.ends.left === h.ends.right && fits(t, h.ends.left))) moves.push({ kind: 'play', seat, tileId: t.id, side: 'right' });
  }
  return moves.length ? moves : [{ kind: 'pass', seat }];
}

function legalMoves(m: MatchState): Move[] {
  if (!m.hand || m.hand.over) return [];
  return legalFor(m.hand, m.hand.turn);
}

function applyMove(match0: MatchState, move: Move) {
  const m = clone(match0);
  const h = m.hand!;
  const events: GameEvent[] = [];
  if (move.kind !== 'play') {
    h.passesInRow++;
    if (h.ends) h.passedOn[move.seat].push(h.ends.left, h.ends.right);
    events.push({ type: 'pass', seat: move.seat, ends: { ...h.ends! } });
    h.turn = next(h.turn);
  } else {
    const hand = h.hands[move.seat];
    const idx = hand.findIndex((t) => t.id === move.tileId);
    const tile = hand.splice(idx, 1)[0];
    const isFirst = !h.ends;
    const prevEnds = h.ends ? { ...h.ends } : null;
    let outer: Pip;
    if (!h.ends) {
      outer = tile.b;
      h.ends = { left: tile.a, right: tile.b };
    } else {
      const end = h.ends[move.side];
      outer = tile.a === end ? tile.b : tile.a;
      h.ends[move.side] = outer;
    }
    const placed: PlacedTile = { tile, seat: move.seat, side: move.side, outer };
    h.chain.push(placed);
    h.passesInRow = 0;
    events.push({ type: 'play', seat: move.seat, tile, side: move.side, placed, ends: { ...h.ends }, tilesLeft: hand.length, isFirst });
    if (hand.length === 0) {
      const capicua =
        !!m.rules.capicua && !!prevEnds && prevEnds.left !== prevEnds.right && fits(tile, prevEnds.left) && fits(tile, prevEnds.right);
      endHand(m, events, 'domino', move.seat, capicua);
      return { match: m, events };
    }
    h.turn = next(h.turn);
  }
  // tranque: nobody can play
  const anyone = ([0, 1, 2, 3] as Seat[]).some((s) => legalFor(h, s)[0].kind === 'play');
  if (!anyone) endHand(m, events, 'blocked', null, false);
  return { match: m, events };
}

function endHand(m: MatchState, events: GameEvent[], reason: 'domino' | 'blocked', seat: Seat | null, capicua: boolean) {
  const h = m.hand!;
  h.over = true;
  const pipCounts = h.hands.map((hh) => hh.reduce((s, t) => s + pips(t), 0)) as [number, number, number, number];
  let winnerSeat = seat;
  if (reason === 'blocked') {
    if (m.rules.tranqueRule === 'player') {
      const min = Math.min(...pipCounts);
      const seats = pipCounts.flatMap((p, i) => (p === min ? [i as Seat] : []));
      winnerSeat = new Set(seats.map(teamOf)).size === 1 ? seats[0] : null;
    } else {
      const t0 = pipCounts[0] + pipCounts[2];
      const t1 = pipCounts[1] + pipCounts[3];
      if (t0 !== t1) {
        const pair: Seat[] = t0 < t1 ? [0, 2] : [1, 3];
        winnerSeat = pipCounts[pair[0]] <= pipCounts[pair[1]] ? pair[0] : pair[1];
      } else winnerSeat = null;
    }
  }
  const winnerTeam: Team | null = winnerSeat === null ? null : teamOf(winnerSeat);
  let points = 0;
  if (winnerTeam !== null) {
    points =
      m.rules.countMode === 'opponents'
        ? pipCounts.filter((_, i) => teamOf(i as Seat) !== winnerTeam).reduce((a, b) => a + b, 0)
        : pipCounts.reduce((a, b) => a + b, 0);
  }
  const bonuses: Bonus[] = [];
  if (capicua && winnerTeam !== null) bonuses.push({ id: 'capicua', label: { es: 'Capicúa', en: 'Capicúa' }, points: 25, team: winnerTeam });
  if (winnerTeam !== null) {
    m.scores[winnerTeam] += points + bonuses.reduce((a, b) => a + b.points, 0);
    m.handsWon[winnerTeam]++;
  }
  m.lastHandWinner = winnerSeat ?? m.lastHandWinner;
  events.push({
    type: 'handEnd',
    reason,
    winnerSeat,
    winnerTeam,
    points,
    bonuses,
    pipCounts,
    remaining: clone(h.hands),
    scores: [...m.scores] as [number, number],
  });
  const target = Number(m.rules.target ?? 100);
  const best: Team | null = m.scores[0] >= target || m.scores[1] >= target ? (m.scores[0] >= m.scores[1] ? 0 : 1) : null;
  if (best !== null) {
    m.over = true;
    m.winner = best;
    const mb: Bonus[] = [];
    if (m.scores[best === 0 ? 1 : 0] === 0) mb.push({ id: 'pollona', label: { es: 'Blanqueo', en: 'Shutout' }, points: 0, team: best });
    events.push({ type: 'matchEnd', winner: best, scores: [...m.scores] as [number, number], bonuses: mb });
  }
}

function chooseMove(m: MatchState, _d: Difficulty): Move {
  const moves = legalMoves(m);
  const h = m.hand!;
  let best = moves[0];
  let bestScore = -1;
  for (const mv of moves) {
    const s = mv.kind === 'play' ? pips(h.hands[h.turn].find((t) => t.id === mv.tileId)!) + rand({ rng: m.rng + mv.tileId }) * 3 : 0;
    if (s > bestScore) [best, bestScore] = [mv, s];
  }
  return best;
}

export const engine: EngineApi = { RULE_SETTINGS, DEFAULT_RULES, ALL_TILES, createMatch, startHand, legalMoves, applyMove, chooseMove };
