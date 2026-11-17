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

const on = (id: string, fn: () => void) => document.getElementById(id)!.addEventListener('click', fn);
on('bStart', () => void deal(0));
on('bMid', () => void deal(16));
on('bPass', () => void passes());
on('bHand', () => void replay());
(window as unknown as Record<string, unknown>).demo = { deal, passes, plates, sleep };

const demo = new URLSearchParams(location.search).get('demo') ?? 'start';
if (demo === 'mid') void deal(Number(new URLSearchParams(location.search).get('n') ?? 16));
else if (demo === 'pass') void passes();
else void deal(0);
