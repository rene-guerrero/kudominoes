import type {
  Bonus,
  GameEvent,
  HandState,
  MatchState,
  Move,
  Pip,
  PlacedTile,
  RuleSettings,
  Seat,
  Team,
  Tile,
} from '../contracts';
import { Rng } from './rng';
import { normalizeRules, readRules, scoreUnit, type Rules } from './rules';
import { capicuaDoubleTotal, resolveHandCore, roundCode, toScoreRules } from './scoring';
import { ALL_TILES, DOUBLE_BLANK_ID, DOUBLE_SIX_ID, handPips } from './tiles';

const teamOf = (s: number): Team => (s & 1) as Team;
const nextSeat = (s: number): Seat => ((s + 1) & 3) as Seat;

/** Engine-internal extension of HandState (extra fields are optional so plain HandStates still work). */
export interface EngineHand extends HandState {
  /** bonuses earned during the hand and paid at hand end (pase corrido) */
  pendingBonuses?: Bonus[];
  /** bonuses already credited during the hand (pase de salida), listed again in the hand summary */
  earlyBonuses?: Bonus[];
}

export const BONUS_LABELS: Record<string, { es: string; en: string }> = {
  capicua: { es: 'Capicúa', en: 'Capicúa' },
  chuchazo: { es: 'Cierre con doble blanco', en: 'Double-blank finish' },
  'pase-salida': { es: 'Pase de salida', en: 'Opening pass' },
  'pase-corrido': { es: 'Pase de los tres', en: 'Triple pass' },
  pollona: { es: 'Blanqueo', en: 'Shutout' },
};

const bonus = (id: string, points: number, team: Team): Bonus => ({ id, label: BONUS_LABELS[id], points, team });

// ───────────────────────── match / hand setup ─────────────────────────

export function createMatch(rules: RuleSettings, seed?: number): MatchState {
  const s = seed === undefined ? Math.floor(Math.random() * 4294967296) | 0 : seed | 0;
  return {
    rules: normalizeRules(rules),
    scores: [0, 0],
    handsWon: [0, 0],
    hand: null,
    lastHandWinner: null,
    over: false,
    winner: null,
    rng: s,
  };
}

/** Does this hand require the opener to lead the double six? */
export function mustOpenDoubleSix(r: Rules, handNo: number): boolean {
  return handNo === 1 ? r.firstStarter === 'double6' : r.nextStarter === 'double6';
}

function countDoubles(h: readonly Tile[]): number {
  let n = 0;
  for (const t of h) if (t.a === t.b) n++;
  return n;
}

function holderOf(hands: Tile[][], id: number): Seat {
  for (let s = 0; s < 4; s++) if (hands[s].some((t) => t.id === id)) return s as Seat;
  throw new Error('tile not dealt');
}

export function deal(rng: Rng, redealFiveDoubles: boolean): Tile[][] {
  for (;;) {
    const ids = ALL_TILES.map((t) => t.id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      const tmp = ids[i];
      ids[i] = ids[j];
      ids[j] = tmp;
    }
    const hands: Tile[][] = [0, 1, 2, 3].map((s) =>
      ids
        .slice(s * 7, s * 7 + 7)
        .sort((x, y) => x - y)
        .map((id) => ALL_TILES[id]),
    );
    if (!redealFiveDoubles || hands.every((h) => countDoubles(h) < 5)) return hands;
  }
}

function pickStarter(match: MatchState, r: Rules, handNo: number, hands: Tile[][], rng: Rng): Seat {
  if (handNo === 1) {
    if (r.firstStarter === 'random') return rng.int(4) as Seat;
    return holderOf(hands, DOUBLE_SIX_ID);
  }
  const prev = match.hand ? match.hand.starter : (0 as Seat);
  const w = match.lastHandWinner;
  switch (r.nextStarter) {
    case 'double6':
      return holderOf(hands, DOUBLE_SIX_ID);
    case 'rotate':
      return nextSeat(prev);
    case 'winner':
      return w === null ? prev : w;
    case 'winnerTeam':
      // the winning pair chooses after seeing their tiles (pendingStarterChoice); provisional: the winner.
      // After a void hand nobody won: the same player opens again.
      return w === null ? prev : w;
  }
}

/** Does this hand start with the winning pair choosing its opener? */
function needsStarterChoice(match: MatchState, r: Rules, handNo: number): boolean {
  return handNo > 1 && r.nextStarter === 'winnerTeam' && match.lastHandWinner !== null;
}

