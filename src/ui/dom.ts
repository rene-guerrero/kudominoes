type Attrs = Record<string, string | number | boolean | EventListener | undefined | null>;
type Child = Node | string | number | null | undefined | false;

/** Tiny hyperscript: h('button.btn.primary', {onclick}, 'Jugar') */
export function h<K extends keyof HTMLElementTagNameMap>(sel: K | `${K}.${string}` | `${K}#${string}`, attrs?: Attrs | Child, ...children: Child[]): HTMLElementTagNameMap[K] {
  const [tagAndId, ...classes] = sel.split('.');
  const [tag, id] = tagAndId.split('#');
  const el = document.createElement(tag as K);
  if (id) el.id = id;
  if (classes.length) el.className = classes.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node)) {
    children.unshift(attrs as Child);
  } else if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
      else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
      else if (k === 'html') el.innerHTML = String(v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export function svgEl(markup: string): SVGSVGElement {
  const tpl = document.createElement('template');
  tpl.innerHTML = markup.trim();
  return tpl.content.firstElementChild as SVGSVGElement;
}

export const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/**
 * Reduced motion is an explicit in-app setting (Ajustes → Reducir animaciones). The OS-level
 * prefers-reduced-motion flag is NOT applied automatically: on many Windows/Android setups it is on
 * by default and silently flattened every game animation.
 */
let reducedMotionPref = false;
export function setReducedMotionPref(v: boolean): void {
  reducedMotionPref = v;
  document.documentElement.classList.toggle('reduce-motion', v);
}
export const prefersReducedMotion = () => reducedMotionPref;

/**
 * The effective graphics level, as `<html data-quality>`: on 'low' the stylesheet drops costly
 * decoration (big blurred shadows, blur filters, looping glows) and shortens decorative transitions.
 * Independent of the reduced-motion setting.
 */
export function setUiQuality(q: 'low' | 'medium' | 'high'): void {
  document.documentElement.dataset.quality = q;
}

/** Animate a number in a text node with requestAnimationFrame (text-only DOM writes). */
export function countUp(el: Element, from: number, to: number, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || from === to || prefersReducedMotion()) {
      el.textContent = String(to);
      return resolve();
    }
    const t0 = performance.now();
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      el.textContent = String(Math.round(from + (to - from) * e));
      if (k < 1) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
}
