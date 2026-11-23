/**
 * The separate rules editor behind Ajustes › Reglas (the + / pencil buttons). Unlike the read-only
 * Reglas tab, everything here is editable: the mode's name, icon, base and rule values. Saving writes
 * a local custom mode and returns to Reglas with it selected.
 */
import type { DominoMode, GameMode, SettingDescriptor, SettingValue } from '../contracts';
import { defaultRulesFor, descriptorsFor, double9Preset, normalizeRules } from '../engine/rules';
import { tileSetOf } from '../engine/tiles';
import { h } from './dom';
import { loc, t } from './i18n';
import { btn, segmented, toggle } from './overlay';
import { screenHeader } from './howto';
import { groupSummary, optionLabel, prettyGroup, row, ruleSelect } from './settings';
import { MODE_ICON_IDS, modeIconSvg } from './modeIcons';

export interface ModeEditorOpts {
  draft: DominoMode;
  isNew: boolean;
  nameFree(name: string): boolean;
  onSave(def: DominoMode): void;
  onDelete?(): void;
  onBack(): void;
}

export function buildModeEditor(o: ModeEditorOpts): HTMLElement {
  let def: DominoMode = structuredClone(o.draft);
  const name = h('input.text-input.mode-ed-name', {
    type: 'text',
    maxlength: 24,
    value: def.name.es,
    placeholder: t('modes.namePh'),
    autocomplete: 'off',
    enterkeyhint: 'done',
    'aria-label': t('modes.name'),
  }) as HTMLInputElement;
  const err = h('p.mode-ed-err', { 'aria-live': 'polite' });

  const nameCard = h(
    'section.card.set-card.mode-ed-card',
    h('h3.me-h', t('modes.name')),
    name,
    err,
    h('h3.me-h', t('modes.icon')),
    h('div.mode-ed-icons', { role: 'radiogroup', 'aria-label': t('modes.icon') }),
  );
  const icons = nameCard.querySelector('.mode-ed-icons') as HTMLElement;
  const paintIcons = () => {
    icons.replaceChildren(
      ...MODE_ICON_IDS.map((id) => {
        const b = h('button.mode-ed-icon', {
          type: 'button',
          role: 'radio',
          'aria-checked': String(def.icon === id),
          'aria-label': id,
          title: id,
          html: modeIconSvg(id),
        });
        b.addEventListener('click', () => {
          def = { ...def, icon: id };
          paintIcons();
        });
        return b;
      }),
    );
  };
  paintIcons();

  const baseCard = h('section.card.set-card.mode-ed-card');
  const paintBase = () => {
    baseCard.replaceChildren(
      h('h3.me-h', t('modes.base')),
      segmented<GameMode>(
        (['pairs', 'individual'] as GameMode[]).map((m) => ({ value: m, label: t(`mode.${m}` as 'mode.pairs' | 'mode.individual') })),
        def.base,
        (v) => {
          // the two bases have different rule lists: start from the new base's defaults
          def = { ...def, base: v, rules: { ...defaultRulesFor(v) } };
          paintBase();
          paintRules();
        },
        t('modes.base'),
      ),
    );
  };

  const rulesCard = h('section.card.set-card.mode-ed-card');
  const paintRules = () => {
    const descriptors = descriptorsFor(def.base);
    const groups = new Map<string, SettingDescriptor[]>();
    for (const d of descriptors) {
      if (!groups.has(d.group)) groups.set(d.group, []);
      groups.get(d.group)!.push(d);
    }
    const setRule = (k: string, v: SettingValue) => {
      def = { ...def, rules: { ...def.rules, [k]: v } };
      paintRules();
    };
    const cards = [...groups].map(([g, list]) => {
      const rows = list.map((d) => {
        const val = def.rules[d.key] ?? d.default;
        const many = d.type === 'select' && (d.options?.length ?? 0) > 2;
        const ctl =
          d.type === 'toggle'
            ? toggle(Boolean(val), (v) => setRule(d.key, v), loc(d.label))
            : many
              ? ruleSelect(
                  (d.options ?? []).map((op) => ({ label: optionLabel(d, op, def.rules), on: op.value === val, pick: () => setRule(d.key, op.value) })),
                  loc(d.label),
                  'soft',
                )
              : segmented(
                  (d.options ?? []).map((op) => ({ value: op.value, label: optionLabel(d, op, def.rules) })),
                  val,
                  (v) => setRule(d.key, v),
                  loc(d.label),
                );
        const longOpts = d.type === 'select' && !many && (d.options ?? []).some((op) => optionLabel(d, op, def.rules).length > 9);
        return row(loc(d.label), ctl, d.help ? loc(d.help) : undefined, longOpts);
      });
      return h('section.card.rule-group-card.open', h('div.rg-head.rule-group-head', h('span.rg-text', h('span.rg-title', prettyGroup(g)), h('span.rg-sum', groupSummary(list, def.rules)))), h('div.rg-body', ...rows));
    });
    // one tap to the Cuban double-nine set (55 tiles, 10 each, played to 100) — the set selector itself
    // stays in the generic group above; this is just a shortcut. Hidden once the draft is double-nine.
    const d9 = tileSetOf(def.rules) === 'double9' ? null : btn(t('modes.applyDouble9'), () => {
      def = { ...def, rules: normalizeRules(double9Preset(def.base).rules, def.base) };
      paintRules();
    }, 'secondary modes-d9-btn');
    rulesCard.replaceChildren(h('h3.me-h', t('modes.secRules')), ...(d9 ? [d9] : []), ...cards);
  };
  paintBase();
  paintRules();

  const save = () => {
    const n = name.value.trim().slice(0, 24);
    if (!n) {
      err.textContent = t('modes.nameEmpty');
      name.focus();
      return;
    }
    if (!o.nameFree(n)) {
      err.textContent = t('modes.nameTaken');
      name.focus();
      return;
    }
    o.onSave({ ...def, name: { es: n, en: n } });
  };
  name.addEventListener('input', () => (err.textContent = ''));
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
  });

  const foot = h('div.mode-ed-foot');
  if (!o.isNew && o.onDelete) foot.append(btn(t('modes.delete'), () => o.onDelete?.(), 'danger mode-ed-delete'));
  foot.append(btn(t('common.cancel'), o.onBack, 'ghost'), btn(t('modes.save'), save, 'primary'));

  return h(
    'section.screen.panel-screen.mode-editor',
    screenHeader(t(o.isNew ? 'modes.new' : 'modes.edit'), o.onBack),
    h('div.scroll.mode-ed-scroll', h('div.content.mode-ed-body', nameCard, baseCard, rulesCard)),
    foot,
  );
}
