/**
 * The one game-mode dropdown (Ajustes › Reglas and Nueva partida): the two built-in modes plus the
 * player's own modes, each with its icon. Built on ruleSelect so it looks like every other picker.
 */
import { allModes, isBuiltInMode } from '../app/modes';
import { loc, t } from './i18n';
import { modeIconSvg } from './modeIcons';
import { ruleSelect } from './settings';

export interface ModeChoice {
  id: string;
  label: string;
  icon: string;
  custom: boolean;
}

/** every available mode, built-ins first */
export function modeChoices(): ModeChoice[] {
  return allModes().map((m) => ({ id: m.id, label: loc(m.name), icon: modeIconSvg(m.icon), custom: !isBuiltInMode(m.id) }));
}

export interface ModeSelectOpts {
  /** the selected mode id (a built-in id or a custom mode id) */
  current: string;
  /** shown instead of the mode's own name (e.g. a current rule set) */
  currentLabel?: string;
  onPick(id: string): void;
  disabled?: boolean;
  variant?: 'soft';
}

export function modeSelect(o: ModeSelectOpts): HTMLElement {
  const choices = modeChoices();
  const el = ruleSelect(
    choices.map((c) => ({
      label: c.id === o.current && o.currentLabel ? o.currentLabel : c.label,
      icon: c.icon,
      on: c.id === o.current,
      pick: () => o.onPick(c.id),
    })),
    t('mode.label'),
    o.variant,
  );
  el.classList.add('mode-select');
  if (o.disabled) el.querySelector<HTMLButtonElement>('.rsel-btn')?.setAttribute('disabled', '');
  return el;
}
