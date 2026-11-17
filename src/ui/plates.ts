/**
 * HTML name plates (one per seat), laid out by the 3D view (TableViewOptions.onPlates) so they hug
 * each seat's hand and the chain keeps clear of them. Each plate shows the seat's avatar (or a team
 * dot when avatars are off), the name, and the tiles-left count (pip total after a hand).
 * Updates only write a transform, a class or a text node when that value actually changed.
 */
import type { Seat, SeatPlate } from '../contracts';
import type { AvatarController } from './avatars';
import { h, prefersReducedMotion, svgEl } from './dom';

interface PlateEl {
  root: HTMLElement;
  av: HTMLElement;
  dot: HTMLElement;
  name: HTMLElement;
  count: HTMLElement;
  num: Text;
  last: { tf: string; w: number; h: number; d: number; layout: string; edge: string; visible: boolean; active: boolean; winner: boolean; count: number; pips: number | null };
}

export class SeatPlates {
  readonly el: HTMLElement;
  private p: PlateEl[];
  private avatarsOn = true;
  private boxes: (SeatPlate | null)[] = [null, null, null, null];
  private center = { x: 0, y: 0 };
  private bubbles: HTMLElement[] = [];
  /** online: the turn-timer ring of each plate (built on first use) */
  private rings: (SVGSVGElement | null)[] = [null, null, null, null];
  private ringAnim: Animation | null = null;
  private ringSeat: Seat | null = null;
  private warnTimer: ReturnType<typeof setTimeout> | null = null;
  /** called after every layout update (online: the quick-phrase button follows the own plate) */
  onLayout: (() => void) | null = null;

  constructor(private avatars: AvatarController) {
    this.el = h('div.plates', { 'aria-hidden': 'true' });
    this.p = ([0, 1, 2, 3] as Seat[]).map((s) => {
      const dot = h('span.plate-dot');
      const av = h('div.plate-av', dot, avatars.faceEl(s));
      const name = h('span.plate-name');
      const num = document.createTextNode('0');
      const count = h('span.plate-count', h('i.plate-tile'), num);
      const root = h('div.plate', { class: `seat-${s} team-${s % 2}` }, h('div.plate-info', name, count), av);
      this.el.append(root);
      return { root, av, dot, name, count, num, last: { tf: '', w: 0, h: 0, d: 0, layout: '', edge: '', visible: false, active: false, winner: false, count: -1, pips: null } };
    });
    this.setAvatars(true);
  }

  setNames(names: readonly string[]): void {
    this.p.forEach((p, s) => {
      const n = names[s] ?? '';
      p.name.textContent = n;
      // long names (Papi Zorg, Don Julio) get a slightly smaller type instead of an ellipsis
      p.root.classList.toggle('long-name', n.length > 7);
    });
  }

  setAvatars(on: boolean): void {
    this.avatarsOn = on;
    this.el.classList.toggle('no-avatars', !on);
    this.avatars.setEnabled(on);
  }

