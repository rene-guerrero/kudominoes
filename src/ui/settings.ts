import type { AppSettings, DominoMode, GameMode, RulePreset, RuleSettings, SettingDescriptor, SettingValue, TableStyle, TileBack, TileTheme } from '../contracts';
import { TABLE_STYLES, TILE_BACKS } from '../contracts';
import { tableThumb, tileBackThumb } from '../render';
import { deleteCustomMode, draftFrom, isBuiltInMode, modeDef } from '../app/modes';
import { defaultRulesFor } from '../engine/rules';
import { h } from './dom';
import { loc, t, tMaybe, type Key } from './i18n';
import { ICONS, segmented, toggle } from './overlay';
import { screenHeader } from './howto';
import { createAvatarEditor, type FaceSpec } from 'kuavatars';
import { tileSvg } from './tiles';
import { enhanceHScroll } from './hscroll';
import { gestureLabel, MAX_GESTURES, sanitizeGestures } from './chat';
import { staticFace } from './avatars';
import { CHAT_GESTURES, type ChatGesture } from '../net/protocol';
import { canFullscreen, toggleFullscreen } from '../app/fullscreen';
import { modeSelect } from './modeSelect';
import { modeView } from './modeView';

export type SettingsTab = 'game' | 'rules' | 'av';
const ALL_TABS: SettingsTab[] = ['game', 'av', 'rules'];

export interface SettingsOpts {
  settings: AppSettings;
  ruleDescriptors: SettingDescriptor[];
  defaultRules: AppSettings['rules'];
  /** individual mode's rule descriptors / defaults (when present, Reglas gets a Parejas | Individual switch) */
  ruleDescriptorsIndividual?: SettingDescriptor[];
  defaultRulesIndividual?: RuleSettings;
  /** named rule sets; the first of each mode is its classic one ("Cubano clásico") */
  presets: RulePreset[];
  /** opens the separate editor for a new mode (plus) or an existing custom one (pencil) */
  editMode?(draft: DominoMode, isNew: boolean): void;
  /** opened from inside a game: the name and avatar can't change (a note replaces them), and no Reglas tab */
  profileLocked?: boolean;
  confirm(o: { title: string; body: string; ok: string; cancel: string; danger?: boolean }): Promise<boolean>;
  /** called with the full new settings object after every change */
  onChange(next: AppSettings, key: keyof AppSettings): void;
  onBack(): void;
  /** the level auto quality runs at right now (read after a change, for the "ahora:" line) */
  resolvedQuality?(): AppSettings['quality'];
  /** opens the Acerca de card (a row at the bottom of the Juego tab) */
  onAbout?(): void;
}

// ───────────────────────── small pieces ─────────────────────────

let rowSeq = 0;

/** the little ⓘ button used by rows and the read-only mode view */
export function infoButton(label: string, help: string): HTMLButtonElement {
  const b = h('button.info-btn', { type: 'button', 'aria-expanded': 'false', 'aria-label': `${t('settings.info')}: ${label}`, title: t('settings.info') }, 'i');
  b.addEventListener('click', () => toggleTip(b, help));
  return b;
}

/** a settings row; `help` sits behind a small ⓘ button (shown on demand) */
export function row(label: string, control: Node, help?: string, stack = false): HTMLElement {
  const info = help ? infoButton(label, help) : null;
  return h(
    'div.set-row',
    { class: stack ? 'stack' : '' },
    h('div.set-text', h('div.set-label-line', h('span.set-label', label), info)),
    h('div.set-ctl', control),
  );
}

