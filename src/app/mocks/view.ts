/**
 * DEV MOCK TABLE VIEW (selected with ?mock=1). A flat DOM stand-in for the three.js table:
 * shows the chain and the human hand, delays like animations would, and lets the human click
 * a legal move. Not used in production.
 */
import type { GameEvent, Move, Quality, Seat, TableView, TableViewOptions, Tile } from '../../contracts';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createTableView(opts: TableViewOptions): TableView {
  const fast = new URLSearchParams(location.search).has('fast');
  const scale = fast ? 0.15 : 1;
  const root = document.createElement('div');
  root.style.cssText =
    'position:absolute;inset:0;background:radial-gradient(ellipse at 50% 45%,#1d7a5f,#0b3a30 70%,#071f1a);color:#fff;font:14px system-ui;overflow:hidden';
  const chainEl = document.createElement('div');
  chainEl.style.cssText =
    'position:absolute;left:8%;right:8%;top:40%;transform:translateY(-50%);display:flex;flex-wrap:wrap;gap:3px;justify-content:center;font:600 13px ui-monospace,monospace';
  const handEl = document.createElement('div');
  handEl.style.cssText =
    'position:absolute;left:0;right:0;bottom:calc(16px + env(safe-area-inset-bottom));display:flex;flex-wrap:wrap;gap:6px;justify-content:center;padding:0 8px';
  const seatsEl = document.createElement('div');
  root.append(chainEl, handEl, seatsEl);
  opts.container.append(root);

  let hand: Tile[] = [];
  let paused = false;
  let turn: Seat | null = null;
  const counts = [7, 7, 7, 7];

  const label = (t: Tile) => `${t.a}|${t.b}`;
  const tileBox = (t: Tile, extra = '') => {
    const s = document.createElement('span');
    s.textContent = label(t);
    s.style.cssText = `background:#fff6e6;color:#2a160d;border-radius:5px;padding:4px 5px;box-shadow:0 2px 0 #b9a27f;${extra}`;
    return s;
  };
  const plates: HTMLElement[] = [];
  const pos = [
    'bottom:calc(70px + env(safe-area-inset-bottom));left:50%;transform:translateX(-50%)',
    'right:12px;top:50%',
    'top:22%;left:50%;transform:translateX(-50%)',
    'left:12px;top:50%',
  ];
  for (let s = 0; s < 4; s++) {
    const p = document.createElement('div');
    p.style.cssText = `position:absolute;${pos[s]};padding:3px 8px;border-radius:99px;background:#0006;font-size:12px;transition:box-shadow .2s`;
    plates.push(p);
    seatsEl.append(p);
  }
  const drawPlates = () =>
    plates.forEach((p, s) => {
      p.textContent = `${opts.playerNames[s]} · ${counts[s]}`;
      p.style.boxShadow = turn === s ? '0 0 0 2px #ffb627, 0 0 18px #ffb627' : 'none';
    });
  drawPlates();

  const drawHand = (legal: Move[] = [], pick?: (m: Move) => void) => {
    handEl.replaceChildren();
    for (const t of hand) {
      const mv = legal.filter((m) => m.kind === 'play' && m.tileId === t.id);
      const b = tileBox(t, `font:700 16px ui-monospace,monospace;padding:10px 8px;opacity:${legal.length && !mv.length ? 0.45 : 1}`);
      if (mv.length && pick) {
        b.style.cursor = 'pointer';
        b.style.outline = '2px solid #ffb627';
        b.onclick = () => {
          if (paused) return;
          if (mv.length === 1) return pick(mv[0]);
          // fits both ends: ask
          handEl.replaceChildren();
          for (const m of mv) {
            const c = document.createElement('button');
            c.textContent = `${label(t)} → ${m.kind === 'play' ? (m.side === 'left' ? '◀ izquierda' : 'derecha ▶') : ''}`;
            c.style.cssText = 'padding:12px;border-radius:10px;border:0;font-weight:700';
            c.onclick = () => pick(m);
            handEl.append(c);
          }
        };
      }
      handEl.append(b);
    }
  };

  const sleep = async (ms: number) => {
    let left = ms * scale;
    while (left > 0) {
      await wait(20);
      if (!paused) left -= 20;
    }
  };

  return {
    async handle(ev: GameEvent) {
      switch (ev.type) {
        case 'handStart':
          chainEl.replaceChildren();
          hand = ev.hands[0].slice();
          counts.fill(7);
          opts.onSfx?.('shuffle');
          drawHand();
          drawPlates();
          await sleep(700);
          break;
        case 'play': {
          const b = tileBox(ev.tile);
          if (ev.side === 'left' && !ev.isFirst) chainEl.prepend(b);
          else chainEl.append(b);
          counts[ev.seat] = ev.tilesLeft;
          if (ev.seat === 0) {
            hand = hand.filter((t) => t.id !== ev.tile.id);
            drawHand();
          }
          drawPlates();
          opts.onSfx?.(ev.tilesLeft === 0 ? 'slam' : 'clack');
          await sleep(380);
          break;
        }
        case 'pass':
          opts.onSfx?.('pass');
          await sleep(450);
          break;
        case 'handEnd':
          opts.onSfx?.(ev.reason === 'blocked' ? 'tranque' : 'slam');
          await sleep(900);
          break;
        case 'matchEnd':
          await sleep(300);
          break;
      }
    },
    requestHumanMove(legal: Move[]) {
      return new Promise<Move>((resolve) => {
        if (legal.length === 1 && legal[0].kind === 'pass') {
          drawHand();
          const c = document.createElement('button');
          c.textContent = 'No llevo — paso';
          c.style.cssText = 'padding:12px 16px;border-radius:10px;border:0;font-weight:700';
          c.onclick = () => {
            drawHand();
            resolve(legal[0]);
          };
          handEl.append(c);
          return;
        }
        drawHand(legal, (m) => {
          opts.onSfx?.('select');
          drawHand();
          resolve(m);
        });
      });
    },
    setTurn(seat) {
      turn = seat;
      drawPlates();
    },
    reset() {
      chainEl.replaceChildren();
      handEl.replaceChildren();
      hand = [];
      counts.fill(7);
      turn = null;
      drawPlates();
    },
    setQuality(_q: Quality) {},
    setPaused(p) {
      paused = p;
    },
    dispose() {
      root.remove();
    },
  };
}
