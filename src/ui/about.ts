/**
 * "Acerca de": app name + the 1|3 brand tile, version, tagline and the author link (CV).
 * Links open outside the app: target=_blank on the web; inside the Capacitor WebView any navigation to
 * another host is handed to the system browser by the bridge (Bridge.launchIntent), so the game never
 * navigates away.
 */
import { h } from './dom';
import { t } from './i18n';
import { btn } from './overlay';
import { tileSvg } from './tiles';

/** the author's page (one place to change it) */
export const AUTHOR_URL = 'https://rene-guerrero.github.io/cv/';
export const AUTHOR_NAME = 'rene-guerrero';

const extLink = (href: string, label: string) =>
  h('a.about-link', { href, target: '_blank', rel: 'noopener noreferrer' }, label);


export function buildAbout(onClose: () => void): HTMLElement {
  const [before, after = ''] = t('about.madeBy').split('{author}');
  const close = btn(t('about.close'), onClose, 'ghost');
  close.dataset.autofocus = '';
  return h(
    'div.card.about',
    { 'aria-label': t('about.title') },
    h(
      'div.about-head',
      h('div.about-tile', { html: tileSvg(1, 3, { size: 40, theme: 'classic' }) }),
      h('h2.about-name', h('span.ku', 'Ku'), 'dominoes'),
      h('p.about-version', t('about.version', { v: __APP_VERSION__ })),
    ),
    h('p.about-tagline', t('about.tagline')),
    h('p.about-made', before, extLink(AUTHOR_URL, AUTHOR_NAME), after),
    h('div.about-actions', close),
  );
}
