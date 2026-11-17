import type { AppSettings, RulePreset, RuleSettings, SettingDescriptor, SettingValue, TableStyle, TileBack, TileTheme } from '../contracts';
import { TABLE_STYLES, TILE_BACKS } from '../contracts';
import { tableThumb, tileBackThumb } from '../render';
import { h } from './dom';
import { loc, t, tMaybe, type Key } from './i18n';
import { segmented, toggle } from './overlay';
import { screenHeader } from './howto';
import { FACE_COUNT, staticFace } from './avatars';
import { tileSvg } from './tiles';
import { enhanceHScroll } from './hscroll';

export type SettingsTab = 'game' | 'rules' | 'av';
const TABS: SettingsTab[] = ['game', 'rules', 'av'];

export interface SettingsOpts {
  settings: AppSettings;
  ruleDescriptors: SettingDescriptor[];
  defaultRules: AppSettings['rules'];
  /** named rule sets; the first is the classic one ("Cubano clásico") */
  presets: RulePreset[];
  matchInProgress: boolean;
  confirm(o: { title: string; body: string; ok: string; cancel: string; danger?: boolean }): Promise<boolean>;
  /** called with the full new settings object after every change */
  onChange(next: AppSettings, key: keyof AppSettings): void;
  onBack(): void;
}

// ───────────────────────── small pieces ─────────────────────────

let rowSeq = 0;

/** a settings row; `help` sits behind a small ⓘ button (shown on demand) */
function row(label: string, control: Node, help?: string, stack = false): HTMLElement {
  const helpId = `set-help-${++rowSeq}`;
  const helpEl = help ? h('div.set-help', { id: helpId, hidden: true }, help) : null;
  let info: HTMLButtonElement | null = null;
  if (help) {
    info = h('button.info-btn', { type: 'button', 'aria-expanded': 'false', 'aria-controls': helpId, 'aria-label': `${t('settings.info')}: ${label}`, title: t('settings.info') }, 'i');
    info.addEventListener('click', () => {
      const open = info!.getAttribute('aria-expanded') !== 'true';
      info!.setAttribute('aria-expanded', String(open));
      helpEl!.hidden = !open;
    });
  }
  return h(
    'div.set-row',
    { class: stack ? 'stack' : '' },
    h('div.set-text', h('div.set-label-line', h('span.set-label', label), info), helpEl),
    h('div.set-ctl', control),
  );
}

/**
 * A single-row horizontal scroller: momentum + scroll-snap, hidden scrollbar, a soft fade on the side
 * that has more content, the selected item scrolled into view when shown; mouse wheel / drag / edge
 * arrows / arrow keys on desktop (enhanceHScroll).
 */
function hscroll(items: HTMLElement[], selected: number, label: string): HTMLElement {
  const track = h('div.hscroll', { role: 'radiogroup', 'aria-label': label });
  track.append(...items);
  const wrap = h('div.hscroll-wrap', track);
  enhanceHScroll(track);
  // once in the document: centre the selected item (horizontal only — no page jump)
  const ro = new ResizeObserver(() => {
    if (!track.isConnected || !track.clientWidth) return;
    const it = items[selected];
    if (it && !track.dataset.placed) {
      track.dataset.placed = '1';
      track.scrollLeft = Math.max(0, it.offsetLeft - (track.clientWidth - it.offsetWidth) / 2);
      ro.disconnect();
    }
  });
  ro.observe(track);
  return wrap;
}

/** radio items for a horizontal scroller; the chosen one is ringed */
function radioItems<T>(values: T[], value: T, make: (v: T, on: boolean) => Node[], aria: (v: T) => string, onChange: (v: T) => void, cls: string): HTMLButtonElement[] {
  const items: HTMLButtonElement[] = values.map((v) => {
    const b = h('button', { type: 'button', class: cls, role: 'radio', 'aria-checked': String(v === value), 'aria-label': aria(v), title: aria(v) });
    b.append(...make(v, v === value));
    b.addEventListener('click', () => {
      if (v === value) return;
      const prev = values.indexOf(value);
      value = v;
      items[prev].setAttribute('aria-checked', 'false');
      items[prev].replaceChildren(...make(values[prev], false));
      b.setAttribute('aria-checked', 'true');
      b.replaceChildren(...make(v, true));
      onChange(v);
    });
    return b;
  });
  return items;
}

/** the human's face: the seven faces at full size in a scrollable row; a tap picks and the face smiles */
function facePicker(value: number, onChange: (v: number) => void): HTMLElement {
  const faces = Array.from({ length: FACE_COUNT }, (_, i) => i);
  const items = radioItems(faces, value, (i, on) => [h('span.face-static', staticFace(i, on ? 'happy' : 'idle'))], (i) => t(`settings.face.${i}` as Key), onChange, 'face-opt');
  return hscroll(items, value, t('settings.avatarFace'));
}

