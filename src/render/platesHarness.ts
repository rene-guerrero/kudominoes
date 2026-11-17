/**
 * Dev harness for the real in-game composition: 3D table + HTML name plates (avatars) + top HUD,
 * without the app/controller. Open /platesHarness.html?demo=start|mid|pass|hand.
 */
import '../ui/styles.css';
import { createTableView } from './index';
import type { GameEvent, Move, PlacedTile, Pip, Seat, Tile } from '../contracts';
import { Overlay } from '../ui/overlay';
import { Hud } from '../ui/hud';
import { SeatPlates } from '../ui/plates';
import { AvatarController } from '../ui/avatars';
import { t } from '../ui/i18n';

const ALL: Tile[] = [];
for (let a = 0; a <= 6; a++) for (let b = a; b <= 6; b++) ALL.push({ id: ALL.length, a: a as Pip, b: b as Pip });

const overlay = new Overlay(document.getElementById('ui')!);
const avatars = new AvatarController();
const plates = new SeatPlates(avatars);
const hud = new Hud(() => undefined);
overlay.hudLayer.append(plates.el, hud.el);
const names: [string, string, string, string] = ['Tú', 'Andrés', 'María', 'Carlos'];
plates.setNames(names);
hud.setTarget(20);
hud.setHand(1);
hud.show(true);

const view = createTableView({
  container: document.getElementById('table')!,
  quality: 'medium',
  playerNames: names,
  language: 'es',
  onPlates: (p, c) => plates.update(p, c),
  onImpact: (s, k) => avatars.onImpact(s, k),
  onDrag: (d) => plates.setDragging(d),
});
(window as unknown as Record<string, unknown>).view = view;
(window as unknown as Record<string, unknown>).hud = hud;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shuffle = <T>(a: T[]): T[] => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];

let run = 0;
async function emit(ev: GameEvent) {
  avatars.onEvent(ev, false);
  if (ev.type === 'pass') plates.say(ev.seat, t('say.pass'));
  if (ev.type === 'play' || ev.type === 'pass') hud.setEnds(ev.ends);
  if (ev.type === 'handStart') hud.setEnds(null);
  await view.handle(ev);
}

/** deal; optionally play `plays` random legal tiles quickly (mid-hand with a long chain) */
async function deal(plays: number, animate = false) {
  const my = ++run;
  view.reset();
  for (;;) {
    const deck = shuffle(ALL.slice());
    const hands = [0, 1, 2, 3].map((s) => deck.slice(s * 7, s * 7 + 7));
    // simulate first
    const h = hands.map((x) => x.slice());
    const chain: PlacedTile[] = [];
    let ends: { left: Pip; right: Pip } | null = null;
    let turn = 0 as Seat;
    const evs: GameEvent[] = [];
    let ok = true;
    for (let i = 0; i < plays; i++) {
      const opts: Move[] = [];
      for (const tl of h[turn]) {
        if (!ends) opts.push({ kind: 'play', seat: turn, tileId: tl.id, side: 'right' });
        else {
          if (tl.a === ends.left || tl.b === ends.left) opts.push({ kind: 'play', seat: turn, tileId: tl.id, side: 'left' });
          if (tl.a === ends.right || tl.b === ends.right) opts.push({ kind: 'play', seat: turn, tileId: tl.id, side: 'right' });
        }
      }
      if (!opts.length || h[turn].length <= 1) {
        ok = false;
        break;
      }
      const m = pick(opts) as Extract<Move, { kind: 'play' }>;
      const idx = h[turn].findIndex((x) => x.id === m.tileId);
      const tile = h[turn].splice(idx, 1)[0];
      let placed: PlacedTile;
      const isFirst = !ends;
      if (!ends) {
        placed = { tile, seat: turn, side: 'right', outer: tile.b };
        ends = { left: tile.a, right: tile.b };
      } else {
        const end = m.side === 'left' ? ends.left : ends.right;
        const outer = (tile.a === end ? tile.b : tile.a) as Pip;
        placed = { tile, seat: turn, side: m.side, outer };
        ends = m.side === 'left' ? { left: outer, right: ends.right } : { left: ends.left, right: outer };
      }
      chain.push(placed);
      evs.push({ type: 'play', seat: turn, tile, side: placed.side, placed, ends: { ...ends }, tilesLeft: h[turn].length, isFirst });
      turn = ((turn + 1) % 4) as Seat;
    }
    if (!ok) continue;
    if (!animate && view.restore) {
      await view.restore({
        hand: { handNo: 1, hands: h, chain, ends, turn, starter: 0, passesInRow: 0, passedOn: [[], [], [], []], over: false },
        scores: [0, 0],
      });
      hud.setEnds(ends);
      view.setTurn(turn);
      return { hands: h, ends, turn };
    }
    view.setSpeed(plays ? 4 : 1);
    await emit({ type: 'handStart', handNo: 1, hands, starter: 0, scores: [0, 0] });
    for (const e of evs) {
      if (my !== run) return;
      view.setTurn((e as { seat: Seat }).seat);
      await emit(e);
    }
    view.setSpeed(1);
    view.setTurn(turn);
    return { hands: h, ends, turn };
  }
}

async function passes() {
  const r = await deal(1);
  if (!r) return;
  for (const s of [1, 2, 3, 0] as Seat[]) {
    view.setTurn(s);
    await emit({ type: 'pass', seat: s, ends: r.ends! });
    await sleep(500);
  }
}