/** The choosing team picks which of its two players opens. */
export function chooseStarter(match: MatchState, seat: Seat): MatchState {
  const hand = match.hand;
  if (!hand || hand.over || hand.pendingStarterChoice == null) throw new Error('no starter choice pending');
  if (teamOf(seat) !== hand.pendingStarterChoice) throw new Error(`seat ${seat} is not in the choosing team`);
  return { ...match, hand: { ...hand, starter: seat, turn: seat, pendingStarterChoice: null } };
}

/**
 * Would this player like to open, judging only its own tiles? A strong opening hand has a long suit
 * (4+ tiles of one number) or a 3-suit backed by doubles. This is the one bit a player says aloud.
 */
export function starterStrength(tiles: readonly Tile[]): number {
  const suit = [0, 0, 0, 0, 0, 0, 0];
  for (const t of tiles) {
    suit[t.a]++;
    if (t.b !== t.a) suit[t.b]++;
  }
  const longest = Math.max(...suit);
  return longest * 3 + countDoubles(tiles) * 1.5 + handPips(tiles) / 20;
}
export const STARTER_WANTS = 12.5;

export function starterPreference(match: MatchState, seat: Seat): boolean {
  return starterStrength(match.hand!.hands[seat]) >= STARTER_WANTS;
}

/** A CPU pair decides using only each player's spoken preference: the one who wants to open, else the hand winner. */
export function cpuStarter(match: MatchState): Seat {
  const hand = match.hand!;
  const team = hand.pendingStarterChoice ?? teamOf(hand.starter);
  const w = (match.lastHandWinner !== null && teamOf(match.lastHandWinner) === team ? match.lastHandWinner : team) as Seat;
  const p = ((w + 2) & 3) as Seat;
  const ww = starterPreference(match, w);
  const pw = starterPreference(match, p);
  return pw && !ww ? p : w;
}

export function startHand(match: MatchState): { match: MatchState; events: GameEvent[] } {
  if (match.over) throw new Error('match is over');
  if (match.hand && !match.hand.over) throw new Error('hand in progress');
  const r = readRules(match.rules);
  const rng = new Rng(match.rng);
  const handNo = (match.hand?.handNo ?? 0) + 1;
  const hands = deal(rng, r.redealFiveDoubles);
  const starter = pickStarter(match, r, handNo, hands, rng);
  const hand: EngineHand = {
    handNo,
    hands,
    chain: [],
    ends: null,
    turn: starter,
    starter,
    passesInRow: 0,
    passedOn: [[], [], [], []],
    over: false,
    pendingBonuses: [],
    pendingStarterChoice: needsStarterChoice(match, r, handNo) ? teamOf(starter) : null,
  };
  const next: MatchState = { ...match, hand, rng: rng.s };
  return {
    match: next,
    events: [
      { type: 'handStart', handNo, hands: hands.map((h) => h.slice()), starter, scores: [match.scores[0], match.scores[1]] },
    ],
  };
}

// ───────────────────────── legality ─────────────────────────

/** Legal moves for `seat` in `hand` (independent of whose turn it is). */
export function movesFor(hand: HandState, seat: Seat, rules: Rules): Move[] {
  const tiles = hand.hands[seat];
  const out: Move[] = [];
  if (!hand.ends) {
    if (mustOpenDoubleSix(rules, hand.handNo)) {
      if (tiles.some((t) => t.id === DOUBLE_SIX_ID)) out.push({ kind: 'play', seat, tileId: DOUBLE_SIX_ID, side: 'right' });
    } else {
      for (const t of tiles) out.push({ kind: 'play', seat, tileId: t.id, side: 'right' });
    }
  } else {
    const { left, right } = hand.ends;
    for (const t of tiles) {
      if (t.a === left || t.b === left) out.push({ kind: 'play', seat, tileId: t.id, side: 'left' });
      if (t.a === right || t.b === right) out.push({ kind: 'play', seat, tileId: t.id, side: 'right' });
    }
  }
  if (out.length === 0) out.push({ kind: 'pass', seat });
  return out;
}

export function legalMoves(match: MatchState): Move[] {
  const hand = match.hand;
  if (!hand || hand.over || match.over || hand.pendingStarterChoice != null) return [];
  return movesFor(hand, hand.turn, readRules(match.rules));
}

