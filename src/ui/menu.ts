import { h } from './dom';
import { t } from './i18n';
import { btn, ICONS } from './overlay';
import { tileSvg } from './tiles';
import { localPlayAvailable, onlineAvailable, served } from '../net/config';

export interface MenuOpts {
  /** a saved match to continue (null = none) */
  save: { hand: number; us: number; them: number } | null;
  /** Partida rápida: start right away with the last setup */
  onPlay(): void;
  /** Crear mesa: the full new-game screen */
  onSetup(): void;
  /** the last setup, e.g. "Parejas · Cubano clásico" */
  setupLine: string;
  /** the player's chip: face + name; tapping it opens their profile (Ajustes → Juego) */
  profile: { face: Element; name: string; onOpen(): void };
  onContinue(): void;
  onSettings(): void;
  onHowto(): void;
  /** "Por internet" */
  onOnline(): void;
  /** "Wi-Fi o Bluetooth" (same Wi-Fi or Bluetooth, no internet) */
  onFriends?(): void;
}

/**
 * The brand mark: three fanned fichas with the 1|3 (the red 1) raised in front — the same 1|3 as the app
 * icon and the boot splash. Always the classic ivory tiles, whatever the in-game tile theme.
 */
export function logo(): HTMLElement {
  const o = { size: 34, theme: 'classic' as const };
  return h(
    'div.logo',
    h('div.logo-tiles', {
      html: tileSvg(6, 6, { ...o, cls: 'lt1' }) + tileSvg(3, 5, { ...o, cls: 'lt3' }) + tileSvg(1, 3, { ...o, cls: 'lt2' }),
    }),
    h('h1.logo-word', h('span.ku', 'Ku'), h('span', 'dominoes')),
  );
}

/** Android APK download icon — only on the published web build, never inside the installed app.
 *  Dev: add ?apk=1 to the URL to preview it. */
