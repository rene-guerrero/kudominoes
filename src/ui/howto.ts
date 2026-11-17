import { h } from './dom';
import { getLang, HOWTO, t } from './i18n';
import { iconBtn, ICONS } from './overlay';
import { tileSvg } from './tiles';

export function screenHeader(title: string, onBack: () => void): HTMLElement {
  return h('header.screen-head', iconBtn(ICONS.back, t('common.back'), onBack, 'back'), h('h2', title));
}

export function buildHowto(onBack: () => void): HTMLElement {
  const sections = HOWTO[getLang()].map((s, i) =>
    h(
      'article.card.howto-sec',
      { style: `--i:${i}` },
      h('h3', s.title),
      ...s.body.map((p) => h('p', p)),
      s.terms ? h('dl.terms', ...s.terms.flatMap(([k, v]) => [h('dt', k), h('dd', v)])) : null,
    ),
  );
  const demo = h('div.howto-demo', {
    html:
      tileSvg(5, 6, { size: 22, horizontal: true }) +
      tileSvg(6, 6, { size: 22 }) +
      tileSvg(6, 2, { size: 22, horizontal: true }) +
      '<span class="demo-arrow">←</span>' +
      tileSvg(2, 4, { size: 22, horizontal: true, cls: 'demo-next' }),
  });
  return h(
    'section.screen.panel-screen.howto',
    screenHeader(t('menu.howto'), onBack),
    h('div.scroll', h('div.content', demo, ...sections)),
  );
}
