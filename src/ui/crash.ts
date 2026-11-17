import { h } from './dom';
import { t } from './i18n';
import { btn, ICONS } from './overlay';

/**
 * The friendly error card: an unexpected error stopped the game. "Volver al menú" and, collapsed under
 * "Detalles", the error text (message + stack) so it can be screenshotted from a phone.
 */
export function buildCrash(o: { details: string; onMenu(): void }): HTMLElement {
  const menu = btn(t('crash.menu'), o.onMenu, 'primary lg', h('span.btn-icon', { html: ICONS.home }));
  menu.dataset.autofocus = '';
  const pre = h('pre.crash-pre', o.details);
  return h(
    'div.card.crash',
    h('h2.card-title', t('crash.title')),
    h('p.crash-body', t('crash.body')),
    h('div.stack', menu),
    h('details.crash-details', h('summary', t('crash.details')), pre),
  );
}
