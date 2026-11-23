/**
 * A local game mode, read-only: who plays and which rules are on, as text (no form controls —
 * nothing here looks editable). Used by Ajustes › Reglas; editing happens in the mode editor.
 */
import type { DominoMode, SettingDescriptor, SettingValue } from '../contracts';
import { h } from './dom';
import { loc, t } from './i18n';
import { infoButton, isOff, optionLabel } from './settings';
import { modeIconSvg } from './modeIcons';

const nameLine = (name: string, help: string | null) => h('span.mv-name-line', h('span.mv-name', name), help ? infoButton(name, help) : null);

const textItem = (name: string, value: string, help: string | null = null) => h('div.mv-item.mv-rule', h('span.mv-text', nameLine(name, help), h('span.mv-value', value)));

/** rules that are "on": a false toggle, a zero bonus, or a select reading No/Off is left out */
function onRules(def: DominoMode, descriptors: SettingDescriptor[]): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const d of descriptors) {
    const v = (def.rules[d.key] ?? d.default) as SettingValue;
    if (isOff(v)) continue;
    const op = (d.options ?? []).find((o) => o.value === v);
    const value = d.type === 'toggle' ? t('modes.on') : op ? optionLabel(d, op, def.rules) : String(v);
    out.push(textItem(loc(d.label), value, d.help ? loc(d.help) : null));
  }
  return out;
}

export function modeView(def: DominoMode, descriptors: SettingDescriptor[]): HTMLElement {
  const players = h(
    'div.mv-grid',
    textItem(t('modes.mode'), loc(def.name)),
    textItem(t('modes.players'), def.base === 'pairs' ? t('modes.playersPairs') : t('modes.playersSolo')),
    textItem(t('modes.teams'), def.base === 'pairs' ? t('modes.teamsFixed') : t('modes.teamsSolo')),
  );
  const icon = h('span.mv-mode-icon', { 'aria-hidden': 'true', html: modeIconSvg(def.icon) });

  return h(
    'div.mode-view',
    h('section.card.mv-card', h('h3.mv-h', icon, t('modes.secPlayers')), players),
    h('section.card.mv-card', h('h3.mv-h', t('modes.secRules')), h('div.mv-grid', ...onRules(def, descriptors))),
  );
}

/** the read-only view in a sheet: title, the view, a close button */
export function rulesSheet(def: DominoMode, title: string, descriptors: SettingDescriptor[], onClose: () => void): HTMLElement {
  const close = h('button.btn.primary.mv-close', { type: 'button' }, t('modes.close'));
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' && e.key !== 'GoBack' && e.key !== 'BrowserBack') return;
    e.stopImmediatePropagation();
    e.preventDefault();
    done();
  };
  const done = () => {
    window.removeEventListener('keydown', onKey, true);
    onClose();
  };
  window.addEventListener('keydown', onKey, true);
  close.addEventListener('click', done);
  return h('div.mv-sheet-wrap', h('div.mv-sheet', h('h2.mv-sheet-title', title), h('div.mv-scroll', modeView(def, descriptors)), close));
}