const dpr = () => Math.min(2, window.devicePixelRatio || 1);

function swatchPicker<T extends string>(values: T[], value: T, thumb: (v: T) => string, name: (v: T) => string, label: string, onChange: (v: T) => void, kind: string): HTMLElement {
  const items = radioItems(
    values,
    value,
    (v) => [h('img.swatch-img', { src: thumb(v), alt: '', draggable: 'false' }), h('span.swatch-name', name(v))],
    name,
    onChange,
    `swatch ${kind}`,
  );
  return hscroll(items, values.indexOf(value), label);
}

/** ficha faces: a small live tile in each theme */
function tileThemePicker(value: TileTheme, onChange: (v: TileTheme) => void): HTMLElement {
  const values: TileTheme[] = ['classic', 'dark'];
  const name = (v: TileTheme) => t(`settings.tileTheme.${v}` as Key);
  const items = radioItems(values, value, (v) => [h('span.swatch-tile', { html: tileSvg(1, 5, { size: 30, theme: v }) }), h('span.swatch-name', name(v))], name, onChange, 'swatch tiles');
  return hscroll(items, values.indexOf(value), t('settings.tileTheme'));
}

/** tab icons (inline, currentColor) */
const TAB_ICONS: Record<SettingsTab, string> = {
  // a domino standing on end
  game: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="6.5" y="2.5" width="11" height="19" rx="2.6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8.6 12h6.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="7.2" r="1.5" fill="currentColor"/><circle cx="9.9" cy="15.3" r="1.25" fill="currentColor"/><circle cx="14.1" cy="18" r="1.25" fill="currentColor"/></svg>',
  // a checklist
  rules: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="4" y="2.5" width="16" height="19" rx="2.6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7.4 8.2l1.5 1.5 2.6-2.8M7.4 14.6l1.5 1.5 2.6-2.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M13.6 8.6h3.4M13.6 15h3.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  // sliders
  av: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 6.5h16M4 12h16M4 17.5h16" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".55"/><circle cx="9" cy="6.5" r="2.4" fill="currentColor"/><circle cx="15.5" cy="12" r="2.4" fill="currentColor"/><circle cx="7.5" cy="17.5" r="2.4" fill="currentColor"/></svg>',
};