// ── rule explanation tooltip: one floating bubble, opened by tapping ⓘ ──
let tipEl: HTMLElement | null = null;
let tipFor: HTMLElement | null = null;
const tipOff = (e: Event) => {
  if (e.type === 'keydown' && (e as KeyboardEvent).key !== 'Escape') return;
  if (e.type === 'pointerdown' && (tipEl?.contains(e.target as Node) || tipFor?.contains(e.target as Node))) return;
  closeTip();
};
function closeTip(): void {
  tipFor?.setAttribute('aria-expanded', 'false');
  tipEl?.remove();
  tipEl = tipFor = null;
  document.removeEventListener('pointerdown', tipOff, true);
  document.removeEventListener('keydown', tipOff, true);
  document.removeEventListener('scroll', tipOff, true);
  window.removeEventListener('resize', tipOff);
}
function toggleTip(anchor: HTMLElement, text: string): void {
  if (tipFor === anchor) return closeTip();
  closeTip();
  const id = `tip-${++rowSeq}`;
  const el = h('div.tip', { id, role: 'tooltip' }, h('div.tip-text', text), h('div.tip-arrow'));
  document.body.append(el);
  anchor.setAttribute('aria-expanded', 'true');
  anchor.setAttribute('aria-describedby', id);
  // above the ⓘ when it fits, else below; kept inside the screen with a 12px margin
  const a = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const hgt = el.offsetHeight;
  const cx = a.left + a.width / 2;
  const left = Math.max(12, Math.min(innerWidth - w - 12, cx - w / 2));
  const above = a.top - hgt - 10 > 12;
  el.style.left = `${left}px`;
  el.style.top = `${above ? a.top - hgt - 4 : a.bottom + 4}px`;
  el.classList.add(above ? 'above' : 'below');
  el.style.setProperty('--ax', `${cx - left}px`);
  tipEl = el;
  tipFor = anchor;
  document.addEventListener('pointerdown', tipOff, true);
  document.addEventListener('keydown', tipOff, true);
  document.addEventListener('scroll', tipOff, true);
  window.addEventListener('resize', tipOff);
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

/** the human's face: the shared KuAvatars editor (every option is a thumbnail of the player's own face) */
function faceEditor(value: number | FaceSpec, onChange: (v: FaceSpec) => void): HTMLElement {
  const box = h('div.face-editor');
  createAvatarEditor(box, { value, onChange, moods: false, gestures: false });
  return box;
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

export function prettyGroup(g: string): string {
  return tMaybe(`rulesGroup.${g}`) ?? g.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

// ───────────────────────── rules helpers (generic over descriptors) ─────────────────────────

/** the value a scaled option shows / uses (×factor when the scale condition holds) */
function shownValue(d: SettingDescriptor, v: SettingValue, rules: RuleSettings): SettingValue {
  if (d.scale && typeof v === 'number' && rules[d.scale.key] === d.scale.when) return v * d.scale.factor;
  return v;
}

export function optionLabel(d: SettingDescriptor, o: NonNullable<SettingDescriptor['options']>[number], rules: RuleSettings, short = false): string {
  const raw = loc(short ? (o.short ?? o.label) : o.label);
  // singular after a 1 ("+1 punto", "1 point")
  return raw
    .split('{n}')
    .join(String(shownValue(d, o.value, rules)))
    .replace(/(^|[^\d.,])1 puntos(?!\w)/g, '$11 punto')
    .replace(/(^|[^\d.,])1 points(?!\w)/g, '$11 point');
}

export const isOff = (v: SettingValue) => v === 0 || v === 'off' || v === false;

/** one-line summary of a rule group's current values */
export function groupSummary(list: SettingDescriptor[], rules: RuleSettings): string {
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

/** name of the preset (of that mode) these rules match, or "Personalizado" */
export function presetName(presets: RulePreset[], rules: RuleSettings, mode: GameMode = 'pairs'): string {
  const p = presets.find((x) => (x.mode ?? 'pairs') === mode && Object.keys(x.rules).every((k) => x.rules[k] === rules[k]));
  return p ? loc(p.label) : t('settings.preset.custom');
}

export interface RuleSelectItem {
  label: string;
  on: boolean;
  /** "Personalizado": shown as the current value, not pickable */
  custom?: boolean;
  /** pick() runs even when this item is already selected (e.g. Automática re-detects) */
  repick?: boolean;
  /** an inline SVG shown before the label (game-mode icons) */
  icon?: string;
  pick?: () => void;
}

/** the rule-set dropdown: a wood-and-cream button that opens a list (game-styled, not the native select) */
const PLUS_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>';
const PENCIL_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19.5 8.5a2.8 2.8 0 0 0-4-4L4 16z M13.5 6.5l4 4" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const TRASH_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 7h15M9.5 7V4.8h5V7M6.8 7l.9 12.2h8.6L17.2 7M10.2 10.5v5.5M13.8 10.5v5.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function ruleSelect(items: RuleSelectItem[], label: string, variant?: 'soft'): HTMLElement {
  const cur = items.find((i) => i.on) ?? items[0];
  const listId = `rsel-${++rowSeq}`;
  const btnEl = h(
    'button.rsel-btn',
    { type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-controls': listId, 'aria-label': `${label}: ${cur.label}` },
    cur.icon ? h('span.rsel-ico', { 'aria-hidden': 'true', html: cur.icon }) : null,
    h('span.rsel-v', { class: cur.custom ? 'custom' : '' }, cur.label),
    h('span.rsel-chev', { 'aria-hidden': 'true' }),
  );
  const opts = items
    .filter((i) => !i.custom)
    .map((i) => {
      const o = h('li.rsel-opt', { role: 'option', tabindex: -1, 'aria-selected': String(i.on) }, h('span.rsel-check', { 'aria-hidden': 'true' }), i.icon ? h('span.rsel-ico', { 'aria-hidden': 'true', html: i.icon }) : null, h('span', i.label));
      o.addEventListener('click', () => {
        close();
        if (!i.on || i.repick) i.pick?.();
      });
      return o;
    });
  const list = h('ul.rsel-list', { id: listId, role: 'listbox', 'aria-label': label, hidden: true }, ...opts);
  const wrap = h('div.rsel', { class: variant ?? '' }, btnEl, list);
  const outside = (e: Event) => {
    if (!wrap.contains(e.target as Node)) close();
  };
  function open(): void {
    // open upward when the space below is short (the new-game footer sits at the bottom)
    const r = wrap.getBoundingClientRect();
    wrap.classList.toggle('up', innerHeight - r.bottom < 220 && r.top > innerHeight - r.bottom);
    list.hidden = false;
    btnEl.setAttribute('aria-expanded', 'true');
    wrap.classList.add('open');
    document.addEventListener('pointerdown', outside, true);
    const sel = opts.find((o) => o.getAttribute('aria-selected') === 'true') ?? opts[0];
    sel?.focus({ preventScroll: true });
  }
  function close(focusBtn = false): void {
    if (list.hidden) return;
    list.hidden = true;
    btnEl.setAttribute('aria-expanded', 'false');
    wrap.classList.remove('open');
    document.removeEventListener('pointerdown', outside, true);
    if (focusBtn) btnEl.focus();
  }
  btnEl.addEventListener('click', () => (list.hidden ? open() : close()));
  btnEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      open();
    }
  });
  list.addEventListener('keydown', (e) => {
    const i = opts.indexOf(document.activeElement as HTMLLIElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      opts[(i + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length]?.focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      (document.activeElement as HTMLElement)?.click();
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      if (e.key === 'Escape') e.stopPropagation();
      close(true);
    }
  });
  return wrap;
}

/** up to 5 gestures for the in-game chat: tiles showing the player's face making each one */
function gesturePicker(initial: ChatGesture[], face: FaceSpec | number, onChange: (v: ChatGesture[]) => void): HTMLElement {
  let picked = [...initial];
  const count = h('div.gp-count', { 'aria-live': 'polite' });
  const tiles = CHAT_GESTURES.map((g) => {
    const label = gestureLabel(g);
    const b = h('button.gp-tile', { type: 'button', 'aria-pressed': 'false', 'aria-label': label, title: label }, h('span.gp-face', staticFace(face, 'idle', { gesture: g })), h('span.gp-lbl', label), h('span.gp-num', { 'aria-hidden': 'true' }));
    b.addEventListener('click', () => {
      if (picked.includes(g)) picked = picked.filter((x) => x !== g);
      else if (picked.length < MAX_GESTURES) picked = [...picked, g];
      else return;
      sync();
      onChange([...picked]);
    });
    return { g, b };
  });
  function sync(): void {
    for (const { g, b } of tiles) {
      const i = picked.indexOf(g);
      b.setAttribute('aria-pressed', String(i >= 0));
      (b.querySelector('.gp-num') as HTMLElement).textContent = i >= 0 ? String(i + 1) : '';
      b.toggleAttribute('disabled', i < 0 && picked.length >= MAX_GESTURES);
    }
    count.textContent = t('settings.gesturesCount', { n: picked.length });
  }
  sync();
  return h('div.gp', h('div.gp-grid', ...tiles.map((x) => x.b)), count);
}

/** Juego tab, last: a quiet full-width row that opens Acerca de */
function aboutRow(onClick: () => void): HTMLElement {
  const b = h(
    'button.about-row',
    { type: 'button' },
    h('span.about-row-icon', { html: ICONS.about }),
    h('span.about-row-label', t('settings.about')),
    h('span.about-row-ver', __APP_VERSION__),
    h('span.rg-chev', { 'aria-hidden': 'true' }),
  );
  b.addEventListener('click', onClick);
  return h('section.card.set-card.about-card', b);
}

// ───────────────────────── screen ─────────────────────────

export function buildSettings(o: SettingsOpts): HTMLElement {
  let s: AppSettings = structuredClone(o.settings);
  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) => {
    s = { ...s, [k]: v };
    o.onChange(s, k);
  };
  const seg = <K extends 'language' | 'animationSpeed'>(k: K, values: AppSettings[K][], labelKey: (v: AppSettings[K]) => string) =>
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
        o.profileLocked ? null : row(t('settings.name'), name),
        o.profileLocked ? null : row(t('settings.avatarFace'), faceEditor(s.avatarFace ?? 0, (v) => set('avatarFace', v)), undefined, true),
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
      h('section.card.set-card', row(t('settings.gestures'), gesturePicker(sanitizeGestures(s.gestures), s.avatarFace ?? 0, (v) => set('gestures', v)), t('settings.gesturesHelp'), true)),
      h(
        'section.card.set-card',
        row(t('settings.language'), seg('language', ['es', 'en'], (v) => (v === 'es' ? 'Español' : 'English'))),
      ),
      o.onAbout ? aboutRow(o.onAbout) : null,
    );

  // graphics quality: Automática (per device, lowered when frames are slow) or a fixed level
  type QChoice = 'auto' | AppSettings['quality'];
  const qualityCtl = () => {
    // one quiet dropdown on the label's line (Automática picks the level itself)
    const box = h('div.set-ctl.quality-ctl');
    const render = () => {
      const cur: QChoice = s.qualityMode === 'manual' ? s.quality : 'auto';
      box.replaceChildren(
        ruleSelect(
          (['auto', 'low', 'medium', 'high'] as QChoice[]).map((v) => ({
            label: t(`settings.quality.${v}` as Key),
            on: v === cur,
            repick: v === 'auto',
            pick: () => {
              if (v === 'auto') {
                s = { ...s, autoQuality: undefined };
                set('qualityMode', 'auto');
                // keep this panel's copy in step with the fresh detection (later changes save it)
                const q = o.resolvedQuality?.();
                if (q) s = { ...s, quality: q, autoQuality: q };
              } else {
                s = { ...s, qualityMode: 'manual', quality: v };
                o.onChange(s, 'quality');
              }
              render();
            },
          })),
          t('settings.quality'),
          'soft',
        ),
      );
    };
    render();
    return box;
  };

  // ── Imagen y sonido ──
  const tabAv = () =>
    h(
      'div.set-tab-body',
      h(
        'section.card.set-card',
        row(
          t('settings.quality'),
          canFullscreen()
            ? h(
                'div.quality-row',
                qualityCtl(),
                h('button.btn.sq.fs-btn', { type: 'button', 'aria-label': t('menu.fullscreen'), title: t('menu.fullscreen'), html: ICONS.fullscreen, onclick: () => void toggleFullscreen() }),
              )
            : qualityCtl(),
        ),
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

  // ── Reglas: the shared mode dropdown + a read-only summary; editing lives in the mode editor ──
  // Parejas and Individual are the two built-ins; old saved profiles are now local modes.
  let rid: string = s.customMode && modeDef(s.customMode) ? s.customMode : (s.rulesTabMode ?? s.mode ?? 'pairs');
  const rulesWrap = h('div.set-tab-body');

  /** picking a mode here also selects it for the next match (its rules become the base's stored rules) */
  const selectMode = (id: string) => {
    const def = modeDef(id);
    if (!def) return;
    rid = id;
    const base = def.base;
    s = {
      ...s,
      mode: base,
      rulesTabMode: base,
      customMode: isBuiltInMode(id) ? undefined : id,
      rules: base === 'pairs' ? { ...def.rules } : s.rules,
      rulesIndividual: base === 'individual' ? { ...def.rules } : s.rulesIndividual,
    };
    o.onChange(s, 'mode');
    renderRules();
  };

  const renderRules = () => {
    const def = modeDef(rid) ?? (s.mode === 'individual' ? modeDef('individual') : modeDef('pairs'))!;
    rid = def.id;
    const base: GameMode = def.base;
    const descriptors = base === 'individual' ? o.ruleDescriptorsIndividual ?? [] : o.ruleDescriptors;

    // [mode dropdown] [+: new mode from this one | pencil: edit this custom mode] [trash: custom only]
    const sel = modeSelect({ current: def.id, onPick: selectMode });
    const custom = !isBuiltInMode(def.id);
    const editLabel = t(custom ? 'modes.edit' : 'modes.new');
    const edit = h('button.icon-btn.rsel-act', { type: 'button', 'aria-label': editLabel, title: editLabel, html: custom ? PENCIL_SVG : PLUS_SVG, disabled: o.editMode ? undefined : true });
    edit.addEventListener('click', () => {
      if (custom) o.editMode?.(def, false);
      else o.editMode?.(draftFrom(def, { ...def.rules }), true);
    });
    const delLabel = t('modes.delete');
    const del = h('button.icon-btn.rsel-act.danger', { type: 'button', 'aria-label': delLabel, title: delLabel, html: TRASH_SVG, disabled: custom ? undefined : true });
    del.addEventListener('click', async () => {
      if (!custom) return;
      const ok = await o.confirm({ title: t('modes.deleteTitle', { name: loc(def.name) }), body: t('modes.deleteBody'), ok: t('modes.delete'), cancel: t('common.cancel'), danger: true });
      if (!ok) return;
      deleteCustomMode(def.id);
      if (s.customMode === def.id) {
        s = { ...s, customMode: undefined, rules: base === 'pairs' ? { ...defaultRulesFor('pairs') } : s.rules, rulesIndividual: base === 'individual' ? { ...defaultRulesFor('individual') } : s.rulesIndividual };
        o.onChange(s, 'mode');
      }
      rid = base;
      renderRules();
    });

    rulesWrap.replaceChildren(h('section.card.set-card.preset-card', h('div.rsel-line.mode-row', h('div.rsel-slot', sel), edit, del)), modeView(def, descriptors));
  };
  renderRules();

  // ── tabs ──
  // inside a game the rules can't change: no Reglas tab
  const TABS: SettingsTab[] = o.profileLocked ? ALL_TABS.filter((k) => k !== 'rules') : ALL_TABS;
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
      if (!o.profileLocked && name.value.trim() && name.value.trim() !== s.playerName) set('playerName', name.value.trim().slice(0, 14));
      o.onBack();
    }),
    h('div.set-layout', h('nav.set-tabs', { role: 'tablist', 'aria-label': t('settings.tabs') }, ...tabBtns), scroll),
  );
}
