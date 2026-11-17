/**
 * End-to-end test against a running `wrangler dev` (Node 22+: global WebSocket and fetch).
 *
 *   npx wrangler dev --port 8787 --var KUDO_TURN_TIMEOUT_MS:1500 --var KUDO_GRACE_MS:800 \
 *     --var KUDO_NEXT_HAND_MS:600 --var KUDO_CPU_SPEED:0.03
 *   node test/integration.mjs            (KUDO_URL overrides http://127.0.0.1:8787)
 *
 * Every message every client receives is checked for leaks: during a hand a client may only ever see
 * its own tiles and the tiles played on the table (others' hands and the pozo arrive as id -1).
 */
const BASE = process.env.KUDO_URL ?? 'http://127.0.0.1:8787';
const WS_BASE = BASE.replace(/^http/, 'ws');
const V = 1;

let failures = 0;
const ok = (cond, what) => {
  if (!cond) {
    failures++;
    console.error('  FAIL', what);
    throw new Error(what);
  }
  console.log('  ok  ', what);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(name, pid, code) {
    Object.assign(this, { name, pid, code });
    this.msgs = [];
    this.seat = null;
    this.hand = new Map(); // my tiles: id → tile
    this.seenSecret = new Set(); // tile ids received this hand that were neither mine nor played
    this.played = new Set();
    this.autoplay = true;
    this.leaks = [];
    this.waiters = [];
    this.room = null;
    this.turn = null;
    this.handsEnded = 0;
    this.drawsSeen = { mine: 0, others: 0 };
    this.errors = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${WS_BASE}/api/rooms/${this.code}/ws?pid=${this.pid}`, { headers: { Origin: 'http://localhost:5173' } });
      this.ws = ws;
      ws.onopen = () => {
        this.send({ t: 'hello', v: V, playerId: this.pid, name: this.name, face: 2 });
        resolve();
      };
      ws.onerror = (e) => reject(e);
      ws.onmessage = (e) => this.onMsg(JSON.parse(e.data));
      ws.onclose = () => (this.closed = true);
    });
  }
  close() {
    this.ws.close(1000, 'bye');
  }
  send(m) {
    this.ws.send(JSON.stringify(m));
  }
  /** every tile-shaped object in a value */
  static tiles(x, acc = []) {
    if (Array.isArray(x)) x.forEach((v) => Client.tiles(v, acc));
    else if (x && typeof x === 'object') {
      if (typeof x.id === 'number' && typeof x.a === 'number' && typeof x.b === 'number') acc.push(x);
      for (const v of Object.values(x)) Client.tiles(v, acc);
    }
    return acc;
  }
  noteSecret(value, allow = new Set()) {
    for (const t of Client.tiles(value)) {
      if (t.id === -1 || this.hand.has(t.id) || this.played.has(t.id) || allow.has(t.id)) continue;
      this.seenSecret.add(t.id);
    }
  }
  onMsg(m) {
    this.msgs.push(m);
    switch (m.t) {
      case 'welcome':
      case 'sync': {
        this.room = m.room;
        if (m.t === 'welcome') this.seat = m.you.seat;
        const v = m.view;
        if (v) {
          const h = v.match.hand;
          if (v.match.rng !== 0) this.leaks.push('view rng');
          if (h) {
            h.hands.forEach((tiles, s) => s !== v.seat && tiles.length && this.leaks.push(`view hand of ${s}`));
            if (h.boneyard && h.boneyard.length) this.leaks.push('view boneyard');
            this.hand = new Map(h.hands[v.seat].map((t) => [t.id, t]));
            this.played = new Set(h.chain.map((p) => p.tile.id));
            if (h.hands[v.seat].length !== v.handCounts[v.seat]) this.leaks.push('view count mismatch');
          }
        }
        break;
      }
      case 'room':
        this.room = m.room;
        break;
      case 'events':
        for (const ev of m.events) this.onEvent(ev);
        break;
      case 'turn':
        this.turn = m;
        this.maybeAct(m);
        break;
      case 'error':
        this.errors.push(m);
        break;
    }
    for (const w of this.waiters.slice()) if (w.pred(m)) (this.waiters.splice(this.waiters.indexOf(w), 1), w.resolve(m));
  }
  onEvent(ev) {
    switch (ev.type) {
      case 'handStart':
        this.hand = new Map(ev.hands[this.seat].map((t) => [t.id, t]));
        this.played = new Set();
        this.seenSecret = new Set();
        ev.hands.forEach((h, s) => s !== this.seat && h.some((t) => t.id !== -1) && this.leaks.push(`handStart hand of ${s}`));
        if (ev.boneyard && ev.boneyard.some((t) => t.id !== -1)) this.leaks.push('handStart boneyard');
        break;
      case 'play':
        this.played.add(ev.tile.id);
        if (ev.seat === this.seat) {
          if (!this.hand.has(ev.tile.id)) this.leaks.push('played a tile I did not have');
          this.hand.delete(ev.tile.id);
        }
        this.noteSecret(ev, new Set([ev.tile.id]));
        break;
      case 'draw':
        if (ev.seat === this.seat) {
          this.drawsSeen.mine++;
          if (ev.tile.id === -1) this.leaks.push('my own draw was hidden');
          this.hand.set(ev.tile.id, ev.tile);
        } else {
          this.drawsSeen.others++;
          if (ev.tile.id !== -1) this.leaks.push(`draw of seat ${ev.seat} showed tile ${ev.tile.id}`);
        }
        break;
      case 'handEnd': {
        this.handsEnded++;
        // what the others really held: none of it may have reached me before this reveal
        const others = new Set();
        ev.remaining.forEach((h, s) => s !== this.seat && h.forEach((t) => others.add(t.id)));
        for (const id of this.seenSecret) if (others.has(id)) this.leaks.push(`saw ${id} of another hand before handEnd`);
        if (this.seenSecret.size) this.leaks.push(`received hidden tile ids ${[...this.seenSecret]}`);
        const mine = ev.remaining[this.seat].map((t) => t.id).sort().join();
        if (mine !== [...this.hand.keys()].sort().join()) this.leaks.push('my tracked hand differs from handEnd.remaining');
        break;
      }
      default:
        this.noteSecret(ev);
    }
  }
  maybeAct(m) {
    if (m.choosingStarter && this.seat !== null && m.starterChooser === this.seat && this.autoplay) {
      setTimeout(() => this.send({ t: 'chooseStarter', seat: this.seat }), 20);
      return;
    }
    if (!m.legal.length || !this.autoplay) return;
    for (const mv of m.legal) if (mv.kind === 'play' && !this.hand.has(mv.tileId)) this.leaks.push('legal move with a tile not in my hand');
    const mv = m.legal[Math.floor(Math.random() * m.legal.length)];
    setTimeout(() => this.send({ t: 'move', move: mv }), 10);
  }
  waitFor(pred, ms = 20000, what = 'message') {
    const hit = this.msgs.find(pred);
    if (hit && !this.waitFresh) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) (this.waiters.splice(i, 1), reject(new Error(`${this.name}: timeout waiting for ${what}`)));
      }, ms);
    });
  }
  /** wait for a future message only */
  next(pred, ms, what) {
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) (this.waiters.splice(i, 1), reject(new Error(`${this.name}: timeout waiting for ${what}`)));
      }, ms ?? 20000);
    });
  }
}

const api = async (path, init) => {
  const r = await fetch(`${BASE}${path}`, { ...init, headers: { Origin: 'https://rene-guerrero.github.io', ...(init?.headers ?? {}) } });
  return { status: r.status, body: await r.json(), cors: r.headers.get('access-control-allow-origin') };
};
const rid = (p) => `${p}-${Math.random().toString(36).slice(2, 10)}`;

async function pairsTest() {
  console.log('\n== pairs: 2 humans + 2 CPUs ==');
  const A = rid('ana');
  const created = await api(`/api/rooms?pid=${A}`, { method: 'POST' });
  ok(created.status === 201 && /^[23456789A-HJ-NP-Z]{4}$/.test(created.body.code), `room created ${created.body.code}`);
  ok(created.cors === 'https://rene-guerrero.github.io', 'CORS header for the Pages origin');
  const code = created.body.code;
  const info = await api(`/api/rooms/${code.toLowerCase()}`);
  ok(info.body.exists && info.body.phase === 'lobby' && info.body.freeSeats === 4, 'room info: lobby, 4 free seats');
  ok((await api('/api/rooms/ZZZZ')).body.exists === false, 'unknown room does not exist');

  const a = new Client('Ana', A, code);
  const b = new Client('Beto', rid('beto'), code);
  await a.connect();
  const wa = await a.waitFor((m) => m.t === 'welcome', 5000, 'welcome');
  ok(wa.you.isHost && wa.you.seat === 0, 'creator is host in seat 0');
  await b.connect();
  const wb = await b.waitFor((m) => m.t === 'welcome', 5000, 'welcome');
  ok(!wb.you.isHost && wb.you.seat === 1, 'second player auto-seated in seat 1');
  b.send({ t: 'sit', seat: 2 });
  await a.waitFor((m) => m.t === 'room' && m.room.seats[2].kind === 'human', 5000, 'B in seat 2');
  b.seat = 2;
  b.send({ t: 'start' });
  await b.waitFor((m) => m.t === 'error' && m.code === 'not_host', 5000, 'not_host');
  ok(true, 'non-host cannot start');
  a.send({ t: 'setRules', rules: { ...a.room.rules, target: 10 } });
  await a.waitFor((m) => m.t === 'room' && m.room.rules.target === 10, 5000, 'rules');
  a.send({ t: 'phrase', id: 'hello' });
  a.send({ t: 'phrase', id: 'hello' });
  await b.waitFor((m) => m.t === 'phrase' && m.seat === 0, 5000, 'phrase');
  await a.waitFor((m) => m.t === 'error' && m.code === 'rate_limited', 5000, 'rate_limited');
  ok(true, 'phrases relayed and rate-limited');

  a.send({ t: 'start' });
  const rs = await a.waitFor((m) => m.t === 'room' && m.room.phase === 'playing', 5000, 'playing');
  ok(rs.room.seats[1].kind === 'cpu' && rs.room.seats[3].kind === 'cpu', `CPUs auto-filled (${rs.room.seats[1].characterId}, ${rs.room.seats[3].characterId})`);

  // a bad move and a move out of turn are refused (A holds its first real turn for the checks)
  a.autoplay = false;
  const myTurn = await a.waitFor((m) => m.t === 'turn' && m.legal.length > 0, 30000, 'a turn of A');
  b.send({ t: 'move', move: { kind: 'pass', seat: b.seat } });
  await b.waitFor((m) => m.t === 'error' && m.code === 'not_your_turn', 5000, 'not_your_turn');
  ok(true, 'move out of turn refused');
  a.send({ t: 'move', move: { kind: 'play', seat: a.seat, tileId: 99, side: 'left' } });
  await a.waitFor((m) => m.t === 'error' && m.code === 'bad_move', 5000, 'bad_move');
  ok(myTurn.deadline > Date.now() - 5000, 'illegal move refused; turn has a deadline');
  a.autoplay = true;
  a.maybeAct(a.turn);

  await a.waitFor((m) => m.t === 'events' && m.events.some((e) => e.type === 'handEnd'), 60000, 'handEnd A');
  await b.waitFor((m) => m.t === 'events' && m.events.some((e) => e.type === 'handEnd'), 60000, 'handEnd B');
  ok(a.leaks.length === 0 && b.leaks.length === 0, `full hand played without leaks (${a.leaks.concat(b.leaks).join('; ') || 'none'})`);

  // turn timeout: B stops answering; the server's CPU plays for B
  b.autoplay = false;
  const cov = await a.next((m) => m.t === 'covered' && m.seat === b.seat && m.reason === 'timeout', 30000, 'timeout cover');
  ok(!!cov, 'turn timeout → CPU covered B (reason timeout)');
  b.autoplay = true;
  if (b.turn?.legal?.length) b.maybeAct(b.turn);

  // disconnect: B drops, A sees it, then the CPU covers after the grace period
  b.close();
  await a.next((m) => m.t === 'room' && m.room.seats[b.seat].connected === false, 5000, 'B disconnected');
  ok(true, 'A sees B disconnected');
  await a.next((m) => m.t === 'room' && m.room.seats[b.seat].cpuCovering === true, 5000, 'B covered');
  await a.next((m) => m.t === 'covered' && m.seat === b.seat && m.reason === 'disconnected', 30000, 'disconnected cover');
  ok(true, 'CPU plays for the disconnected player');

  // reconnect with the same playerId: private resync, control comes back
  const b2 = new Client('Beto', b.pid, code);
  await b2.connect();
  const w2 = await b2.waitFor((m) => m.t === 'welcome', 5000, 'welcome again');
  ok(w2.you.seat === 2 && w2.view && w2.view.seat === 2, 'reconnect: same seat, private view');
  const h = w2.view.match.hand;
  ok(!h || h.hands.every((t, s) => s === 2 || t.length === 0), 'reconnect view hides other hands');
  ok(w2.room.seats[2].connected && !w2.room.seats[2].cpuCovering, 'reconnect: connected, no longer covered');
  ok(b2.leaks.length === 0, 'reconnect view consistent');

  // play the match out
  const end = await a.waitFor((m) => m.t === 'events' && m.events.some((e) => e.type === 'matchEnd'), 180000, 'matchEnd');
  const me = end.events.find((e) => e.type === 'matchEnd');
  await a.waitFor((m) => m.t === 'room' && m.room.phase === 'finished', 5000, 'finished');
  ok(true, `match finished, scores ${me.scores.join('-')} after ${a.handsEnded} hands`);
  ok(a.leaks.length === 0 && b2.leaks.length === 0, `no leaks over the whole match (${a.leaks.concat(b2.leaks).join('; ') || 'none'})`);

  // rematch keeps the room and the seats
  a.send({ t: 'rematch' });
  const re = await a.next((m) => m.t === 'room' && m.room.phase === 'playing', 5000, 'rematch');
  ok(re.room.seats[0].playerId === A && re.room.seats[2].playerId === b.pid && re.room.code === code, 'rematch: same room, same seats');
  await a.next((m) => m.t === 'events' && m.events[0]?.type === 'handStart', 5000, 'rematch deal');
  ok(true, 'rematch dealt a new hand');
  a.send({ t: 'leave' });
  await b2.next((m) => m.t === 'room' && m.room.hostId === b.pid && m.room.seats[0].kind === 'cpu', 5000, 'host passes');
  ok(true, 'host leaves: host passes to B, a CPU takes the seat');
  b2.close();
}

async function individualTest() {
  console.log('\n== individual: 3 players, boneyard ==');
  const C = rid('caro');
  const code = (await api(`/api/rooms?pid=${C}`, { method: 'POST' })).body.code;
  const c = new Client('Caro', C, code);
  await c.connect();
  await c.waitFor((m) => m.t === 'welcome', 5000, 'welcome');
  c.send({ t: 'setMode', mode: 'individual', playerCount: 3 });
  await c.waitFor((m) => m.t === 'room' && m.room.mode === 'individual', 5000, 'mode');
  c.send({ t: 'start' });
  const rs = await c.waitFor((m) => m.t === 'room' && m.room.phase === 'playing', 5000, 'playing');
  ok(rs.room.seats[2].kind === 'empty' && rs.room.seats[1].kind === 'cpu' && rs.room.seats[3].kind === 'cpu', 'seats 0,1,3 in play (2 CPUs)');
  const hs = await c.waitFor((m) => m.t === 'events' && m.events[0]?.type === 'handStart', 5000, 'deal');
  ok(hs.events[0].boneyard?.length === 7 && hs.events[0].boneyard.every((t) => t.id === -1), 'pozo of 7 sent as hidden placeholders');
  // play hands until both kinds of draws were seen (or a few hands went by)
  for (let i = 0; i < 6 && (c.drawsSeen.others === 0 || c.drawsSeen.mine === 0); i++) {
    const n = c.handsEnded;
    await c.waitFor(() => c.handsEnded > n || c.room?.phase === 'finished', 90000, 'handEnd');
    if (c.room?.phase === 'finished') break;
  }
  ok(c.drawsSeen.others > 0, `others drew ${c.drawsSeen.others} times (tiles hidden), I drew ${c.drawsSeen.mine} times (tiles shown)`);
  ok(c.leaks.length === 0, `individual: no leaks (${c.leaks.join('; ') || 'none'})`);
  c.close();
}

try {
  await pairsTest();
  await individualTest();
} catch (e) {
  failures++;
  console.error(e);
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL INTEGRATION CHECKS PASSED');
process.exit(failures ? 1 : 0);