  /** one short, soft pulse on a plate (the human's turn); no persistent blinking */
  pulse(seat: Seat): void {
    const r = this.p[seat].root;
    const target = r.querySelector('.plate-info') as HTMLElement;
    const av = r.querySelector('.plate-av') as HTMLElement;
    if (prefersReducedMotion()) {
      target.animate([{ filter: 'brightness(1.35)' }, { filter: 'none' }], { duration: 600, easing: 'ease-out' });
      return;
    }
    av.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.14)', offset: 0.35 }, { transform: 'scale(0.98)', offset: 0.7 }, { transform: 'scale(1)' }], { duration: 560, easing: 'ease-out' });
    target.animate(
      [{ boxShadow: 'inset 0 0 0 2px #e8b450, 0 0 0 0 rgba(255,196,96,.55)' }, { boxShadow: 'inset 0 0 0 2px #e8b450, 0 0 0 9px rgba(255,196,96,0)' }],
      { duration: 700, easing: 'ease-out' },
    );
  }

  /** hide while menus/screens are up */
  hide(): void {
    for (const p of this.p) {
      p.root.classList.remove('on');
      p.last.visible = false;
    }
    this.avatars.setVisible(false);
  }

  update(plates: readonly SeatPlate[], center: { x: number; y: number }): void {
    let anyVisible = false;
    for (let s = 0; s < 4; s++) {
      const b = plates[s];
      const p = this.p[s];
      const L = p.last;
      const edge = b.edge ?? '';
      if (b.w !== L.w || b.h !== L.h || b.d !== L.d || b.layout !== L.layout || edge !== L.edge) {
        L.w = b.w;
        L.h = b.h;
        L.d = b.d;
        L.layout = b.layout;
        L.edge = edge;
        p.root.classList.toggle('edge-l', edge === 'left');
        p.root.classList.toggle('edge-r', edge === 'right');
        const st = p.root.style;
        st.width = `${b.w}px`;
        st.height = `${b.h}px`;
        st.setProperty('--d', `${b.d}px`);
        p.root.classList.toggle('stack', b.layout === 'stack');
        p.root.classList.toggle('row', b.layout === 'row');
      }
      const tf = `translate(${(b.x - b.w / 2).toFixed(1)}px,${(b.y - b.h / 2).toFixed(1)}px)${b.scale !== 1 ? ` scale(${b.scale.toFixed(3)})` : ''}${b.rot ? ` rotate(${b.rot.toFixed(3)}rad)` : ''}`;
      if (tf !== L.tf) {
        L.tf = tf;
        p.root.style.transform = tf;
      }
      if (b.visible !== L.visible) {
        L.visible = b.visible;
        p.root.classList.toggle('on', b.visible);
      }
      if (b.active !== L.active) {
        L.active = b.active;
        p.root.classList.toggle('active', b.active);
      }
      if (b.winner !== L.winner) {
        L.winner = b.winner;
        p.root.classList.toggle('winner', b.winner);
      }
      if (b.count !== L.count || b.pips !== L.pips) {
        L.count = b.count;
        L.pips = b.pips;
        p.num.data = String(b.pips ?? b.count);
        p.count.classList.toggle('pips', b.pips !== null);
      }
      anyVisible ||= b.visible;
    }
    for (let s = 0; s < 4; s++) this.boxes[s] = { ...plates[s], bubble: plates[s].bubble ? { ...plates[s].bubble! } : undefined };
    this.center = { x: center.x, y: center.y };
    this.avatars.setPositions(plates, center);
    this.avatars.setVisible(anyVisible && this.avatarsOn);
    this.onLayout?.();
  }

  /** the last layout box of a seat's plate (null before the first layout) */
  box(seat: Seat): SeatPlate | null {
    return this.boxes[seat];
  }

  /**
   * Online: the turn timer as a thin ring round the avatar of the seat to move, emptying until
   * `endsAt` (Date.now() ms). No numbers. `warnAt` (ms before the end, 0 = never) softly warms the ring
   * and calls `onWarn` once. `null` removes it.
   */
  setTimer(seat: Seat | null, endsAt = 0, total = 30_000, warnAt = 0, onWarn?: () => void): void {
    if (this.warnTimer) clearTimeout(this.warnTimer);
    this.warnTimer = null;
    this.ringAnim?.cancel();
    this.ringAnim = null;
    if (this.ringSeat !== null) {
      const old = this.rings[this.ringSeat];
      old?.classList.remove('on', 'warn');
      this.p[this.ringSeat].root.classList.remove('timing');
    }
    this.ringSeat = seat;
    if (seat === null) return;
    let ring = this.rings[seat];
    if (!ring) {
      ring = svgEl('<svg class="plate-timer" viewBox="0 0 100 100" aria-hidden="true"><circle class="pt-track" cx="50" cy="50" r="47"/><circle class="pt-run" cx="50" cy="50" r="47" pathLength="100"/></svg>');
      this.rings[seat] = ring;
      this.p[seat].av.append(ring);
    }
    const left = Math.max(0, endsAt - Date.now());
    const elapsed = Math.max(0, total - left);
    ring.classList.add('on');
    this.p[seat].root.classList.add('timing');
    const run = ring.querySelector('.pt-run') as SVGCircleElement;
    // remaining share as the dash: full ring at the start, empty at the deadline
    const anim = run.animate([{ strokeDashoffset: '0' }, { strokeDashoffset: '100' }], { duration: Math.max(1, total), fill: 'forwards', easing: 'linear' });
    anim.currentTime = Math.min(total, elapsed);
    this.ringAnim = anim;
    if (warnAt > 0) {
      const warn = () => {
        this.warnTimer = null;
        if (this.ringSeat !== seat) return;
        ring!.classList.add('warn');
        onWarn?.();
      };
      if (left <= warnAt) {
        if (left > 0) warn();
      } else this.warnTimer = setTimeout(warn, left - warnAt);
    }
  }

  /** while the human drags a ficha, the own plate fades out of its way */
  setDragging(on: boolean): void {
    this.el.classList.toggle('dragging', on);
  }

  /**
   * A per-player callout (Paso, ¡Dominó!, ¡Cerrado!, ¡Capicúa!) as a speech bubble on the seat's plate,
   * growing toward the table centre: right of the left seat, left of the right seat, below the top seat,
   * above/right of the human. Clamped inside the viewport.
   */
  say(seat: Seat, text: string, strong = false, ms = 1500): void {
    const box = this.boxes[seat];
    if (!box || !box.visible) return;
    let b = this.bubbles[seat];
    if (!b) {
      b = h('div.plate-bubble', { role: 'status', 'aria-live': 'polite' });
      this.bubbles[seat] = b;
      this.el.append(b);
    }
    const anchor = box.bubble;
    const dir = anchor?.dir ?? (seat === 3 ? 'right' : seat === 1 ? 'left' : seat === 2 ? 'down' : 'up');
    // edge plates (portrait sides) get the compact bubble, rising over their stack and growing inward
    b.className = `plate-bubble dir-${dir}${strong ? ' strong' : ''}${box.edge ? ' edge' : ''}`;
    b.textContent = text;
    b.style.transform = 'none';
    b.getAnimations().forEach((a) => a.cancel());
    const bw = b.offsetWidth;
    const bh = b.offsetHeight;
    // plate extent (a plate rotated by ~90° swaps its width and height)
    const turned = Math.abs(Math.sin(box.rot)) > 0.7;
    const pw = (turned ? box.h : box.w) * box.scale;
    const ph = (turned ? box.w : box.h) * box.scale;
    const gap = 8;
    let x: number;
    let y: number;
    if (anchor) {
      // the renderer's anchor (the chain keeps clear of it)
      x = dir === 'left' ? anchor.x - bw : dir === 'right' ? anchor.x : anchor.x - bw / 2;
      y = dir === 'up' ? anchor.y - bh : dir === 'down' ? anchor.y : anchor.y - bh / 2;
    } else if (dir === 'right') {
      x = box.x + pw / 2 + gap;
      y = box.y - bh / 2;
    } else if (dir === 'left') {
      x = box.x - pw / 2 - gap - bw;
      y = box.y - bh / 2;
    } else if (dir === 'down') {
      x = box.x - bw / 2;
      y = box.y + ph / 2 + gap;
    } else {
      x = box.x + pw / 2 - bw * 0.35;
      y = box.y - ph / 2 - gap - bh;
    }
    const W = this.el.clientWidth || window.innerWidth;
    const H = this.el.clientHeight || window.innerHeight;
    x = Math.max(6, Math.min(W - bw - 6, x));
    y = Math.max(6, Math.min(H - bh - 6, y));
    // a (wrapped, taller) bubble never covers the HUD: slide it just below any HUD box it would overlap
    const o = this.el.getBoundingClientRect();
    for (const hud of document.querySelectorAll<HTMLElement>('.hud-top > *')) {
      const r = hud.getBoundingClientRect();
      if (!r.width) continue;
      const l = r.left - o.left;
      const t = r.top - o.top;
      if (x < l + r.width && x + bw > l && y < t + r.height && y + bh > t) y = Math.min(H - bh - 6, t + r.height + 4);
    }
    b.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
    // grow out of the anchor (after clamping, an edge plate's bubble starts at its outer end)
    const ox = anchor && (dir === 'up' || dir === 'down') ? `${Math.round(Math.max(0, Math.min(1, (anchor.x - x) / bw)) * 100)}%` : null;
    const origin =
      dir === 'right' ? '0% 50%' : dir === 'left' ? '100% 50%' : dir === 'down' ? `${ox ?? '50%'} 0%` : `${ox ?? '30%'} 100%`;
    b.style.transformOrigin = origin;
    const base = b.style.transform;
    const rm = prefersReducedMotion();
    b.animate(
      rm
        ? [{ opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }]
        : [
            { opacity: 0, transform: `${base} scale(.3)` },
            { opacity: 1, transform: `${base} scale(1.08)`, offset: 0.1 },
            { opacity: 1, transform: `${base} scale(1)`, offset: 0.16 },
            { opacity: 1, transform: `${base} scale(1)`, offset: 0.85 },
            { opacity: 0, transform: `${base} scale(.92)` },
          ],
      { duration: ms, easing: 'ease-out', fill: 'forwards' },
    );
  }

  clearBubbles(): void {
    for (const b of this.bubbles) b?.getAnimations().forEach((a) => a.cancel());
  }
}