/** True when nobody can play: every tile carrying either end pip is already on the table. */
export function isBlocked(chain: readonly PlacedTile[], ends: { left: Pip; right: Pip }): boolean {
  let nl = 0;
  let nr = 0;
  for (const p of chain) {
    if (p.tile.a === ends.left || p.tile.b === ends.left) nl++;
    if (p.tile.a === ends.right || p.tile.b === ends.right) nr++;
  }
  return nl === 7 && nr === 7;
}

// ───────────────────────── transitions ─────────────────────────

export function applyMove(match: MatchState, move: Move): { match: MatchState; events: GameEvent[] } {
  const hand = match.hand as EngineHand | null;
  if (!hand || hand.over || match.over) throw new Error('no hand in progress');
  if (hand.pendingStarterChoice != null) throw new Error('the opening team has not chosen its opener yet');
  if (move.seat !== hand.turn) throw new Error(`not seat ${move.seat}'s turn`);
  const r = readRules(match.rules);
  const legal = movesFor(hand, hand.turn, r);
  const ok = legal.some((m) =>
    m.kind === 'pass' ? move.kind === 'pass' : move.kind === 'play' && m.tileId === move.tileId && m.side === move.side,
  );
  if (!ok) throw new Error(`illegal move ${JSON.stringify(move)}`);

  const seat = hand.turn;
  const events: GameEvent[] = [];
  const pending = (hand.pendingBonuses ?? []).slice();

  if (move.kind === 'pass') {
    const ends = hand.ends!;
    const passedOn = hand.passedOn.map((p) => p.slice());
    for (const v of [ends.left, ends.right]) if (!passedOn[seat].includes(v)) passedOn[seat].push(v);
    passedOn[seat].sort((a, b) => a - b);
    const passEv: Extract<GameEvent, { type: 'pass' }> = { type: 'pass', seat, ends: { ...ends } };
    let scores = match.scores;
    let early = hand.earlyBonuses ?? [];
    // Pase de salida: credited immediately (it shows on the scoreboard right away). It never ends the
    // match by itself: the match is only decided in finishHand. With the guard on, a bonus that would
    // reach the target is not added at all.
    if (r.paseSalida > 0 && hand.chain.length === 1 && hand.passesInRow === 0 && seat === nextSeat(hand.chain[0].seat)) {
      const team = teamOf(hand.starter);
      const b = bonus('pase-salida', r.paseSalida * scoreUnit(r), team);
      if (r.paseSalidaNoWin && match.scores[team] + b.points >= r.target * scoreUnit(r)) {
        passEv.bonusBlocked = b;
      } else {
        scores = [match.scores[0], match.scores[1]];
        scores[team] += b.points;
        passEv.bonus = b;
        passEv.scores = [scores[0], scores[1]];
        early = [...early, b];
      }
    }
    const passesInRow = hand.passesInRow + 1;
    if (r.paseCorrido > 0 && passesInRow === 3) {
      pending.push(bonus('pase-corrido', r.paseCorrido * scoreUnit(r), teamOf(hand.chain[hand.chain.length - 1].seat)));
    }
    events.push(passEv);
    const nh: EngineHand = { ...hand, passedOn, passesInRow, turn: nextSeat(seat), pendingBonuses: pending, earlyBonuses: early };
    const nm: MatchState = { ...match, hand: nh, scores };
    if (passesInRow >= 4) {
      // Defensive: cannot normally happen because blocks are detected right after the blocking play.
      return finishHand(nm, nh, r, true, hand.chain[hand.chain.length - 1].seat, [], events);
    }
    return { match: nm, events };
  }

  const tile = ALL_TILES[move.tileId];
  const first = hand.ends === null;
  let placed: PlacedTile;
  let ends: { left: Pip; right: Pip };
  if (first) {
    placed = { tile, seat, side: 'right', outer: tile.b };
    ends = { left: tile.a, right: tile.b };
  } else {
    const v = hand.ends![move.side];
    const other = (tile.a === v ? tile.b : tile.a) as Pip;
    placed = { tile, seat, side: move.side, outer: other };
    ends = { ...hand.ends!, [move.side]: other };
  }
  const hands = hand.hands.map((h, s) => (s === seat ? h.filter((t) => t.id !== tile.id) : h));
  const chain = [...hand.chain, placed];
  events.push({
    type: 'play',
    seat,
    tile,
    side: placed.side,
    placed,
    ends: { ...ends },
    tilesLeft: hands[seat].length,
    isFirst: first,
    ...(move.slam ? { slam: true } : {}),
  });
  const nh: EngineHand = { ...hand, hands, chain, ends, passesInRow: 0, turn: nextSeat(seat), pendingBonuses: pending };
  const nm: MatchState = { ...match, hand: nh };

  if (hands[seat].length === 0) {
    const extra: Bonus[] = [];
    const prev = hand.ends;
    const capicua =
      !!prev && prev.left !== prev.right && ((tile.a === prev.left && tile.b === prev.right) || (tile.a === prev.right && tile.b === prev.left));
    // capicúa ×2 is computed in finishHand (it depends on the rounded hand points)
    if (capicua && typeof r.capicua === 'number' && r.capicua > 0) extra.push(bonus('capicua', r.capicua * scoreUnit(r), teamOf(seat)));
    if (r.chuchazo > 0 && tile.id === DOUBLE_BLANK_ID) extra.push(bonus('chuchazo', r.chuchazo * scoreUnit(r), teamOf(seat)));
    return finishHand(nm, nh, r, false, seat, extra, events, capicua && r.capicua === 'double');
  }
  if (isBlocked(chain, ends)) return finishHand(nm, nh, r, true, seat, [], events);
  return { match: nm, events };
}