function prettyGroup(g: string): string {
  return tMaybe(`rulesGroup.${g}`) ?? g.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

// ───────────────────────── rules helpers (generic over descriptors) ─────────────────────────

/** the value a scaled option shows / uses (×factor when the scale condition holds) */
function shownValue(d: SettingDescriptor, v: SettingValue, rules: RuleSettings): SettingValue {
  if (d.scale && typeof v === 'number' && rules[d.scale.key] === d.scale.when) return v * d.scale.factor;
  return v;
}

function optionLabel(d: SettingDescriptor, o: NonNullable<SettingDescriptor['options']>[number], rules: RuleSettings, short = false): string {
  const raw = loc(short ? (o.short ?? o.label) : o.label);
  return raw.split('{n}').join(String(shownValue(d, o.value, rules)));
}

const isOff = (v: SettingValue) => v === 0 || v === 'off' || v === false;

/** one-line summary of a rule group's current values */
function groupSummary(list: SettingDescriptor[], rules: RuleSettings): string {
  const parts: string[] = [];
  for (const d of list) {
    const v = rules[d.key] ?? d.default;
    const name = loc(d.short ?? d.label);
    if (d.type === 'toggle') {
      if (v === true) parts.push(name);
      continue;
    }
    const o = d.options?.find((x) => x.value === v);
    if (!o) continue;
    if (isOff(v) && d.group === 'bonos') continue;
    const txt = optionLabel(d, o, rules, true);
    // numeric-looking short labels ("20", "+2", "×2") need the rule's name in front
    parts.push(/^[\d+×]/.test(txt) ? `${name} ${txt}` : txt);
  }
  const out = parts.length ? parts.join(' · ') : t('common.off');
  return out.charAt(0).toUpperCase() + out.slice(1);
}

function sameAs(rules: RuleSettings, preset: RuleSettings, descriptors: SettingDescriptor[]): boolean {
  return descriptors.every((d) => (rules[d.key] ?? d.default) === (preset[d.key] ?? d.default));
}

/** name of the preset these rules match, or "Personalizado" */
export function presetName(presets: RulePreset[], rules: RuleSettings): string {
  const p = presets.find((x) => Object.keys(x.rules).every((k) => x.rules[k] === rules[k]));
  return p ? loc(p.label) : t('settings.preset.custom');
}

// ───────────────────────── screen ─────────────────────────

export function buildSettings(o: SettingsOpts): HTMLElement {
  let s: AppSettings = structuredClone(o.settings);
  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) => {
    s = { ...s, [k]: v };
    o.onChange(s, k);
  };
  const seg = <K extends 'language' | 'quality' | 'animationSpeed'>(k: K, values: AppSettings[K][], labelKey: (v: AppSettings[K]) => string) =>
    segmented(
      values.map((v) => ({ value: v, label: labelKey(v) })),
      s[k],
      (v) => set(k, v),
      t(`settings.${k}` as Key),
    );

  const name = h('input.text-input', {
    type: 'text',
    maxlength: 14,
    value: s.playerName,
    placeholder: t('seat.you'),
    autocomplete: 'off',
    enterkeyhint: 'done',
    'aria-label': t('settings.name'),
  });
  name.addEventListener('change', () => set('playerName', name.value.trim().slice(0, 14)));
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') name.blur();
  });

  // ── Juego ──
  const tabGame = () =>
    h(
      'div.set-tab-body',
      h(
        'section.card.set-card',
        row(t('settings.name'), name),
        row(t('settings.avatarFace'), facePicker(s.avatarFace ?? 0, (v) => set('avatarFace', v)), undefined, true),
        row(t('settings.tileTheme'), tileThemePicker(s.tileTheme ?? 'dark', (v) => set('tileTheme', v)), undefined, true),
        row(
          t('settings.tileBack'),
          swatchPicker<TileBack>(TILE_BACKS, s.tileBack ?? 'ornate', (v) => tileBackThumb(v, Math.round(34 * dpr()), Math.round(62 * dpr())), (v) => t(`settings.back.${v}` as Key), t('settings.tileBack'), (v) => set('tileBack', v), 'back'),
          undefined,
          true,
        ),
        row(
          t('settings.tableStyle'),
          swatchPicker<TableStyle>(TABLE_STYLES, s.tableStyle ?? 'green', (v) => tableThumb(v, Math.round(84 * dpr()), Math.round(58 * dpr())), (v) => t(`settings.table.${v}` as Key), t('settings.tableStyle'), (v) => set('tableStyle', v), 'table'),
          undefined,
          true,
        ),
      ),
      h(
        'section.card.set-card',
        row(t('settings.language'), seg('language', ['es', 'en'], (v) => (v === 'es' ? 'Español' : 'English'))),
      ),
    );

  // ── Imagen y sonido ──
  const tabAv = () =>
    h(
      'div.set-tab-body',
      h(
        'section.card.set-card',
        row(t('settings.quality'), seg('quality', ['low', 'medium', 'high'], (v) => t(`settings.quality.${v}` as Key)), undefined, true),
        row(t('settings.reducedMotion'), toggle(!!s.reducedMotion, (v) => set('reducedMotion', v), t('settings.reducedMotion'))),
        row(t('settings.avatars'), toggle(s.avatars !== false, (v) => set('avatars', v), t('settings.avatars'))),
        row(t('settings.animationSpeed'), seg('animationSpeed', ['normal', 'fast'], (v) => t(`settings.animationSpeed.${v}` as Key))),
      ),
      h(
        'section.card.set-card',
        row(t('settings.sound'), toggle(s.sound, (v) => set('sound', v), t('settings.sound'))),
        row(t('settings.music'), toggle(s.music, (v) => set('music', v), t('settings.music'))),
        'vibrate' in navigator ? row(t('settings.vibration'), toggle(s.vibration, (v) => set('vibration', v), t('settings.vibration'))) : null,
      ),
    );

  // ── Reglas: presets + collapsible groups, rendered generically from engine descriptors ──
  let openGroup: string | null = null;
  const rulesWrap = h('div.set-tab-body');
  const groups = new Map<string, SettingDescriptor[]>();
  for (const d of o.ruleDescriptors) {
    if (!groups.has(d.group)) groups.set(d.group, []);
    groups.get(d.group)!.push(d);
  }
  const classic = o.presets[0] ?? { id: 'default', label: { es: 'Cubano clásico', en: 'Classic Cuban' }, rules: o.defaultRules };
  const renderRules = () => {
    const isClassic = sameAs(s.rules, classic.rules, o.ruleDescriptors);
    const setRule = (key: string, v: SettingValue) => {
      set('rules', { ...s.rules, [key]: v });
      renderRules();
    };
    const presetBtn = (label: string, on: boolean, onClick?: () => void) => {
      const b = h('button.preset-chip', { type: 'button', 'aria-pressed': String(on), disabled: !onClick && !on ? true : undefined }, label);
      if (onClick) b.addEventListener('click', onClick);
      return b;
    };
    const restore = async () => {
      if (isClassic) return;
      if (o.matchInProgress) {
        const ok = await o.confirm({
          title: t('settings.presetConfirmTitle', { name: loc(classic.label) }),
          body: t('settings.presetConfirmBody'),
          ok: t('settings.presetConfirmOk'),
          cancel: t('common.cancel'),
        });
        if (!ok) return;
      }
      set('rules', { ...classic.rules });
      renderRules();
    };
    const presets = h(
      'div.presets',
      { role: 'group', 'aria-label': t('settings.preset') },
      presetBtn(loc(classic.label), isClassic, isClassic ? undefined : () => void restore()),
      presetBtn(t('settings.preset.custom'), !isClassic),
    );

    const groupEls = [...groups].map(([g, list]) => {
      const open = openGroup === g;
      const bodyId = `rg-${g}`;
      const head = h(
        'button.rg-head',
        { type: 'button', 'aria-expanded': String(open), 'aria-controls': bodyId },
        h('span.rg-text', h('span.rg-title', prettyGroup(g)), h('span.rg-sum', groupSummary(list, s.rules))),
        h('span.rg-chev', { 'aria-hidden': 'true' }),
      );
      head.addEventListener('click', () => {
        openGroup = open ? null : g;
        renderRules();
        if (openGroup) requestAnimationFrame(() => rulesWrap.querySelector(`#${bodyId}`)?.parentElement?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
      });
      const body = h('div.rg-body', { id: bodyId, hidden: !open });
      if (open) {
        for (const d of list) {
          const cur = s.rules[d.key] ?? d.default;
          let ctl: Node;
          if (d.type === 'toggle') ctl = toggle(Boolean(cur), (v) => setRule(d.key, v), loc(d.label));
          else
            ctl = segmented(
              (d.options ?? []).map((op) => ({ value: op.value, label: optionLabel(d, op, s.rules) })),
              cur,
              (v) => setRule(d.key, v),
              loc(d.label),
            );
          const longOpts = d.type === 'select' && ((d.options?.length ?? 0) > 2 || (d.options ?? []).some((op) => optionLabel(d, op, s.rules).length > 9));
          body.append(row(loc(d.label), ctl, d.help ? loc(d.help) : undefined, longOpts));
        }
      }
      return h('section.card.rule-group-card', { class: open ? 'open' : '' }, head, body);
    });

    rulesWrap.replaceChildren(
      h('section.card.set-card.preset-card', h('p.set-help.lead', t('settings.rulesHelp')), presets, o.matchInProgress ? h('p.warn', { role: 'note' }, t('settings.rulesWarn')) : null),
      ...groupEls,
    );
  };
  renderRules();

  // ── tabs ──
  let tab: SettingsTab = TABS.includes(s.settingsTab as SettingsTab) ? (s.settingsTab as SettingsTab) : 'game';
  const panel = h('div.content.set-panel', { role: 'tabpanel' });
  const scroll = h('div.scroll.set-scroll', panel);
  const tabBtns = TABS.map((k) => {
    const b = h(
      'button.set-tab',
      { type: 'button', role: 'tab', id: `set-tab-${k}`, 'aria-selected': String(k === tab), tabindex: k === tab ? 0 : -1 },
      h('span.set-tab-icon', { html: TAB_ICONS[k] }),
      h('span.set-tab-label', t(`settings.tab.${k}` as Key)),
    );
    b.addEventListener('click', () => show(k, true));
    b.addEventListener('keydown', (e) => {
      const i = TABS.indexOf(k);
      const n = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!n) return;
      e.preventDefault();
      const next = TABS[(i + n + TABS.length) % TABS.length];
      show(next, true);
      tabBtns[TABS.indexOf(next)].focus();
    });
    return b;
  });
  const show = (k: SettingsTab, user: boolean) => {
    tab = k;
    tabBtns.forEach((b, i) => {
      b.setAttribute('aria-selected', String(TABS[i] === k));
      b.tabIndex = TABS[i] === k ? 0 : -1;
    });
    panel.setAttribute('aria-labelledby', `set-tab-${k}`);
    panel.replaceChildren(k === 'game' ? tabGame() : k === 'rules' ? rulesWrap : tabAv());
    scroll.scrollTop = 0;
    if (user && s.settingsTab !== k) set('settingsTab', k);
  };
  show(tab, false);

  return h(
    'section.screen.panel-screen.settings',
    screenHeader(t('settings.title'), () => {
      if (name.value.trim() && name.value.trim() !== s.playerName) set('playerName', name.value.trim().slice(0, 14));
      o.onBack();
    }),
    h('div.set-layout', h('nav.set-tabs', { role: 'tablist', 'aria-label': t('settings.tabs') }, ...tabBtns), scroll),
  );
}
