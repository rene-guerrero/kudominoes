/**
 * The in-game chat button (offline and online): a round button beside the player's own plate that opens
 * a pop-up with the player's chosen gestures (up to 5, Ajustes → Juego) and the quick phrases.
 * Offline it only plays on the player's own avatar; online the app sends it to the room.
 */
import type { FaceSpec } from 'kuavatars';
import { CHAT_GESTURES, QUICK_PHRASES, type ChatGesture, type QuickPhraseId } from '../net/protocol';
import { staticFace } from './avatars';
import { h } from './dom';
import { t, type Key } from './i18n';
import type { SeatPlates } from './plates';

export const MAX_GESTURES = 5;
export const DEFAULT_GESTURES: ChatGesture[] = ['thumbsUp', 'clap', 'wave', 'shrug', 'facepalm'];

/** the stored gesture picks: known gestures, no repeats, at most 5 (anything else: the defaults) */
export function sanitizeGestures(v: unknown): ChatGesture[] {
  if (!Array.isArray(v)) return [...DEFAULT_GESTURES];
  const out: ChatGesture[] = [];
  for (const g of v) if ((CHAT_GESTURES as readonly string[]).includes(g) && !out.includes(g) && out.length < MAX_GESTURES) out.push(g);
  return out;
}

export const gestureLabel = (g: ChatGesture): string => t(`gesture.${g}` as Key);
export const phraseText = (id: string): string => ((QUICK_PHRASES as readonly string[]).includes(id) ? t(`phrase.${id as QuickPhraseId}` as Key) : '');

const CHAT_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5h14a2 2 0 0 1 2 2v7.2a2 2 0 0 1-2 2h-7.4L7 20v-3.3H5a2 2 0 0 1-2-2V7.5a2 2 0 0 1 2-2z"/><circle cx="8.4" cy="11.1" r="1.25" fill="#2a160d"/><circle cx="12" cy="11.1" r="1.25" fill="#2a160d"/><circle cx="15.6" cy="11.1" r="1.25" fill="#2a160d"/></svg>';

export interface ChatOpts {
  layer: HTMLElement;
  plates: SeatPlates;
  gestures(): ChatGesture[];
  /** the player's face (the gesture buttons show it making each gesture) */
  face(): FaceSpec;
  onGesture(g: ChatGesture): void;
  onPhrase(id: QuickPhraseId): void;
}

export class ChatButton {
  readonly btn: HTMLButtonElement;
  private pop: HTMLElement | null = null;
  private shown = false;

  constructor(private o: ChatOpts) {
    this.btn = h('button.qp-btn', { type: 'button', 'aria-label': t('chat.title'), title: t('chat.title'), 'aria-expanded': 'false', html: CHAT_ICON }) as HTMLButtonElement;
    this.btn.addEventListener('click', () => this.toggle());
  }

  get isOpen(): boolean {
    return !!this.pop;
  }

  show(): void {
    if (!this.btn.isConnected) this.o.layer.append(this.btn);
    this.shown = true;
    this.o.plates.onLayout = () => this.place();
    this.place();
  }

  hide(): void {
    this.toggle(false);
    this.shown = false;
    this.btn.classList.remove('on');
    this.btn.remove();
    if (this.o.plates.onLayout) this.o.plates.onLayout = null;
  }

  /** just outside the own plate, on the table side */
  private place(): void {
    const b = this.btn;
    const box = this.o.plates.box(0);
    if (!this.shown || !box || !box.visible) {
      b.classList.remove('on');
      return;
    }
    const W = window.innerWidth;
    const size = 40;
    const turned = Math.abs(Math.sin(box.rot)) > 0.7;
    const pw = (turned ? box.h : box.w) * box.scale;
    const ph = (turned ? box.w : box.h) * box.scale;
    const outerLeft = box.x < W * 0.45;
    let x = outerLeft ? box.x - pw / 2 - 10 - size : box.x + pw / 2 + 10;
    if (x < 8) x = box.x + pw / 2 + 10;
    if (x + size > W - 8) x = box.x - pw / 2 - 10 - size;
    let y = box.y - size / 2;
    if (box.layout === 'stack') {
      x = box.x - size / 2;
      y = box.y - ph / 2 - size - 8;
    }
    b.style.transform = `translate(${Math.round(x)}px,${Math.round(Math.max(8, y))}px)`;
    b.classList.add('on');
    if (this.pop) this.placePop();
  }

  toggle(force?: boolean): void {
    const open = force ?? !this.pop;
    if (!open) {
      this.pop?.remove();
      this.pop = null;
      this.btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', this.onDocDown, true);
      return;
    }
    if (this.pop) return;
    const face = this.o.face();
    const gestures = this.o.gestures();
    const gRow = gestures.length
      ? h(
          'div.qp-gestures',
          { role: 'menu', 'aria-label': t('chat.gestures') },
          ...gestures.map((g) => {
            const label = gestureLabel(g);
            const b = h('button.qp-gesture', { type: 'button', role: 'menuitem', 'aria-label': label, title: label }, h('span.qp-gface', staticFace(face, 'idle', { gesture: g })));
            b.addEventListener('click', () => {
              this.o.onGesture(g);
              this.toggle(false);
            });
            return b;
          }),
        )
      : null;
    const grid = h(
      'div.qp-grid',
      { role: 'menu', 'aria-label': t('online.phrases') },
      ...QUICK_PHRASES.map((id) => {
        const b = h('button.qp-opt', { type: 'button', role: 'menuitem' }, phraseText(id));
        b.addEventListener('click', () => {
          this.o.onPhrase(id);
          this.toggle(false);
        });
        return b;
      }),
    );
    this.pop = h('div.qp-pop', gRow, grid);
    this.o.layer.append(this.pop);
    this.btn.setAttribute('aria-expanded', 'true');
    this.placePop();
    setTimeout(() => document.addEventListener('pointerdown', this.onDocDown, true), 0);
  }

  private onDocDown = (e: PointerEvent): void => {
    const el = e.target as Node;
    if (this.pop?.contains(el) || this.btn.contains(el)) return;
    this.toggle(false);
  };

  private placePop(): void {
    const pop = this.pop;
    if (!pop) return;
    const r = this.btn.getBoundingClientRect();
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const W = window.innerWidth;
    let x = r.left + r.width / 2 - pw / 2;
    x = Math.max(8, Math.min(W - pw - 8, x));
    let y = r.top - ph - 10;
    if (y < 8) y = r.bottom + 10;
    pop.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
  }
}
