/**
 * Desktop affordances for a single-row horizontal scroller (`.hscroll` track inside a `.hscroll-wrap`):
 *  - mouse wheel scrolls it sideways (the page keeps the wheel once the row is at that end);
 *  - click-and-drag with the mouse scrolls it (a 6 px threshold keeps clicks working; the click that
 *    ends a drag is swallowed);
 *  - round arrow buttons at the edges with more content that way (hover/fine-pointer layouts only, CSS);
 *  - ArrowLeft/Right/Home/End move the selection between the items (radio buttons) and keep it in view,
 *    unless an item's own handler already took the key (`defaultPrevented`);
 *  - `more-left` / `more-right` (edge fades + arrows) and `hs-fits` (everything fits: no scrolling UI,
 *    items centred) on the wrap.
 * Touch is untouched (native momentum + snap). Returns a cleanup function.
 *
 * Stable API for other screens: `enhanceHScroll(track, { keyboard? })`.
 */
import { h } from './dom';
import { getLang } from './i18n';

export interface HScrollOpts {
  /** arrow keys move the selection (default true) */
  keyboard?: boolean;
  /** labels for the arrow buttons (screen readers; they are also hidden from the tab order) */
  prevLabel?: string;
  nextLabel?: string;
}

const CHEVRON = (d: string) => `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const defaultLabel = (dir: -1 | 1) => (getLang() === 'en' ? (dir < 0 ? 'Previous' : 'Next') : dir < 0 ? 'Anterior' : 'Siguiente');

export function enhanceHScroll(track: HTMLElement, opts: HScrollOpts = {}): () => void {
  const wrap = (track.closest('.hscroll-wrap') as HTMLElement | null) ?? track.parentElement ?? track;
  const ac = new AbortController();
  const sig = { signal: ac.signal };
  const max = () => track.scrollWidth - track.clientWidth;

  // ── edge state ──
  const update = () => {
    const m = max();
    const fits = m <= 1;
    wrap.classList.toggle('hs-fits', fits);
    wrap.classList.toggle('more-left', !fits && track.scrollLeft > 2);
    wrap.classList.toggle('more-right', !fits && track.scrollLeft < m - 2);
  };
  track.addEventListener('scroll', update, { passive: true, signal: ac.signal });
  wrap.addEventListener('pointerenter', update, sig);
  const ro = new ResizeObserver(update);
  ro.observe(track);
  for (const c of Array.from(track.children)) ro.observe(c);

  // free scrolling (no snap) while the wheel or a drag drives it, so small steps are not snapped back
  let freeTimer = 0;
  const free = (ms = 180) => {
    track.classList.add('hs-free');
    clearTimeout(freeTimer);
    freeTimer = window.setTimeout(() => track.classList.remove('hs-free'), ms);
  };

  // ── wheel ──
  track.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey) return; // pinch-zoom gesture
      const m = max();
      if (m <= 1) return;
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? track.clientWidth : 1;
      const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * k;
      if (!d) return;
      const x = track.scrollLeft;
      if ((d > 0 && x >= m - 1) || (d < 0 && x <= 1)) return; // at that end: let the page scroll
      e.preventDefault();
      free();
      track.scrollLeft = Math.max(0, Math.min(m, x + d));
    },
    { passive: false, signal: ac.signal },
  );

  // ── mouse drag ──
  let down = false;
  let dragging = false;
  let sx = 0;
  let sl = 0;
  let pid = -1;
  let swallowClick = false;
  track.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType !== 'mouse' || e.button !== 0 || max() <= 1) return;
      down = true;
      dragging = false;
      sx = e.clientX;
      sl = track.scrollLeft;
      pid = e.pointerId;
    },
    sig,
  );
  track.addEventListener(
    'pointermove',
    (e) => {
      if (!down || e.pointerId !== pid) return;
      const dx = e.clientX - sx;
      if (!dragging) {
        if (Math.abs(dx) < 6) return;
        dragging = true;
        try {
          track.setPointerCapture(pid);
        } catch {
          /* pointer already gone */
        }
        track.classList.add('hs-dragging');
      }
      free(400);
      track.scrollLeft = sl - dx;
    },
    sig,
  );
  const end = (e: PointerEvent) => {
    if (!down || e.pointerId !== pid) return;
    down = false;
    if (dragging) {
      dragging = false;
      swallowClick = true;
      track.classList.remove('hs-dragging');
      free(60); // snap back on (proximity) once the drag ends
      setTimeout(() => (swallowClick = false), 0);
    }
  };
  track.addEventListener('pointerup', end, sig);
  track.addEventListener('pointercancel', end, sig);
  track.addEventListener(
    'click',
    (e) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.preventDefault();
      e.stopPropagation();
    },
    { capture: true, signal: ac.signal },
  );
  track.addEventListener('dragstart', (e) => e.preventDefault(), sig);

  // ── arrow buttons ──
  const arrow = (dir: -1 | 1) => {
    const b = h('button.hs-arrow', { type: 'button', class: dir < 0 ? 'prev' : 'next', tabindex: -1, 'aria-label': (dir < 0 ? opts.prevLabel : opts.nextLabel) ?? defaultLabel(dir) });
    b.innerHTML = CHEVRON(dir < 0 ? 'M14.5 5.5 8 12l6.5 6.5' : 'M9.5 5.5 16 12l-6.5 6.5');
    b.addEventListener('click', () => track.scrollBy({ left: dir * Math.max(80, track.clientWidth * 0.8), behavior: 'smooth' }), sig);
    // never start a drag / text selection from an arrow
    b.addEventListener('pointerdown', (e) => e.stopPropagation(), sig);
    return b;
  };
  if (wrap !== track) wrap.append(arrow(-1), arrow(1));

  // ── keyboard ──
  if (opts.keyboard !== false) {
    track.addEventListener(
      'keydown',
      (e) => {
        if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
        const items = Array.from(track.children).filter((c): c is HTMLElement => c instanceof HTMLElement && !(c as HTMLButtonElement).disabled && c.offsetParent !== null);
        if (!items.length) return;
        const cur = items.indexOf(document.activeElement as HTMLElement);
        let i: number;
        if (e.key === 'ArrowRight') i = cur < 0 ? 0 : Math.min(items.length - 1, cur + 1);
        else if (e.key === 'ArrowLeft') i = cur < 0 ? 0 : Math.max(0, cur - 1);
        else if (e.key === 'Home') i = 0;
        else if (e.key === 'End') i = items.length - 1;
        else return;
        e.preventDefault();
        if (i === cur) return;
        const it = items[i];
        it.focus({ preventScroll: true });
        if (it.getAttribute('role') === 'radio' && it.getAttribute('aria-checked') !== 'true') it.click();
        // the item may have been re-rendered by its click handler: scroll whatever sits at that index
        const now = (Array.from(track.children)[Array.from(track.children).indexOf(it)] as HTMLElement | undefined) ?? it;
        const left = now.offsetLeft - (track.clientWidth - now.offsetWidth) / 2;
        track.scrollTo({ left: Math.max(0, Math.min(max(), left)), behavior: 'smooth' });
      },
      sig,
    );
  }

  update();
  return () => {
    ac.abort();
    ro.disconnect();
    clearTimeout(freeTimer);
    wrap.querySelectorAll(':scope > .hs-arrow').forEach((b) => b.remove());
  };
}
