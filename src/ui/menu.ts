import { h } from './dom';
import { t } from './i18n';
import { btn, ICONS } from './overlay';
import { tileSvg } from './tiles';

export interface MenuOpts {
  save: { hand: number; us: number; them: number } | null;
  onPlay(): void;
  onContinue(): void;
  onSettings(): void;
  onHowto(): void;
}

export function logo(): HTMLElement {
  return h(
    'div.logo',
    h('div.logo-tiles', {
      html: tileSvg(6, 6, { size: 34, cls: 'lt1' }) + tileSvg(6, 3, { size: 34, cls: 'lt2' }) + tileSvg(3, 1, { size: 34, cls: 'lt3' }),
    }),
    h('h1.logo-word', h('span.ku', 'Ku'), h('span', 'dominoes')),
  );
}

/** Android APK download — only on the published web build, never inside the installed app. */
function apkLink(): HTMLElement | string {
  const native = !!(window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
  if (!import.meta.env.PROD || native) return '';
  const a = h('a.apk-link', t('menu.apk')) as HTMLAnchorElement;
  a.href = './kudominoes.apk';
  a.download = 'kudominoes.apk';
  return a;
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
  const settings = btn(t('menu.settings'), o.onSettings, 'ghost', icon(ICONS.gear));
  const howto = btn(t('menu.howto'), o.onHowto, 'ghost', icon(ICONS.book));
  actions.append(h('div.row', settings, howto));
  (actions.firstElementChild as HTMLElement).dataset.autofocus = '';

  return h(
    'section.screen.menu',
    h('div.menu-hero', logo(), h('p.tagline', t('app.tagline'))),
    h('div.menu-bottom', actions, apkLink(), h('p.menu-foot', t('menu.offline'))),
  );
}
