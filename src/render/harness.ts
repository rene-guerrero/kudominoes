/** Dev harness: mounts the TableView and replays fake GameEvents from a tiny local rules sim. */
import { createTableView } from './index';
import type { GameEvent, Move, PlacedTile, Pip, Quality, Seat, Tile } from '../contracts';

const ALL: Tile[] = [];
for (let a = 0; a <= 6; a++) for (let b = a; b <= 6; b++) ALL.push({ id: ALL.length, a: a as Pip, b: b as Pip });

const app = document.getElementById('app')!;
const logEl = document.getElementById('log')!;
const log = (s: string) => (logEl.textContent = s);

const q0 = (new URLSearchParams(location.search).get('q') as Quality | null) ?? 'medium';
(document.getElementById('sQ') as HTMLSelectElement).value = q0;
const view = createTableView({
  container: app,
  quality: q0,
  playerNames: ['Tú', 'Yuni', 'Pancho', 'Mayelín'],
  onSfx: (n) => console.debug('[sfx]', n),
});
(window as unknown as { view: unknown }).view = view;

const shuffle = <T>(a: T[]): T[] => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Sim {
  hands: Tile[][];
  chain: PlacedTile[] = [];
  ends: { left: Pip; right: Pip } | null = null;
  turn: Seat;
  starter: Seat;
  passes = 0;
  over = false;
  scores: [number, number] = [0, 0];
  constructor() {
    const deck = shuffle(ALL.slice());
    this.hands = [0, 1, 2, 3].map((s) => deck.slice(s * 7, s * 7 + 7));
    this.starter = this.hands.findIndex((h) => h.some((t) => t.id === 27)) as Seat;
    this.turn = this.starter;
  }
  startEvent(): GameEvent {
    return { type: 'handStart', handNo: 1, hands: this.hands.map((h) => h.slice()), starter: this.starter, scores: this.scores };
  }
  legal(): Move[] {
    const s = this.turn;
    const out: Move[] = [];
    for (const t of this.hands[s]) {
      if (!this.ends) {
        if (this.chain.length === 0 && (t.id === 27 || !this.hands.some((h) => h.some((x) => x.id === 27))))
          out.push({ kind: 'play', seat: s, tileId: t.id, side: 'right' });
        continue;
      }
      if (t.a === this.ends.left || t.b === this.ends.left) out.push({ kind: 'play', seat: s, tileId: t.id, side: 'left' });
      if (t.a === this.ends.right || t.b === this.ends.right) out.push({ kind: 'play', seat: s, tileId: t.id, side: 'right' });
    }
    return out.length ? out : [{ kind: 'pass', seat: s }];
  }
  apply(m: Move): GameEvent[] {
    const ev: GameEvent[] = [];
    const s = m.seat;
    if (m.kind !== 'play') {
      this.passes++;
      ev.push({ type: 'pass', seat: s, ends: this.ends! });
    } else {
      this.passes = 0;
      const idx = this.hands[s].findIndex((t) => t.id === m.tileId);
      const tile = this.hands[s].splice(idx, 1)[0];
      let placed: PlacedTile;
      const isFirst = !this.ends;
      if (!this.ends) {
        placed = { tile, seat: s, side: 'right', outer: tile.b };
        this.ends = { left: tile.a, right: tile.b };
      } else {
        const end = m.side === 'left' ? this.ends.left : this.ends.right;
        const outer = (tile.a === end ? tile.b : tile.a) as Pip;
        placed = { tile, seat: s, side: m.side, outer };
        this.ends = { ...this.ends, [m.side]: outer };
      }
      this.chain.push(placed);
      ev.push({ type: 'play', seat: s, tile, side: placed.side, placed, ends: { ...this.ends }, tilesLeft: this.hands[s].length, isFirst });
    }
    const pips = this.hands.map((h) => h.reduce((a, t) => a + t.a + t.b, 0)) as [number, number, number, number];
    if (m.kind === 'play' && this.hands[s].length === 0) {
      this.over = true;
      const team = (s % 2) as 0 | 1;
      const pts = pips.reduce((a, b) => a + b, 0);
      this.scores[team] += pts;
      ev.push({ type: 'handEnd', reason: 'domino', winnerSeat: s, winnerTeam: team, points: pts, bonuses: [], pipCounts: pips, remaining: this.hands.map((h) => h.slice()), scores: [...this.scores] as [number, number] });
    } else if (this.passes >= 4) {
      this.over = true;
      const t0 = pips[0] + pips[2];
      const t1 = pips[1] + pips[3];
      const team = t0 === t1 ? null : t0 < t1 ? 0 : 1;
      const pts = t0 + t1;
      if (team !== null) this.scores[team] += pts;
      ev.push({ type: 'handEnd', reason: 'blocked', winnerSeat: team === null ? null : (team as Seat), winnerTeam: team, points: pts, bonuses: [], pipCounts: pips, remaining: this.hands.map((h) => h.slice()), scores: [...this.scores] as [number, number] });
    }
    this.turn = ((this.turn + 1) % 4) as Seat;
    return ev;
  }
}