function finishHand(
  match: MatchState,
  hand: EngineHand,
  r: Rules,
  blocked: boolean,
  lastSeat: Seat,
  extra: Bonus[],
  events: GameEvent[],
  capicuaDouble = false,
): { match: MatchState; events: GameEvent[] } {
  const pipCounts = hand.hands.map(handPips) as [number, number, number, number];
  const sr = toScoreRules(r);
  const res = resolveHandCore(sr, blocked, pipCounts, lastSeat, hand.starter);
  const ws = (res & 7) - 1;
  const winnerSeat = ws < 0 ? null : (ws as Seat);
  const winnerTeam = winnerSeat === null ? null : teamOf(winnerSeat);
  const rawPips = winnerSeat === null ? 0 : res >> 3;
  const points = roundCode(rawPips, sr.round);
  const bonuses = [...(hand.pendingBonuses ?? []), ...extra];
  if (capicuaDouble && winnerTeam !== null) {
    const extraPts = capicuaDoubleTotal(rawPips, sr.round) - points;
    bonuses.push({ ...bonus('capicua', extraPts, winnerTeam), kind: 'double' });
  }
  const target = r.target * scoreUnit(r);
  const scores: [number, number] = [match.scores[0], match.scores[1]];
  const handsWon: [number, number] = [match.handsWon[0], match.handsWon[1]];
  if (winnerTeam !== null) {
    scores[winnerTeam] += points;
    handsWon[winnerTeam]++;
  }
  for (const b of bonuses) scores[b.team] += b.points;

  const doneHand: EngineHand = { ...hand, over: true, pendingBonuses: [] };
  const early = hand.earlyBonuses ?? [];
  events.push({
    type: 'handEnd',
    reason: blocked ? 'blocked' : 'domino',
    winnerSeat,
    winnerTeam,
    points,
    bonuses,
    pipCounts,
    remaining: hand.hands.map((h) => h.slice()),
    scores: [scores[0], scores[1]],
    rawPips,
    rounding: r.rounding,
    ...(early.length ? { earlyBonuses: early.slice() } : {}),
  });

  // The match is only ever decided here, at the end of a hand.
  let winner: Team | null = null;
  const matchBonuses: Bonus[] = [];
  if (scores[0] >= target || scores[1] >= target) {
    winner = scores[0] > scores[1] ? 0 : scores[1] > scores[0] ? 1 : (winnerTeam ?? 0);
  } else if (r.pollona === 'halfTarget') {
    const half = Math.ceil(target / 2);
    for (const t of [0, 1] as Team[]) {
      if (scores[t] >= half && scores[1 - t] === 0) {
        winner = t;
        matchBonuses.push(bonus('pollona', 0, t));
      }
    }
  }
  if (winner !== null && r.pollona === 'double' && scores[1 - winner] === 0) {
    matchBonuses.push(bonus('pollona', scores[winner], winner));
    scores[winner] *= 2;
  }
  const next: MatchState = {
    ...match,
    hand: doneHand,
    scores,
    handsWon,
    lastHandWinner: winnerSeat,
    over: winner !== null,
    winner,
  };
  if (winner !== null) events.push({ type: 'matchEnd', winner, scores: [scores[0], scores[1]], bonuses: matchBonuses });
  return { match: next, events };
}
