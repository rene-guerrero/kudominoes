import type { Difficulty, MatchState, Move, Pip, PlayStyle, Seat, Tile } from '../contracts';
import { isSolo, matchRules, movesFor, nextIn, seatsOf } from './game';
import { hashSeed, Rng } from './rng';
import { scoreUnit, type Rules } from './rules';
import { ABAJO_MAX, capicuaDoubleTotal, PASS_BONUS_CLAIMS_ABAJO, resolveHandCore, resolveSoloCore, roundCode, toScoreRules, type ScoreRules } from './scoring';
import { ALL_TILES, TILE_A, TILE_B } from './tiles';

/**
 * CPU players. Every decision is built from a SeatView that only contains what the seat legitimately
 * knows: its own tiles, the public chain, public passes, the tile counts of the other hands and the rules.
 */

export interface AiOptions {
  /** wall-clock budget for the hard AI (ms). Default 90. */
  timeMs?: number;
  /** cap on simulated rollouts (samples × candidate moves). Default 2400 — keeps decisions reproducible on fast devices. */
  maxRollouts?: number;
  /** master: exact endgame search once this many tiles (or fewer) are left in all hands. Default ENDGAME_TILES. */
  endgameTiles?: number;
}

interface SeatView {
  seat: Seat;
  partner: Seat;
  hand: Tile[];
  ends: { left: Pip; right: Pip } | null;
  /** bitmask per seat of pips the seat passed on (public) */
  passBits: number[];
  /** tiles in each hand (public) */
  counts: number[];
  /** tiles on the table carrying each pip */
  tableCount: number[];
  /** pips of tiles on the table, by tile id */
  onTable: boolean[];
  starter: Seat;
  chainLen: number;
  /** signal weights per pip, learned from partner's / opponents' plays */
  partnerW: number[];
  oppW: number[];
  rules: Rules;
  sr: ScoreRules;
  moves: Move[];
  /** match scores by team (public) */
  scores: [number, number];
  /** points held abajo (public) */
  abajo: number;
  /** individual mode: no partner (partner = -1), every other seat in play is an opponent */
  solo: boolean;
  /** seats in play, in turn order */
  seats: readonly Seat[];
  /** next / previous seat in play, by seat */
  next: number[];
  prev: number[];
  /** tiles in the boneyard (public count; set-aside tiles when drawing is off) */
  pile: number;
  /** individual: scores by seat (public) */
  seatScores: number[];
}