let run = 0;
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];

async function playHand(humanInteractive: boolean, stopAtHuman = false) {
  const my = ++run;
  view.reset();
  const sim = new Sim();
  await view.handle(sim.startEvent());
  while (!sim.over && my === run) {
    view.setTurn(sim.turn);
    const legal = sim.legal();
    let m: Move;
    if (sim.turn === 0 && (humanInteractive || (stopAtHuman && legal[0].kind === 'play'))) {
      log(`your move: ${legal.length} legal`);
      m = await view.requestHumanMove(legal);
      if (my !== run) return;
      log(`you chose ${JSON.stringify(m)}`);
      if (stopAtHuman) {
        for (const e of sim.apply(m)) await view.handle(e);
        view.setTurn(null);
        return;
      }
    } else {
      await sleep(stopAtHuman ? 60 : 280);
      m = pick(legal);
    }
    for (const e of sim.apply(m)) {
      if (my !== run) return;
      await view.handle(e);
    }
  }
  view.setTurn(null);
  log(`hand over · scores ${sim.scores.join(' - ')}`);
}

async function tranque() {
  const my = ++run;
  view.reset();
  for (let tries = 0; tries < 5000; tries++) {
    const sim = new Sim();
    const start = sim.startEvent();
    const evs: GameEvent[] = [];
    while (!sim.over) evs.push(...sim.apply(pick(sim.legal())));
    const end = evs[evs.length - 1];
    if (end.type === 'handEnd' && end.reason === 'blocked') {
      log(`tranque found after ${tries + 1} sims`);
      view.setSpeed(2.2);
      await view.handle(start);
      for (const e of evs) {
        if (my !== run) break;
        if (e.type === 'handEnd') view.setSpeed(Number((document.getElementById('sSpeed') as HTMLSelectElement).value));
        await view.handle(e);
      }
      return;
    }
  }
  log('no tranque found');
}

function eulerLine(): { tiles: Tile[]; verts: number[] } {
  for (;;) {
    const used = new Set<number>();
    const stack: { v: number; t: number }[] = [{ v: Math.floor(Math.random() * 7), t: -1 }];
    const path: { v: number; t: number }[] = [];
    while (stack.length) {
      const top = stack[stack.length - 1];
      const cand = ALL.filter((t) => !used.has(t.id) && (t.a === top.v || t.b === top.v));
      if (cand.length) {
        const t = pick(cand);
        used.add(t.id);
        stack.push({ v: t.a === top.v ? t.b : t.a, t: t.id });
      } else path.push(stack.pop()!);
    }
    path.reverse();
    if (path.length === 29) return { verts: path.map((p) => p.v), tiles: path.slice(1).map((p) => ALL[p.t]) };
  }
}

