import { h } from './dom';
import { t } from './i18n';
import { canFullscreen, toggleFullscreen } from '../app/fullscreen';
import { btn, ICONS } from './overlay';
import { tileSvg } from './tiles';
import { localPlayAvailable, onlineAvailable, served } from '../net/config';

export interface MenuOpts {
  save: { hand: number; us: number; them: number } | null;
  onPlay(): void;
  onContinue(): void;
  onSettings(): void;
  onHowto(): void;
  onAbout(): void;
  /** "Jugar en línea" */
  onOnline(): void;
  /** "Jugar con amigos" (same Wi-Fi, no internet) */
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

/** Android APK download icon (last in the row) — only on the published web build, never inside the installed app.
 *  Dev: add ?apk=1 to the URL to preview it. */
const DOWNLOAD_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v10.5M7.5 10.5 12 15l4.5-4.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 17.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-1.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
function apkBtn(): HTMLElement | null {
  const native = !!(window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
  const devPreview = import.meta.env.DEV && new URLSearchParams(location.search).has('apk');
  if (native || served() || !(import.meta.env.PROD || devPreview)) return null;
  const label = t('menu.apk');
  const a = h('a.btn.ghost.about-btn.apk-btn', { href: './kudominoes.apk', download: 'kudominoes.apk', 'aria-label': label, title: label }, h('span.about-btn-icon', { html: DOWNLOAD_SVG })) as HTMLAnchorElement;
  return a;
}

const GLOBE =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M3.6 12h16.8M12 3.4c2.4 2.4 3.6 5.3 3.6 8.6s-1.2 6.2-3.6 8.6c-2.4-2.4-3.6-5.3-3.6-8.6s1.2-6.2 3.6-8.6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

/** two people side by side (Jugar con amigos) */
const FRIENDS =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8.6" cy="8.4" r="3.3" fill="none" stroke="currentColor" stroke-width="2.1"/><path d="M2.6 19.4c.5-3.4 2.9-5.4 6-5.4s5.5 2 6 5.4" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/><circle cx="16.4" cy="7.6" r="2.7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16.4 12.9c2.7 0 4.6 1.8 5 4.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

/** square icon-only Acerca de button, last in the Ajustes / Cómo jugar row */
function aboutBtn(onClick: () => void): HTMLButtonElement {
  const label = t('menu.about');
  const b = h('button.btn.ghost.about-btn', { type: 'button', 'aria-label': label, title: label }, h('span.about-btn-icon', { html: ICONS.info }));
  b.addEventListener('click', onClick);
  return b;
}

export function buildMenu(o: MenuOpts): HTMLElement {
  const icon = (svg: string) => h('span.btn-icon', { html: svg });
  const actions = h('div.menu-actions');
  if (o.save) {
    actions.append(
      btn(t('menu.continue'), o.onContinue, 'primary xl', h('span.btn-sub', t('menu.continueSub', o.save))),
      btn(t('menu.play'), o.onPlay, 'secondary lg'),
    );
  } else {
    actions.append(btn(t('menu.play'), o.onPlay, 'primary xl', icon(ICONS.play)));
  }
  // hidden until the room server is deployed and its URL configured (src/net/config.ts)
  // Jugar en línea and Jugar con amigos share one row (whichever this build offers)
  const net = [
    onlineAvailable() ? btn(t('menu.online'), o.onOnline, 'secondary lg menu-online', icon(GLOBE)) : null,
    localPlayAvailable() && o.onFriends ? btn(t('menu.friends'), o.onFriends, 'secondary lg menu-online menu-friends', icon(FRIENDS)) : null,
  ].filter((b): b is HTMLButtonElement => !!b);
  if (net.length === 1) actions.append(net[0]);
  else if (net.length) actions.append(h('div.row.menu-row.menu-net', ...net));
  // one row of equal icon-only buttons: Ajustes, Cómo jugar, Acerca de, fullscreen, download
  const settingsLabel = t('menu.settings');
  const settings = h('button.btn.ghost.about-btn.settings-btn', { type: 'button', 'aria-label': settingsLabel, title: settingsLabel }, h('span.about-btn-icon', { html: ICONS.gear }));
  settings.addEventListener('click', o.onSettings);
  const howtoLabel = t('menu.howto');
  const howto = h('button.btn.ghost.about-btn', { type: 'button', 'aria-label': howtoLabel, title: howtoLabel }, h('span.about-btn-icon', { html: ICONS.book }));
  howto.addEventListener('click', o.onHowto);
  // fullscreen: browsers only (hidden in the Android app and on an iPhone home-screen icon)
  const fsLabel = t('menu.fullscreen');
  const fs = canFullscreen() ? h('button.btn.ghost.about-btn.fs-btn', { type: 'button', 'aria-label': fsLabel, title: fsLabel }, h('span.about-btn-icon', { html: ICONS.fullscreen })) : null;
  fs?.addEventListener('click', () => void toggleFullscreen());
  actions.append(h('div.row.menu-row', settings, howto, aboutBtn(o.onAbout), fs, apkBtn()));
  (actions.firstElementChild as HTMLElement).dataset.autofocus = '';

  // data-attract: the 3D attract scenes play behind this screen and react to taps on its empty area;
  // data-attract-avoid: the scenes stay clear of these blocks (logo, buttons)
  return h(
    'section.screen.menu',
    { 'data-attract': true },
    h('div.menu-hero', { 'data-attract-avoid': true }, logo(), h('p.tagline', t('app.tagline'))),
    h('div.menu-bottom', { 'data-attract-avoid': true }, actions),
  );
}