async function replay() {
  await deal(0, true);
}

/** a random 28-tile line of play (Euler path over the double-six set) */
function eulerLine(): { tiles: Tile[]; verts: number[] } {
  for (;;) {
    const used = new Set<number>();
    const stack: { v: number; t: number }[] = [{ v: Math.floor(Math.random() * 7), t: -1 }];
    const path: { v: number; t: number }[] = [];
    while (stack.length) {
      const top = stack[stack.length - 1];
      const cand = ALL.filter((x) => !used.has(x.id) && (x.a === top.v || x.b === top.v));
      if (cand.length) {
        const x = pick(cand);
        used.add(x.id);
        stack.push({ v: x.a === top.v ? x.b : x.a, t: x.id });
      } else path.push(stack.pop()!);
    }
    path.reverse();
    if (path.length === 29) return { verts: path.map((p) => p.v), tiles: path.slice(1).map((p) => ALL[p.t]) };
  }
}

/**
 * Restore straight into a chain of `n` tiles (1..28), both arms growing at random; the unplayed tiles
 * go back to the hands (the human's first, up to 7). `over` restores the hand-end reveal.
 */
async function chainN(n: number, over = false) {
  ++run;
  view.reset();
  n = Math.max(1, Math.min(28, n));
  const { tiles, verts } = eulerLine();
  // a window of n consecutive tiles from the line, first tile somewhere inside it
  const s0 = Math.floor(Math.random() * (28 - n + 1));
  const k = s0 + Math.floor(Math.random() * n);
  // the first tile's right end is verts[k + 1] (the right arm continues from it), its left end verts[k]
  const chain: PlacedTile[] = [{ tile: tiles[k], seat: 0, side: 'right', outer: verts[k + 1] as Pip }];
  const R: PlacedTile[] = [];
  const L: PlacedTile[] = [];
  for (let j = k + 1; j < s0 + n; j++) R.push({ tile: tiles[j], seat: 0, side: 'right', outer: verts[j + 1] as Pip });
  for (let j = k - 1; j >= s0; j--) L.push({ tile: tiles[j], seat: 0, side: 'left', outer: verts[j] as Pip });
  while (R.length || L.length) chain.push((L.length === 0 || (R.length && Math.random() < 0.5) ? R : L).shift()!);
  chain.forEach((p, i) => (p.seat = (i % 4) as Seat));
  const used = new Set(chain.map((p) => p.tile.id));
  const rest = shuffle(ALL.filter((x) => !used.has(x.id)));
  const hands: Tile[][] = [rest.splice(0, Math.min(7, rest.length)), [], [], []];
  for (let i = 0; rest.length; i++) hands[1 + (i % 3)].push(rest.shift()!);
  const first = chain[0];
  const ends = { left: verts[k] as Pip, right: first.outer };
  for (const p of chain.slice(1)) ends[p.side] = p.outer;
  await view.restore!({
    hand: { handNo: 1, hands, chain, ends, turn: 0, starter: 0, passesInRow: 0, passedOn: [[], [], [], []], over },
    scores: [0, 0],
    handOver: over,
  } as Parameters<NonNullable<typeof view.restore>>[0]);
  hud.setEnds(ends);
  view.setTurn(over ? null : 0);
}

/** debug: on-screen (CSS px) length of the chain tiles (mean/min) and of a hand tile */
function measure() {
  const v = view as unknown as {
    layoutRes: { poses: { x: number; z: number; rotY: number }[]; cell: number };
    camera: { position: unknown };
    handHs: number;
    handHalfH: number;
    H: number;
    W: number;
    bounds: unknown;
    toScreen(p: unknown, out: { x: number; y: number }): void;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const V3 = (v.camera.position as any).constructor;
  const a = { x: 0, y: 0 };
  const b = { x: 0, y: 0 };
  const L = 1.92 * v.layoutRes.cell;
  const lens = v.layoutRes.poses.map((p) => {
    const dx = (Math.cos(p.rotY) * L) / 2;
    const dz = (-Math.sin(p.rotY) * L) / 2;
    v.toScreen(new V3(p.x - dx, 0, p.z - dz), a);
    v.toScreen(new V3(p.x + dx, 0, p.z + dz), b);
    return Math.hypot(b.x - a.x, b.y - a.y);
  });
  const mean = lens.reduce((s, x) => s + x, 0) / Math.max(1, lens.length);
  const hand = (1.92 * v.handHs * v.H) / (2 * v.handHalfH);
  return { n: lens.length, cell: v.layoutRes.cell, mean: Math.round(mean), min: Math.round(Math.min(...lens)), hand: Math.round(hand), bounds: v.bounds };
}

const on = (id: string, fn: () => void) => document.getElementById(id)!.addEventListener('click', fn);
on('bStart', () => void deal(0));
on('bMid', () => void deal(16));
on('bPass', () => void passes());
on('bHand', () => void replay());
(window as unknown as Record<string, unknown>).demo = { deal, passes, plates, sleep, chainN, measure };

const qs = new URLSearchParams(location.search);
const demo = qs.get('demo') ?? 'start';
if (demo === 'mid') void deal(Number(qs.get('n') ?? 16));
else if (demo === 'chain') void chainN(Number(qs.get('n') ?? 12), qs.get('over') === '1');
else if (demo === 'pass') void passes();
else void deal(0);