async function chain28() {
  const my = ++run;
  view.reset();
  let { tiles, verts } = eulerLine();
  let k = Math.floor(Math.random() * 28);
  if (tiles[k].a !== verts[k]) {
    tiles = tiles.slice().reverse();
    verts = verts.slice().reverse();
    k = 27 - k;
  }
  const order: PlacedTile[] = [{ tile: tiles[k], seat: 0, side: 'right', outer: tiles[k].b }];
  const R: PlacedTile[] = [];
  const L: PlacedTile[] = [];
  for (let j = k + 1; j < 28; j++) R.push({ tile: tiles[j], seat: 0, side: 'right', outer: verts[j + 1] as Pip });
  for (let j = k - 1; j >= 0; j--) L.push({ tile: tiles[j], seat: 0, side: 'left', outer: verts[j] as Pip });
  while (R.length || L.length) order.push((L.length === 0 || (R.length && Math.random() < 0.5) ? R : L).shift()!);
  const hands: Tile[][] = [[], [], [], []];
  order.forEach((p, i) => {
    p.seat = (i % 4) as Seat;
    hands[i % 4].push(p.tile);
  });
  await view.handle({ type: 'handStart', handNo: 1, hands, starter: 0, scores: [0, 0] });
  const left = [7, 7, 7, 7];
  let ends = { left: order[0].tile.a, right: order[0].tile.b };
  for (let i = 0; i < 28 && my === run; i++) {
    const p = order[i];
    left[p.seat]--;
    if (i > 0) ends = { ...ends, [p.side]: p.outer };
    view.setTurn(p.seat);
    await view.handle({ type: 'play', seat: p.seat, tile: p.tile, side: p.side, placed: p, ends: { ...ends }, tilesLeft: left[p.seat], isFirst: i === 0 });
  }
  view.setTurn(null);
  log('28-tile chain done');
}

async function passDemo() {
  const my = ++run;
  view.reset();
  const sim = new Sim();
  await view.handle(sim.startEvent());
  const first = sim.hands[sim.starter].find((t) => t.id === 27)!;
  sim.turn = sim.starter;
  for (const e of sim.apply({ kind: 'play', seat: sim.starter, tileId: first.id, side: 'right' })) await view.handle(e);
  for (const s of [1, 2, 3] as Seat[]) {
    if (my !== run) return;
    view.setTurn(s);
    await view.handle({ type: 'pass', seat: s, ends: sim.ends! });
  }
  view.setTurn(0);
  log('human pass affordance (auto after 1.2s)');
  const m = await view.requestHumanMove([{ kind: 'pass', seat: 0 }]);
  if (my !== run) return;
  await view.handle({ type: 'pass', seat: 0, ends: sim.ends! });
  log(`resolved ${JSON.stringify(m)}`);
  view.setTurn(null);
}

const on = (id: string, fn: () => void) => document.getElementById(id)!.addEventListener('click', fn);
on('bAuto', () => void playHand(false));
on('bPlay', () => void playHand(true));
on('bHuman', () => void playHand(false, true));
on('bPass', () => void passDemo());
on('bTranque', () => void tranque());
on('b28', () => void chain28());
on('bMatch', () => void view.handle({ type: 'matchEnd', winner: Math.random() < 0.7 ? 0 : 1, scores: [100, 64], bonuses: [] }));
on('bReset', () => {
  run++;
  view.reset();
});
(document.getElementById('sFrame') as HTMLSelectElement).addEventListener('change', (e) => {
  app.className = (e.target as HTMLSelectElement).value;
});
(document.getElementById('sQ') as HTMLSelectElement).addEventListener('change', (e) => view.setQuality((e.target as HTMLSelectElement).value as Quality));
(document.getElementById('sSpeed') as HTMLSelectElement).addEventListener('change', (e) => view.setSpeed(Number((e.target as HTMLSelectElement).value)));

const qs = new URLSearchParams(location.search);
if (qs.get('frame')) app.className = qs.get('frame')!;
const auto = qs.get('demo');
if (auto === 'hand') void playHand(false);
else if (auto === 'human') void playHand(false, true);
else if (auto === '28') void chain28();
else if (auto === 'tranque') void tranque();
else if (auto === 'pass') void passDemo();
