import { h } from './dom';
import { uiClick } from '../audio/sfx';

/**
 * The HTML layer above the 3D canvas. Three stacked layers:
 *  - hud    (in-game, pointer-events only on its buttons)
 *  - screen (menu / settings / how-to: full screen)
 *  - modal  (pause, hand summary, match end, confirms)
 */
export class Overlay {
  readonly root: HTMLElement;
  readonly hudLayer: HTMLElement;
  readonly screenLayer: HTMLElement;
  readonly modalLayer: HTMLElement;
  private current: HTMLElement | null = null;
  private modals: HTMLElement[] = [];

  constructor(root: HTMLElement) {
    this.root = root;
    root.classList.add('overlay');
    this.hudLayer = h('div.layer.layer-hud');
    this.screenLayer = h('div.layer.layer-screen');
    this.modalLayer = h('div.layer.layer-modal');
    root.append(this.hudLayer, this.screenLayer, this.modalLayer);
    // UI click sound on any button press
    root.addEventListener('pointerdown', (e) => {
      const b = (e.target as HTMLElement).closest('button, .seg-opt, .switch');
      if (b && !(b as HTMLButtonElement).disabled) uiClick();
    });
  }

  showScreen(el: HTMLElement | null): void {
    const old = this.current;
    this.current = el;
    if (old) {
      old.classList.add('leaving');
      old.setAttribute('inert', '');
      const done = () => old.remove();
      old.addEventListener('animationend', done, { once: true });
      setTimeout(done, 400);
    }
    if (el) {
      el.classList.add('entering');
      el.addEventListener('animationend', () => el.classList.remove('entering'), { once: true });
      this.screenLayer.append(el);
      focusFirst(el);
    }
  }

  get screen(): HTMLElement | null {
    return this.current;
  }

  /** Opens a modal; returns a function that closes it. */
  openModal(el: HTMLElement, opts: { dim?: boolean } = {}): () => void {
    const wrap = h('div.modal-wrap', { role: 'dialog', 'aria-modal': 'true' }, el);
    if (opts.dim !== false) wrap.classList.add('dim');
    this.modals.push(wrap);
    this.modalLayer.append(wrap);
    focusFirst(el);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      this.modals = this.modals.filter((m) => m !== wrap);
      wrap.classList.add('leaving');
      wrap.setAttribute('inert', '');
      const done = () => wrap.remove();
      wrap.addEventListener('animationend', done, { once: true });
      setTimeout(done, 400);
    };
  }

  get modalOpen(): boolean {
    return this.modals.length > 0;
  }

  closeAllModals(): void {
    for (const m of this.modals) m.remove();
    this.modals = [];
  }
}

function focusFirst(el: HTMLElement) {
  // Only move focus for keyboard users; avoids popping the soft keyboard / focus rings on touch.
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  requestAnimationFrame(() => (el.querySelector('[data-autofocus], button') as HTMLElement | null)?.focus({ preventScroll: true }));
}

// ───────────────────────── shared components ─────────────────────────

export function btn(label: string, onClick: () => void, cls = '', extra?: Node): HTMLButtonElement {
  const b = h('button.btn', { type: 'button', class: cls }, h('span.btn-label', label), extra ?? null);
  b.addEventListener('click', onClick);
  return b;
}

export function iconBtn(icon: string, label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = h('button.icon-btn', { type: 'button', 'aria-label': label, title: label, class: cls, html: icon });
  b.addEventListener('click', onClick);
  return b;
}

export const ICONS = {
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4.2" height="14" rx="1.6"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.6"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
  gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zm8.6 4.9l-1.9-.4a6.9 6.9 0 0 1-.6 1.5l1.1 1.6-2 2-1.6-1.1c-.5.3-1 .5-1.5.6l-.4 1.9h-2.8l-.4-1.9a6.9 6.9 0 0 1-1.5-.6l-1.6 1.1-2-2 1.1-1.6c-.3-.5-.5-1-.6-1.5l-1.9-.4v-2.8l1.9-.4c.1-.5.3-1 .6-1.5L4.4 6.3l2-2 1.6 1.1c.5-.3 1-.5 1.5-.6l.4-1.9h2.8l.4 1.9c.5.1 1 .3 1.5.6l1.6-1.1 2 2-1.1 1.6c.3.5.5 1 .6 1.5l1.9.4z"/></svg>',
  book: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A1.5 1.5 0 0 0 5 19.5 1.5 1.5 0 0 0 6.5 21H20v-1.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 5.5v14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  resume: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12a7 7 0 1 0 2.1-5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path d="M4 3.5v4.5h4.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="12" cy="7.8" r="1.5"/><path d="M12 11v5.6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11l8-7 8 7v8.5a1.5 1.5 0 0 1-1.5 1.5H15v-6H9v6H5.5A1.5 1.5 0 0 1 4 19.5z"/></svg>',
};

export function toggle(checked: boolean, onChange: (v: boolean) => void, label: string): HTMLButtonElement {
  const b = h('button.switch', { type: 'button', role: 'switch', 'aria-checked': String(checked), 'aria-label': label }, h('span.knob'));
  b.addEventListener('click', () => {
    checked = !checked;
    b.setAttribute('aria-checked', String(checked));
    onChange(checked);
  });
  return b;
}

export function segmented<T extends string | number | boolean>(
  options: { value: T; label: string }[],
  value: T,
  onChange: (v: T) => void,
  label: string,
): HTMLElement {
  const group = h('div.seg', { role: 'radiogroup', 'aria-label': label });
  const items = options.map((o) => {
    const b = h('button.seg-opt', { type: 'button', role: 'radio', 'aria-checked': String(o.value === value) }, o.label);
    b.addEventListener('click', () => {
      if (o.value === value) return;
      value = o.value;
      items.forEach((it, i) => it.setAttribute('aria-checked', String(options[i].value === value)));
      onChange(o.value);
    });
    return b;
  });
  group.append(...items);
  return group;
}

export function confirmDialog(
  overlay: Overlay,
  o: { title: string; body: string; ok: string; cancel: string; danger?: boolean },
): Promise<boolean> {
  return new Promise((resolve) => {
    let close = () => {};
    const card = h(
      'div.card.dialog',
      h('h2.card-title', o.title),
      h('p.card-body', o.body),
      h(
        'div.row',
        btn(o.cancel, () => {
          close();
          resolve(false);
        }, 'ghost'),
        btn(o.ok, () => {
          close();
          resolve(true);
        }, o.danger ? 'danger' : 'primary'),
      ),
    );
    close = overlay.openModal(card);
  });
}