const DOWNLOAD_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v10.5M7.5 10.5 12 15l4.5-4.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 17.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-1.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
function apkBtn(): HTMLElement | null {
  const native = !!(window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
  const devPreview = import.meta.env.DEV && new URLSearchParams(location.search).has('apk');
  if (native || served() || !(import.meta.env.PROD || devPreview)) return null;
  const label = t('menu.apk');
  return h('a.btn.ghost.about-btn.apk-btn', { href: './kudominoes.apk', download: 'kudominoes.apk', 'aria-label': label, title: label }, h('span.about-btn-icon', { html: DOWNLOAD_SVG }));
}

const GLOBE =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M3.6 12h16.8M12 3.4c2.4 2.4 3.6 5.3 3.6 8.6s-1.2 6.2-3.6 8.6c-2.4-2.4-3.6-5.3-3.6-8.6s1.2-6.2 3.6-8.6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

/** two people side by side (Multijugador, Wi-Fi o Bluetooth) */
const FRIENDS =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8.6" cy="8.4" r="3.3" fill="none" stroke="currentColor" stroke-width="2.1"/><path d="M2.6 19.4c.5-3.4 2.9-5.4 6-5.4s5.5 2 6 5.4" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/><circle cx="16.4" cy="7.6" r="2.7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16.4 12.9c2.7 0 4.6 1.8 5 4.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

/** resume: a play triangle inside a circular arrow (Continuar) */
const RESUME =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.6-5.9" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/><path d="M18.6 2.8v3.9h-3.9" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 8.4v7.2a.6.6 0 0 0 .9.5l5.6-3.6a.6.6 0 0 0 0-1l-5.6-3.6a.6.6 0 0 0-.9.5z" fill="currentColor"/></svg>';

/** sliders: set up a table */
const ADJUST =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/><circle cx="15" cy="7" r="2.3" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="9" cy="17" r="2.3" fill="none" stroke="currentColor" stroke-width="2.2"/></svg>';

function squareBtn(icon: string, label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = h('button.btn.ghost.about-btn', { type: 'button', class: cls, 'aria-label': label, title: label }, h('span.about-btn-icon', { html: icon }));
  b.addEventListener('click', onClick);
  return b;
}

const withSub = (b: HTMLElement, sub: string) => (b.append(h('span.btn-sub', sub)), b);

/** Multijugador: a bottom sheet with the ways this build can play with others (as in KuCards) */
function multiSheet(host: HTMLElement, o: { onOnline?: () => void; onFriends?: () => void }, icon: (svg: string) => HTMLElement): void {
  const close = () => {
    wrap.remove();
    window.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' && e.key !== 'GoBack' && e.key !== 'BrowserBack') return;
    e.stopImmediatePropagation();
    e.preventDefault();
    close();
  };
  const go = (f?: () => void) => () => {
    close();
    f?.();
  };
  const sheet = h(
    'div.menu-sheet',
    { role: 'dialog', 'aria-label': t('menu.multi') },
    h('h2.menu-sheet-title', t('menu.multi')),
    o.onOnline ? withSub(btn(t('menu.viaInternet'), go(o.onOnline), 'primary lg menu-sheet-opt', icon(GLOBE)), t('menu.viaInternetSub')) : null,
    o.onFriends ? withSub(btn(t('menu.viaLocal'), go(o.onFriends), 'secondary lg menu-sheet-opt', icon(FRIENDS)), t('menu.viaLocalSub')) : null,
    btn(t('common.close'), close, 'ghost menu-sheet-close'),
  );
  const wrap = h('div.menu-sheet-wrap', sheet);
  wrap.addEventListener('click', (e) => e.target === wrap && close());
  window.addEventListener('keydown', onKey, true);
  host.append(wrap);
  (sheet.querySelector('.btn') as HTMLElement | null)?.focus();
}

/** a small seeded random, so the drifting tiles keep the same layout from visit to visit */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * The background: ivory fichas drifting slowly up a night-blue ground, turning as they go; far ones are
 * smaller, softer and slower. Each starts part-way through its trip (negative delay) so the screen is full
 * from the first frame. Ajustes → Reducir animaciones leaves them as a still scatter (styles.css).
 */
export const DRIFT_TILES = 28;
function driftLayer(): HTMLElement {
  const rnd = seeded(0x6d1d0);
  const tiles: string[] = [];
  for (let i = 0; i < DRIFT_TILES; i++) {
    const far = i % 3 === 0;
    const a = Math.floor(rnd() * 7);
    const b = Math.floor(rnd() * 7);
    const size = Math.round(far ? 12 + rnd() * 8 : 20 + rnd() * 16);
    const d = Math.round(far ? 70 + rnd() * 30 : 46 + rnd() * 30);
    // lanes spread across the width, jittered, so the tiles never bunch up
    const x = Math.round(((i * 37) % DRIFT_TILES) * (96 / DRIFT_TILES) + rnd() * 3);
    const r0 = Math.round(rnd() * 360 - 180);
    const dx = Math.round(rnd() * 90 - 45);
    const style =
      `--x:${x}%;--d:${d}s;--dl:${-Math.round(rnd() * d)}s;--r0:${r0}deg;--r1:${r0 + (dx > 0 ? 150 : -150)}deg;` +
      `--dx:${dx}px;--o:${(far ? 0.32 + rnd() * 0.14 : 0.5 + rnd() * 0.2).toFixed(2)};--sy:${Math.round(4 + rnd() * 90)}%`;
    tiles.push(tileSvg(a, b, { size, theme: 'classic', cls: far ? 'drift far' : 'drift' }).replace('<svg ', `<svg style="${style}" `));
  }
  return h('div.menu-drift', { 'aria-hidden': 'true', html: tiles.join('') });
}

export function buildMenu(o: MenuOpts): HTMLElement {
  const icon = (svg: string) => h('span.btn-icon', { html: svg });
  const actions = h('div.menu-actions');
  // hidden until the room server is deployed and its URL configured (src/net/config.ts)
  const net = {
    onOnline: onlineAvailable() ? o.onOnline : undefined,
    onFriends: localPlayAvailable() ? o.onFriends : undefined,
  };
  const hasNet = !!(net.onOnline || net.onFriends);
  let el: HTMLElement;
  // tiles: [Continuar] / [▶ Partida rápida · last setup] / [Crear mesa | Multijugador]
  const tile = (cls: string, ic: HTMLElement, label: string, sub: string, onClick: () => void) => {
    const b = h(`button.btn.menu-tile.${cls}`, { type: 'button' }, ic, h('span.menu-tile-text', h('span.menu-tile-label', label), h('span.menu-tile-sub', sub)));
    b.addEventListener('click', onClick);
    return b;
  };
  const tileIcon = (svg: string, cls = '') => h(`span.menu-tile-icon${cls}`, { html: svg, 'aria-hidden': 'true' });
  if (o.save) actions.append(tile('secondary slim', tileIcon(RESUME, '.accent'), t('menu.continue'), t('menu.continueSub', o.save), o.onContinue));
  actions.append(tile('primary wide', tileIcon(ICONS.play, '.disc'), t('menu.quick'), o.setupLine, o.onPlay));
  const setupTile = tile('secondary half', tileIcon(ADJUST, '.accent'), t('menu.table'), t('menu.tableSub'), o.onSetup);
  const sub = net.onOnline && net.onFriends ? t('menu.multiSubBoth') : net.onOnline ? t('menu.viaInternet') : t('menu.viaLocal');
  const multi = hasNet ? tile('secondary half menu-multi', tileIcon(FRIENDS, '.accent'), t('menu.multi'), sub, () => multiSheet(el, net, icon)) : null;
  actions.append(h('div.menu-tile-row', setupTile, multi));
  (actions.querySelector('button.btn') as HTMLElement).dataset.autofocus = '';

  const chip = h('button.menu-profile', { type: 'button', 'aria-label': t('menu.profile'), title: t('menu.profile') }, h('span.menu-profile-face', o.profile.face), h('span.menu-profile-name', o.profile.name));
  chip.addEventListener('click', o.profile.onOpen);
  const top = h(
    'div.menu-top',
    chip,
    h(
      'div.menu-top-icons',
      apkBtn(),
      squareBtn(ICONS.book, t('menu.howto'), o.onHowto),
      squareBtn(ICONS.gear, t('menu.settings'), o.onSettings, 'settings-btn'),
    ),
  );

  // data-attract="off": the menu has an opaque background of its own, so the 3D attract scenes behind it
  // stay parked (render/tableView.ts) instead of drawing under it
  el = h(
    'section.screen.menu',
    { 'data-attract': 'off' },
    driftLayer(),
    top,
    h('div.menu-hero', logo(), h('p.tagline', t('app.tagline'))),
    h('div.menu-bottom', actions),
  );
  return el;
}