function buildView(match: MatchState): SeatView {
  const hand = match.hand!;
  const seat = hand.turn;
  const solo = isSolo(match);
  const seats = seatsOf(match);
  const partner = (solo ? -1 : (seat + 2) & 3) as Seat;
  const rules = matchRules(match);
  const next = [0, 1, 2, 3].map((s) => (seats.includes(s as Seat) ? nextIn(seats, s) : (s + 1) & 3));
  const prev = [0, 1, 2, 3].map((s) => seats[(seats.indexOf(s as Seat) + seats.length - 1) % seats.length] ?? ((s + 3) & 3));
  const tableCount = [0, 0, 0, 0, 0, 0, 0];
  const onTable = new Array<boolean>(28).fill(false);
  const partnerW = [0, 0, 0, 0, 0, 0, 0];
  const oppW = [0, 0, 0, 0, 0, 0, 0];
  hand.chain.forEach((p, i) => {
    const t = p.tile;
    onTable[t.id] = true;
    tableCount[t.a]++;
    if (t.b !== t.a) tableCount[t.b]++;
    if (p.seat === seat) return;
    const w = p.seat === partner ? partnerW : oppW;
    if (i === 0) {
      // la salida: the opener leads from their strongest suit
      w[t.a] += 1.5;
      if (t.b !== t.a) w[t.b] += 1.5;
    } else {
      w[p.outer] += 1; // "pintar": exposing a pip usually means holding more of it
    }
  });
  const passBits = hand.passedOn.map((ps) => ps.reduce<number>((m, v) => m | (1 << v), 0));
  for (let v = 0; v < 7; v++) {
    if (solo) {
      // every opponent passed on v (or drew on it)
      if (seats.every((s) => s === seat || passBits[s] & (1 << v))) oppW[v] = -3;
      continue;
    }
    if (passBits[partner] & (1 << v)) partnerW[v] = -3;
    if (passBits[(seat + 1) & 3] & (1 << v) && passBits[(seat + 3) & 3] & (1 << v)) oppW[v] = -3;
  }
  // de-duplicate strategically identical moves (same tile, same resulting pair of ends)
  const seen = new Set<string>();
  const moves: Move[] = [];
  for (const m of movesFor(hand, seat, rules)) {
    if (m.kind === 'play' && hand.ends) {
      const ne = endsAfter(hand.ends, ALL_TILES[m.tileId], m.side);
      const key = `${m.tileId}:${Math.min(ne.left, ne.right)}${Math.max(ne.left, ne.right)}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    moves.push(m);
  }
  return {
    seat,
    partner,
    hand: hand.hands[seat],
    ends: hand.ends,
    passBits,
    counts: hand.hands.map((h) => h.length),
    tableCount,
    onTable,
    starter: hand.starter,
    chainLen: hand.chain.length,
    partnerW,
    oppW,
    rules,
    sr: toScoreRules(rules),
    moves,
    scores: [match.scores[0], match.scores[1]],
    abajo: match.abajo ?? 0,
    solo,
    seats,
    next,
    prev,
    pile: hand.boneyard?.length ?? 0,
    seatScores: (match.seatScores ?? [0, 0, 0, 0]).slice(),
  };
}

function endsAfter(ends: { left: Pip; right: Pip } | null, t: Tile, side: 'left' | 'right'): { left: Pip; right: Pip } {
  if (!ends) return { left: t.a, right: t.b };
  const v = ends[side];
  const other = (t.a === v ? t.b : t.a) as Pip;
  return side === 'left' ? { left: other, right: ends.right } : { left: ends.left, right: other };
}

// ───────────────────────── heuristics (normal) ─────────────────────────

/**
 * Weights of the one-ply heuristic. The defaults are the plain "normal" player; playing styles nudge a
 * few of them (light biases: a style never changes what information a player uses beyond its level).
 */
export interface StyleWeights {
  /** pips of the played tile (getting rid of heavy fichas) */
  heavy: number;
  /** bonus for playing a double */
  double: number;
  /** extra double bonus while the hand is young (first 8 tiles) */
  doubleEarly: number;
  /** own tiles that match the new ends (keeping control of a suit), per tile, capped at 3 */
  suit: number;
  /** distinct suits kept in hand */
  diversity: number;
  /** showing an end the next opponent passed on */
  nextVoid: number;
  /** both ends shut for the next opponent */
  bothVoid: number;
  /** partner-related terms (his passes and the suits he showed) */
  partner: number;
  /** covering an end the opponents showed */
  killOpp: number;
  /** weight of the certain-tranque estimate */
  tranque: number;
  /** ignores what the partner is telling him */
  ignorePartner: boolean;
}

export const BASE_WEIGHTS: StyleWeights = {
  heavy: 1,
  double: 5,
  doubleEarly: 0,
  suit: 1.5,
  diversity: 0.8,
  nextVoid: 4,
  bothVoid: 4,
  partner: 1,
  killOpp: 0.6,
  tranque: 1,
  ignorePartner: false,
};

const STYLE_WEIGHTS: Partial<Record<PlayStyle, Partial<StyleWeights>>> = {
  beginner: { ignorePartner: true, diversity: 0.3, killOpp: 0, bothVoid: 1 },
  balanced: { diversity: 1.6, partner: 1.5 },
  byTheBook: { heavy: 1.35, doubleEarly: 5, diversity: 0.5 },
  blocker: { nextVoid: 7, bothVoid: 8, killOpp: 1.2 },
  aggressive: { suit: 2.6, heavy: 1.1, partner: 0.7 },
  calculator: { tranque: 1.7, heavy: 1.15 },
  teamPlayer: { partner: 2.1, killOpp: 0.9 },
};

export function styleWeights(style?: PlayStyle): StyleWeights {
  return { ...BASE_WEIGHTS, ...(style ? STYLE_WEIGHTS[style] : undefined) };
}

export function heuristicScore(v: SeatView, m: Move, w: StyleWeights = BASE_WEIGHTS): number {
  if (m.kind !== 'play') return 0;
  const t = ALL_TILES[m.tileId];
  const ne = endsAfter(v.ends, t, m.side);
  const rem = v.hand.filter((x) => x.id !== t.id);
  if (rem.length === 0) return 1000 + t.a + t.b;
  const nextOpp = v.next[v.seat];
  const prevOpp = v.prev[v.seat];
  let s = (t.a + t.b) * w.heavy;
  if (t.a === t.b) s += w.double + (v.chainLen < 8 ? w.doubleEarly : 0);

  const mine = (e: number) => {
    let n = 0;
    for (const x of rem) if (x.a === e || x.b === e) n++;
    return n;
  };
  const distinctEnds = ne.left === ne.right ? [ne.left] : [ne.left, ne.right];
  for (const e of [ne.left, ne.right]) s += w.suit * Math.min(mine(e), 3);
  let suits = 0;
  for (let p = 0; p < 7; p++) if (mine(p) > 0) suits++;
  s += w.diversity * suits;

  // individual: the partner-aware terms are simply off (partnerW stays 0)
  const pk = w.ignorePartner || v.solo ? 0 : w.partner;
  let nextVoid = 0;
  for (const e of distinctEnds) {
    const bit = 1 << e;
    if (v.passBits[nextOpp] & bit) {
      s += w.nextVoid;
      nextVoid++;
    }
    if (prevOpp !== nextOpp && v.passBits[prevOpp] & bit) s += 1.5;
    if (!v.solo && v.passBits[v.partner] & bit) s -= 3.5 * pk;
    s += 1.2 * pk * v.partnerW[e] - 1.0 * v.oppW[e];
  }
  if (nextVoid === distinctEnds.length) s += w.bothVoid;
  if (v.ends) {
    const covered = v.ends[m.side];
    s -= 0.8 * pk * Math.max(0, v.partnerW[covered]); // don't kill partner's end
    s += w.killOpp * Math.max(0, v.oppW[covered]); // do kill theirs
  }

  // Does this play certainly block the game (tranque)? Then estimate whether we win it.
  const tc = v.tableCount.slice();
  tc[t.a]++;
  if (t.b !== t.a) tc[t.b]++;
  if (tc[ne.left] === 7 && tc[ne.right] === 7) {
    let unkPips = 0;
    let unkN = 0;
    for (const x of ALL_TILES) {
      if (v.onTable[x.id] || v.hand.some((h) => h.id === x.id)) continue;
      unkPips += x.a + x.b;
      unkN++;
    }
    const avg = unkN ? unkPips / unkN : 0;
    const pips = [0, 0, 0, 0];
    for (let k = 0; k < 4; k++) pips[k] = k === v.seat ? rem.reduce((a, x) => a + x.a + x.b, 0) : v.counts[k] * avg;
    const res = v.solo
      ? resolveSoloCore(true, pips.map(Math.round), v.seats, v.seats.length, v.seat, v.starter, v.rules.soloTie === 'void')
      : resolveHandCore(v.sr, true, pips, v.seat, v.starter);
    const win = (res & 7) - 1;
    const pts = res >> 3;
    const ours = v.solo ? win === v.seat : (win & 1) === (v.seat & 1);
    if (win < 0) s -= 5;
    else if (ours) s += (15 + pts * 0.3) * w.tranque;
    else s -= 15 + pts * 0.3;
  }
  return s;
}

// ───────────────────────── fast simulation (hard) ─────────────────────────

/**
 * Hands in the simulation arrays: S slots per seat (individual play with a boneyard can grow a hand past
 * 7 tiles). Slot 4 (PILE) is the boneyard / the set-aside tiles: unknown, never constrained by passes.
 */
const S = 28;
const PILE = 4;
const BH = new Int8Array(5 * S); // base hands
const BC = new Int8Array(5);
const WH = new Int8Array(5 * S); // work copy
const WC = new Int8Array(5);
const BT = new Int8Array(7); // tiles on table per pip
const WT = new Int8Array(7);
const BP = new Int16Array(5); // pass bitmasks (PILE: always 0)
const WP = new Int16Array(5);
const PIPS = new Int32Array(4);
const UNK = new Int8Array(28);
const ORD = new Int8Array(28);
const CAP = new Int8Array(5);
let rs = 1; // xorshift state for rollouts

function rnd(): number {
  rs ^= rs << 13;
  rs ^= rs >>> 17;
  rs ^= rs << 5;
  return (rs >>> 0) / 4294967296;
}

/** All point values here are in match points (already scaled by the rounding unit). */
interface SimCtx {
  me: number;
  sr: ScoreRules;
  starter: number;
  /** fixed capicúa bonus (0 = none) */
  capicua: number;
  /** capicúa counts double */
  capicuaDouble: boolean;
  chuchazo: number;
  /** opening-pass bonus as it would actually be credited (0 when the guard blocks it) */
  paseSalida: number;
  paseCorrido: number;
  /** stronger (and a little slower) playout policy: keeps suit control, plays doubles sooner, less noise */
  smart: boolean;
  /** puntos abajo: max hand points that go abajo for a team on 0 (-1 = rule off) */
  abajoMax: number;
  /** bit per team: that team is on 0 (its small wins go abajo) */
  zeroMask: number;
  /** the opening pass, if it happens, goes to the pot (the starter team is on 0) */
  paseAbajo: boolean;
  /** individual play: every seat for itself (swings are +pts for me, -pts for anyone else) */
  solo: boolean;
  /** seats in play, in turn order, and how many */
  order: Int8Array;
  n: number;
  /** next seat in play, by seat */
  next: Int8Array;
  /** individual: a player who cannot play draws from PILE */
  draw: boolean;
  /** individual: a tied cerrado is void */
  tieVoid: boolean;
}

/** the abajo pot during one playout (starts at the public pot; an opening pass on 0 adds to it) */
let simPot = 0;

/** swing for ctx.me of `pts` won by `seat` (pairs: by its team) */
function teamSwing(ctx: SimCtx, seat: number, pts: number): number {
  if (ctx.solo) return seat === ctx.me ? pts : -pts;
  return (seat & 1) === (ctx.me & 1) ? pts : -pts;
}

/**
 * Point swing of a finished playout. `winExtra` = fixed bonuses of the seat that went out (capicúa /
 * double blank): part of the winning team's hand points, so they count for the abajo threshold.
 * Points sent abajo are worth 0 (the pot goes to whoever next scores normally); a normal win also
 * takes the pot.
 */
function finishSim(ctx: SimCtx, blocked: boolean, lastSeat: number, bonus: number, capicua = false, winExtra = 0): number {
  for (let s = 0; s < 4; s++) {
    let p = 0;
    for (let i = 0; i < WC[s]; i++) {
      const id = WH[s * S + i];
      p += TILE_A[id] + TILE_B[id];
    }
    PIPS[s] = p;
  }
  const res = ctx.solo
    ? resolveSoloCore(blocked, PIPS, ctx.order, ctx.n, lastSeat, ctx.starter, ctx.tieVoid)
    : resolveHandCore(ctx.sr, blocked, PIPS, lastSeat, ctx.starter);
  const w = (res & 7) - 1;
  if (w < 0) return bonus;
  const raw = res >> 3;
  let pts = (capicua && ctx.capicuaDouble ? capicuaDoubleTotal(raw, ctx.sr.round) : roundCode(raw, ctx.sr.round)) + winExtra;
  if (ctx.abajoMax >= 0) {
    if ((ctx.zeroMask >> (w & 1)) & 1 && pts <= ctx.abajoMax) pts = 0;
    else pts += simPot;
  }
  return bonus + teamSwing(ctx, w, pts);
}

const isCapicua = (a: number, b: number, pl: number, pr: number) => pl !== pr && ((a === pl && b === pr) || (a === pr && b === pl));

/** Plays the hand out from the work arrays. Returns the point swing for ctx.me's team. */
function rollout(ctx: SimCtx, turn: number, L: number, R: number, passes: number, lastSeat: number, placed: number, bonus: number): number {
  let drew = false; // individual: the seat to move already drew this turn
  for (let guard = 0; guard < 300; guard++) {
    const seat = turn;
    const base = seat * S;
    const n = WC[seat];
    const nextOpp = ctx.next[seat];
    // individual: no partner (PILE's pass bits are always 0, so the partner terms vanish)
    const partner = ctx.solo ? PILE : (seat + 2) & 3;
    let bestI = -1;
    let bestLeft = false;
    let bestScore = -1e9;
    for (let i = 0; i < n; i++) {
      const id = WH[base + i];
      const a = TILE_A[id];
      const b = TILE_B[id];
      for (let side = 0; side < 2; side++) {
        const e = side === 0 ? L : R;
        if (a !== e && b !== e) continue;
        const ne = a === e ? b : a;
        let sc: number;
        if (ctx.smart) {
          sc = a + b + (a === b ? 5.5 : 0) + rnd() * 2.6;
          if ((WP[nextOpp] >> ne) & 1) sc += 3.6;
          if ((WP[partner] >> ne) & 1) sc -= 2.6;
          // keep control: other own tiles that can follow on the new end
          let ctl = 0;
          for (let j = 0; j < n; j++) {
            if (j === i) continue;
            const o = WH[base + j];
            if (TILE_A[o] === ne || TILE_B[o] === ne) ctl++;
          }
          sc += 1.3 * (ctl > 3 ? 3 : ctl);
        } else {
          sc = a + b + (a === b ? 4 : 0) + rnd() * 4;
          if ((WP[nextOpp] >> ne) & 1) sc += 3;
          if ((WP[partner] >> ne) & 1) sc -= 2;
        }
        if (n === 1) sc += 1000;
        if (sc > bestScore) {
          bestScore = sc;
          bestI = i;
          bestLeft = side === 0;
        }
        if (L === R) break;
      }
    }
    if (bestI < 0) {
      // the opening pass (individual: the next player cannot play the first tile with their dealt tiles)
      if (placed === 1 && passes === 0 && !drew && ctx.paseSalida) {
        if (ctx.paseAbajo) simPot += ctx.paseSalida;
        else if (PASS_BONUS_CLAIMS_ABAJO && ctx.abajoMax >= 0) {
          bonus += teamSwing(ctx, ctx.starter, ctx.paseSalida + simPot);
          simPot = 0;
        } else bonus += teamSwing(ctx, ctx.starter, ctx.paseSalida);
      }
      if (ctx.draw && WC[PILE] > 0) {
        // draw one random tile from the boneyard; the same seat tries again
        WP[seat] = (1 << L) | (1 << R);
        drew = true;
        const pb = PILE * S;
        const k = (rnd() * WC[PILE]) | 0;
        const dt = WH[pb + k];
        WH[pb + k] = WH[pb + WC[PILE] - 1];
        WC[PILE]--;
        WH[base + n] = dt;
        WC[seat] = n + 1;
        continue;
      }
      WP[seat] |= (1 << L) | (1 << R);
      drew = false;
      passes++;
      if (passes === 3 && ctx.paseCorrido) bonus += teamSwing(ctx, lastSeat, ctx.paseCorrido);
      if (passes >= ctx.n) return finishSim(ctx, true, lastSeat, bonus);
      turn = nextOpp;
      continue;
    }
    drew = false;
    const id = WH[base + bestI];
    WH[base + bestI] = WH[base + n - 1];
    WC[seat] = n - 1;
    const a = TILE_A[id];
    const b = TILE_B[id];
    const pl = L;
    const pr = R;
    if (bestLeft) L = a === L ? b : a;
    else R = a === R ? b : a;
    WT[a]++;
    if (a !== b) WT[b]++;
    passes = 0;
    placed++;
    lastSeat = seat;
    if (n === 1) {
      const cap = isCapicua(a, b, pl, pr);
      const extra = (ctx.capicua && cap ? ctx.capicua : 0) + (ctx.chuchazo && id === 0 ? ctx.chuchazo : 0);
      return finishSim(ctx, false, seat, bonus, cap, extra);
    }
    if (WT[L] === 7 && WT[R] === 7) return finishSim(ctx, true, seat, bonus);
    turn = nextOpp;
  }
  return finishSim(ctx, true, lastSeat, bonus);
}

/** per seat × tile likelihood weights for the deal sampler (master's inference); 1 = neutral */
const TWT = new Float64Array(5 * 28).fill(1);
let useTwt = false;

/**
 * Deal the unknown tiles to the other seats (and, in individual play, to the boneyard / set-aside pile:
 * slot PILE, never constrained) consistently with their public passes.
 */
function sampleHidden(me: number, unkN: number, rng: Rng): void {
  const slots = BC[PILE] > 0 ? 5 : 4;
  for (let attempt = 0; attempt < 40; attempt++) {
    // shuffle unknown tiles
    for (let i = unkN - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      const t = UNK[i];
      UNK[i] = UNK[j];
      UNK[j] = t;
    }
    // most constrained tiles first
    let k = 0;
    for (let ec = 0; ec <= slots - 1; ec++) {
      for (let i = 0; i < unkN; i++) {
        const id = UNK[i];
        const mask = (1 << TILE_A[id]) | (1 << TILE_B[id]);
        let c = 0;
        for (let s = 0; s < slots; s++) if (s !== me && (BP[s] & mask) === 0) c++;
        if (c === ec) ORD[k++] = id;
      }
    }
    for (let s = 0; s < 5; s++) CAP[s] = s === me ? 0 : BC[s];
    const fill = [0, 0, 0, 0, 0];
    let ok = true;
    for (let i = 0; i < unkN && ok; i++) {
      const id = ORD[i];
      const mask = (1 << TILE_A[id]) | (1 << TILE_B[id]);
      let tot = 0;
      for (let s = 0; s < slots; s++) if (CAP[s] > 0 && (attempt === 39 || (BP[s] & mask) === 0)) tot += useTwt ? CAP[s] * TWT[s * 28 + id] : CAP[s];
      if (tot <= 0) {
        ok = false;
        break;
      }
      let r = useTwt ? rng.next() * tot : rng.int(tot);
      let pick = -1;
      for (let s = 0; s < slots; s++) {
        if (CAP[s] > 0 && (attempt === 39 || (BP[s] & mask) === 0)) {
          pick = s; // float rounding: the last eligible seat takes it if r never goes below 0
          r -= useTwt ? CAP[s] * TWT[s * 28 + id] : CAP[s];
          if (r < 0) break;
        }
      }
      BH[pick * S + fill[pick]++] = id;
      CAP[pick]--;
    }
    if (ok) return;
  }
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ───────────────────────── master: inference + exact endgame ─────────────────────────

/**
 * Hidden-hand inference (master). Hard constraints (passes) are handled by the sampler; these are soft
 * likelihoods from what each seat chose to play — and what it chose NOT to play:
 *  - the opening tile and every pip a seat exposed ("pintar") suggest it holds more of that suit;
 *  - a seat that played on end X with a non-double while the X-X double was still unseen probably does
 *    not hold that double (doubles are played early: they only fit one suit);
 *  - a seat that covered (killed) an end it could have kept is a little less likely to hold that suit.
 */
function inferWeights(match: MatchState, me: Seat): void {
  const hand = match.hand!;
  const aff = new Float64Array(28); // seat*7 + pip
  const dbl = new Float64Array(28).fill(1); // seat*7 + pip → factor for the X-X double
  let L = -1;
  let R = -1;
  const seenDouble = new Array<boolean>(7).fill(false);
  hand.chain.forEach((p, i) => {
    const t = p.tile;
    const s = p.seat;
    if (i === 0) {
      if (s !== me) {
        aff[s * 7 + t.a] += 0.9;
        if (t.b !== t.a) aff[s * 7 + t.b] += 0.9;
      }
      L = t.a;
      R = p.outer;
    } else {
      const end = p.side === 'left' ? L : R;
      if (s !== me) {
        aff[s * 7 + p.outer] += 0.45;
        if (t.a !== t.b && end >= 0) {
          if (!seenDouble[end]) dbl[s * 7 + end] *= 0.45;
          // killed an end: covered pip `end` (unless the tile shows the same pip again)
          if (p.outer !== end) aff[s * 7 + end] -= 0.18;
        }
      }
      if (p.side === 'left') L = p.outer;
      else R = p.outer;
    }
    if (t.a === t.b) seenDouble[t.a] = true;
  });
  for (let s = 0; s < 4; s++) {
    for (let id = 0; id < 28; id++) {
      const a = TILE_A[id];
      const b = TILE_B[id];
      let w = Math.exp(aff[s * 7 + a] + (a !== b ? aff[s * 7 + b] : 0));
      if (a === b) w *= dbl[s * 7 + a];
      TWT[s * 28 + id] = Math.max(0.05, Math.min(8, w));
    }
  }
}

const ENDGAME_TILES = 11;
const NODE_CAP = 60_000;
let nodes = 0;

/**
 * Exact perfect-information alpha-beta of the rest of the hand from the work arrays (one determinized
 * deal). The pair of ctx.me maximises the point swing, the other pair minimises it. Make/unmake keeps
 * WH/WC/WT intact for the caller.
 */
function solve(ctx: SimCtx, turn: number, L: number, R: number, passes: number, lastSeat: number, bonus: number, alpha: number, beta: number): number {
  if (++nodes > NODE_CAP) return finishSim(ctx, true, lastSeat, bonus); // safety valve
  const seat = turn;
  const base = seat * S;
  const n = WC[seat];
  // individual: paranoid search (every other player minimises my swing)
  const maxing = ctx.solo ? seat === ctx.me : (seat & 1) === (ctx.me & 1);
  let best = maxing ? -1e9 : 1e9;
  let any = false;
  for (let i = 0; i < n; i++) {
    const id = WH[base + i];
    const a = TILE_A[id];
    const b = TILE_B[id];
    for (let side = 0; side < 2; side++) {
      const e = side === 0 ? L : R;
      if (a !== e && b !== e) continue;
      any = true;
      const ne = a === e ? b : a;
      // make
      WH[base + i] = WH[base + n - 1];
      WH[base + n - 1] = id;
      WC[seat] = n - 1;
      WT[a]++;
      if (a !== b) WT[b]++;
      const nL = side === 0 ? ne : L;
      const nR = side === 0 ? R : ne;
      let val: number;
      if (n === 1) {
        const cap = isCapicua(a, b, L, R);
        const extra = (ctx.capicua && cap ? ctx.capicua : 0) + (ctx.chuchazo && id === 0 ? ctx.chuchazo : 0);
        val = finishSim(ctx, false, seat, bonus, cap, extra);
      } else if (WT[nL] === 7 && WT[nR] === 7) val = finishSim(ctx, true, seat, bonus);
      else val = solve(ctx, ctx.next[seat], nL, nR, 0, seat, bonus, alpha, beta);
      // unmake
      WT[a]--;
      if (a !== b) WT[b]--;
      WC[seat] = n;
      WH[base + n - 1] = WH[base + i];
      WH[base + i] = id;
      if (maxing) {
        if (val > best) best = val;
        if (best > alpha) alpha = best;
      } else {
        if (val < best) best = val;
        if (best < beta) beta = best;
      }
      if (alpha >= beta) return best;
      if (L === R) break;
    }
  }
  if (any) return best;
  // no tile fits: pass
  const p2 = passes + 1;
  let bon = bonus;
  if (p2 === 3 && ctx.paseCorrido) bon += teamSwing(ctx, lastSeat, ctx.paseCorrido);
  if (p2 >= ctx.n) return finishSim(ctx, true, lastSeat, bon);
  return solve(ctx, ctx.next[seat], L, R, p2, lastSeat, bon, alpha, beta);
}

// ───────────────────────── simulation players (hard / master) ─────────────────────────

interface SimCfg {
  master: boolean;
  w: StyleWeights;
  /** weight of the heuristic tie-break (style bias) */
  heurK: number;
}

/** master's wall-clock budget per decision (ms); the hard cap on a mid-range phone is ~250 ms */
export const MASTER_MS = 170;

function chooseSim(v: SeatView, match: MatchState, seed: number, opts: AiOptions, cfg: SimCfg): Move {
  const master = cfg.master;
  const timeMs = opts.timeMs ?? (master ? MASTER_MS : 90);
  const maxRollouts = opts.maxRollouts ?? (master ? 40_000 : 2400);
  const moves = v.moves;
  const heur = moves.map((m) => heuristicScore(v, m, cfg.w));
  const t0 = now();
  const me = v.seat;
  const rng = new Rng(seed);
  rs = seed | 1;

  // base state
  let unkN = 0;
  const mineSet = new Set(v.hand.map((t) => t.id));
  for (let id = 0; id < 28; id++) if (!v.onTable[id] && !mineSet.has(id)) UNK[unkN++] = id;
  for (let s = 0; s < 4; s++) {
    BC[s] = v.counts[s];
    BP[s] = v.passBits[s];
  }
  // individual: the boneyard / set-aside tiles are unknown too (count public, contents hidden)
  BC[PILE] = v.pile;
  BP[PILE] = 0;
  for (let i = 0; i < v.hand.length; i++) BH[me * S + i] = v.hand[i].id;
  for (let p = 0; p < 7; p++) BT[p] = v.tableCount[p];
  useTwt = master;
  if (master) inferWeights(match, me);

  const unit = scoreUnit(v.rules);
  const target = v.rules.target * unit;
  const starterTeam = v.starter & 1;
  let paseSalida = v.rules.paseSalida * unit;
  const abajoOn = v.rules.abajo && !v.solo;
  const paseAbajo = abajoOn && v.scores[starterTeam] === 0;
  const passClaim = abajoOn && PASS_BONUS_CLAIMS_ABAJO ? v.abajo : 0;
  const starterScore = v.solo ? v.seatScores[v.starter] : v.scores[starterTeam];
  if (!paseAbajo && v.rules.paseSalidaNoWin && starterScore + paseSalida + passClaim >= target) paseSalida = 0;
  const order = new Int8Array(4);
  v.seats.forEach((s, i) => (order[i] = s));
  const ctx: SimCtx = {
    me,
    sr: v.sr,
    starter: v.starter,
    capicua: typeof v.rules.capicua === 'number' ? v.rules.capicua * unit : 0,
    capicuaDouble: v.rules.capicua === 'double',
    chuchazo: v.rules.chuchazo * unit,
    paseSalida,
    paseCorrido: v.rules.paseCorrido * unit,
    smart: master,
    abajoMax: abajoOn ? ABAJO_MAX * unit : -1,
    zeroMask: abajoOn ? (v.scores[0] === 0 ? 1 : 0) | (v.scores[1] === 0 ? 2 : 0) : 0,
    paseAbajo,
    solo: v.solo,
    order,
    n: v.seats.length,
    next: Int8Array.from([0, 1, 2, 3, 0].map((s) => v.next[s] ?? 0)),
    draw: v.solo && v.rules.boneyardDraw && v.pile > 0,
    tieVoid: v.rules.soloTie === 'void',
  };
  // master: the match situation matters — points beyond what wins the match are worth little, and
  // reaching the target (or letting them reach it) is worth more than its face value
  const myTeam = me & 1;
  const needUs = Math.max(1, target - (v.solo ? v.seatScores[me] : v.scores[myTeam]));
  const needThem = Math.max(1, target - (v.solo ? Math.max(...v.seats.filter((s) => s !== me).map((s) => v.seatScores[s])) : v.scores[1 - myTeam]));
  const bonusWin = 0.5 * target;
  const util = (x: number): number => {
    if (!master) return x;
    if (x >= 0) return x >= needUs ? needUs + bonusWin + 0.15 * (x - needUs) : x;
    const y = -x;
    return -(y >= needThem ? needThem + bonusWin + 0.15 * (y - needThem) : y);
  };
  let left = 0;
  for (let s = 0; s < 4; s++) left += v.counts[s];
  // (the exact search has no chance nodes: not while tiles can still be drawn)
  const endgame = master && !ctx.draw && left <= (opts.endgameTiles ?? ENDGAME_TILES);

  // rollout values are compared on a pips-like scale so the heuristic tie-break keeps its weight
  const toPipScale = 10 / unit;
  const acc = new Float64Array(moves.length);
  let samples = 0;
  const maxSamples = Math.max(8, Math.floor(maxRollouts / moves.length));
  while (samples < maxSamples) {
    if (samples >= 4 && now() - t0 > timeMs) break;
    sampleHidden(me, unkN, rng);
    for (let mi = 0; mi < moves.length; mi++) {
      const m = moves[mi];
      if (m.kind !== 'play') continue;
      simPot = v.abajo;
      WH.set(BH);
      WC.set(BC);
      WT.set(BT);
      WP.set(BP);
      // apply candidate move
      const base = me * S;
      const n = WC[me];
      let idx = 0;
      while (idx < n && WH[base + idx] !== m.tileId) idx++;
      if (idx >= n) continue; // (never: a legal move's tile is in the hand; bounded scan, no runaway loop)
      WH[base + idx] = WH[base + n - 1];
      WC[me] = n - 1;
      const a = TILE_A[m.tileId];
      const b = TILE_B[m.tileId];
      let L: number;
      let R: number;
      let pl = -1;
      let pr = -2;
      if (!v.ends) {
        L = a;
        R = b;
      } else {
        pl = v.ends.left;
        pr = v.ends.right;
        L = pl;
        R = pr;
        if (m.side === 'left') L = a === L ? b : a;
        else R = a === R ? b : a;
      }
      WT[a]++;
      if (a !== b) WT[b]++;
      let val: number;
      if (n === 1) {
        const cap = isCapicua(a, b, pl, pr);
        const extra = (ctx.capicua && cap ? ctx.capicua : 0) + (ctx.chuchazo && m.tileId === 0 ? ctx.chuchazo : 0);
        val = finishSim(ctx, false, me, 0, cap, extra);
      } else if (WT[L] === 7 && WT[R] === 7) {
        val = finishSim(ctx, true, me, 0);
      } else if (endgame) {
        nodes = 0;
        val = solve(ctx, ctx.next[me], L, R, 0, me, 0, -1e9, 1e9);
      } else {
        val = rollout(ctx, ctx.next[me], L, R, 0, me, v.chainLen + 1, 0);
      }
      acc[mi] += util(val) * toPipScale;
    }
    samples++;
  }
  useTwt = false;
  let best = 0;
  let bestV = -1e18;
  for (let mi = 0; mi < moves.length; mi++) {
    const val = acc[mi] / samples + cfg.heurK * heur[mi];
    if (val > bestV) {
      bestV = val;
      best = mi;
    }
  }
  lastHardStats = { samples, ms: now() - t0, moves: moves.length };
  return moves[best];
}

/** Diagnostics for tests/benchmarks. */
export let lastHardStats = { samples: 0, ms: 0, moves: 0 };

// ───────────────────────── entry point ─────────────────────────

/**
 * CPU decision. `style` is a light behaviour bias on top of the level (see STYLE_WEIGHTS); the level
 * decides the algorithm and what information is used.
 */
export function chooseMove(match: MatchState, difficulty: Difficulty, opts: AiOptions = {}, style?: PlayStyle): Move {
  const hand = match.hand;
  if (!hand || hand.over || match.over) throw new Error('no hand in progress');
  if (hand.pendingStarterChoice != null) throw new Error('starter choice pending');
  // individual play has no partner: the team player plays a balanced game
  if (style === 'teamPlayer' && isSolo(match)) style = 'balanced';
  const v = buildView(match);
  const moves = v.moves;
  if (moves.length === 1) return moves[0];
  const seed = hashSeed(match.rng, hand.handNo, hand.chain.length, hand.passesInRow, v.seat, match.scores[0], match.scores[1]);

  // Going out is always taken (except by a sleepy easy player, occasionally).
  const out = moves.find((m) => m.kind === 'play' && v.hand.length === 1);
  if (out && difficulty !== 'easy') return out;

  if (difficulty === 'easy') {
    const rng = new Rng(seed);
    if (style === 'beginner') {
      // the basics (heavy, doubles, follow a suit), plenty of slips, deaf to the partner
      const w = styleWeights('beginner');
      let best = 0;
      let bestV = -1e18;
      for (let i = 0; i < moves.length; i++) {
        const val = heuristicScore(v, moves[i], w) + rng.next() * 14;
        if (val > bestV) {
          bestV = val;
          best = i;
        }
      }
      return moves[best];
    }
    const w = moves.map((m) => {
      if (m.kind !== 'play') return 1;
      const t = ALL_TILES[m.tileId];
      const pips = t.a + t.b;
      if (style === 'carefree') return 1 + (v.hand.length === 1 ? 4 : 0); // whatever fits
      if (style === 'impulsive') return (1 + pips) * (1 + pips) + (v.hand.length === 1 ? 40 : 0); // heavy first
      return 1 + pips / 8 + (v.hand.length === 1 ? 4 : 0);
    });
    let r = rng.next() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < moves.length; i++) {
      r -= w[i];
      if (r < 0) return moves[i];
    }
    return moves[moves.length - 1];
  }

  if (difficulty === 'normal') {
    const w = styleWeights(style);
    let best = 0;
    let bestV = -1e18;
    const rng = new Rng(seed);
    for (let i = 0; i < moves.length; i++) {
      const val = heuristicScore(v, moves[i], w) + rng.next() * 0.01;
      if (val > bestV) {
        bestV = val;
        best = i;
      }
    }
    return moves[best];
  }

  if (difficulty === 'master') return chooseSim(v, match, seed, opts, { master: true, w: BASE_WEIGHTS, heurK: 0.05 });
  return chooseSim(v, match, seed, opts, { master: false, w: styleWeights(style), heurK: style ? 0.15 : 0.1 });
}
