/**
 * Local game modes (Ajustes › Reglas, Nueva partida). Kudominoes has two base modes — Parejas and
 * Individual — and each is a rule set of its own. A player-made mode is a name/icon on top of a base
 * mode plus that base's (possibly edited) rules, stored here. Old saved rule profiles are folded into
 * modes once, on first run, so nothing the player saved is lost.
 *
 * Online rooms still only carry `mode` + `rules` (see net/protocol.ts): a custom mode plays as its base
 * with its rule set, and the lobby shows the base mode. Full custom-mode sync is a separate step.
 */
import type { AppSettings, DominoMode, GameMode, RuleSettings } from '../contracts';
import { defaultRulesFor, normalizeRules, sameRules } from '../engine/rules';
import { clearProfiles, loadProfiles } from './ruleProfiles';
import type { EngineApi, RulePreset } from '../contracts';
import { loc, t } from '../ui/i18n';

const KEY = 'kudominoes.modes.v1';
const MIGRATED_KEY = 'kudominoes.modes.migrated.v1';
export const MAX_CUSTOM_MODES = 30;
export const BUILT_IN_MODES: GameMode[] = ['pairs', 'individual'];

const L = (es: string, en: string) => ({ es, en });

/** the two built-in modes; their rules are the engine defaults */
export const BUILTIN_MODES: Record<GameMode, DominoMode> = {
  pairs: { v: 1, id: 'pairs', name: L('Parejas', 'Pairs'), icon: 'pair', base: 'pairs', rules: { ...defaultRulesFor('pairs') } },
  individual: { v: 1, id: 'individual', name: L('Individual', 'Individual'), icon: 'solo', base: 'individual', rules: { ...defaultRulesFor('individual') } },
};

export const isBuiltInMode = (id: string): id is GameMode => id === 'pairs' || id === 'individual';

/** stored custom modes, sanitized on read (unknown modes/rules can't break the UI) */
export function loadCustomModes(): DominoMode[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(list)) return [];
    const out: DominoMode[] = [];
    for (const x of list) {
      if (!x || typeof x !== 'object') continue;
      const m = x as Partial<DominoMode>;
      if (typeof m.id !== 'string' || !m.id || isBuiltInMode(m.id) || (m.base !== 'pairs' && m.base !== 'individual')) continue;
      const nm: unknown = m.name;
      const es = typeof (nm as { es?: unknown })?.es === 'string' ? (nm as { es: string }).es.trim() : typeof nm === 'string' ? nm.trim() : '';
      const en = typeof (nm as { en?: unknown })?.en === 'string' ? (nm as { en: string }).en.trim() : '';
      if (!es) continue;
      out.push({
        v: 1,
        id: m.id,
        name: L(es.slice(0, 24), en.slice(0, 24) || es.slice(0, 24)),
        icon: typeof m.icon === 'string' && m.icon ? m.icon : m.base === 'pairs' ? 'pair' : 'solo',
        base: m.base,
        rules: normalizeRules(m.rules, m.base),
      });
      if (out.length >= MAX_CUSTOM_MODES) break;
    }
    return out;
  } catch {
    return [];
  }
}

function store(list: DominoMode[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_CUSTOM_MODES)));
  } catch {
    /* storage full / private mode: non-fatal */
  }
}

export const customMode = (id: string | undefined): DominoMode | null => (id ? (loadCustomModes().find((m) => m.id === id) ?? null) : null);

/** the definition of a built-in or custom mode id */
export const modeDef = (id: string): DominoMode | null => (isBuiltInMode(id) ? BUILTIN_MODES[id] : customMode(id));

/** every mode and its labels, for name-uniqueness checks */
export function allModes(): DominoMode[] {
  return [...Object.values(BUILTIN_MODES), ...loadCustomModes()];
}

export function modeNameFree(name: string, exceptId?: string): boolean {
  const n = name.trim().toLocaleLowerCase();
  return !allModes().some((m) => m.id !== exceptId && (m.name.es.toLocaleLowerCase() === n || m.name.en.toLocaleLowerCase() === n));
}

export function newModeId(): string {
  return `m${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

/** a fresh editable mode based on an existing one (the + button) */
export function draftFrom(base: DominoMode, rules?: RuleSettings): DominoMode {
  return { ...structuredClone(base), id: newModeId(), name: L('', ''), rules: { ...(rules ?? base.rules) } };
}

/** save (create or overwrite by id); returns the saved list */
export function saveCustomMode(def: DominoMode): DominoMode[] {
  const clean: DominoMode = {
    v: 1,
    id: def.id,
    name: L(def.name.es.trim().slice(0, 24) || 'Mi modo', (def.name.en || def.name.es).trim().slice(0, 24) || 'My mode'),
    icon: def.icon || (def.base === 'pairs' ? 'pair' : 'solo'),
    base: def.base,
    rules: normalizeRules(def.rules, def.base),
  };
  const list = loadCustomModes().filter((m) => m.id !== clean.id);
  list.unshift(clean);
  store(list);
  return list;
}

export function deleteCustomMode(id: string): DominoMode[] {
  const list = loadCustomModes().filter((m) => m.id !== id);
  store(list);
  return list;
}

/** the rules actually played for a selected mode (custom mode = its own rule set) */
export function rulesForMode(settings: AppSettings, mode: GameMode = settings.mode ?? 'pairs'): RuleSettings {
  const custom = customMode(settings.customMode);
  if (custom && custom.base === mode) return normalizeRules(custom.rules, mode);
  const slot = mode === 'individual' ? settings.rulesIndividual : settings.rules;
  return { ...(slot ?? defaultRulesFor(mode)) };
}

/**
 * Fold saved rule profiles into local modes, once. The rule set active at upgrade time is also folded
 * in (as "Mis reglas") when it wasn't one of the profiles, so the read-only mode view and the rules
 * actually played always agree. Returns the settings with that mode selected.
 */
export function migrateProfilesToModes(engine: EngineApi, settings: AppSettings): AppSettings {
  try {
    if (localStorage.getItem(MIGRATED_KEY)) return settings;
  } catch {
    return settings;
  }
  const currentMode: GameMode = settings.mode ?? 'pairs';
  const currentRules = normalizeRules(currentMode === 'pairs' ? settings.rules : settings.rulesIndividual, currentMode);
  const list = loadCustomModes();
  const pick = () => {
    const withNames = new Set([...allModes().map((m) => m.name.es), ...list.map((m) => m.name.es)]);
    let n = currentMode === 'pairs' ? 'Mis reglas' : 'Mis reglas (individual)';
    let i = 2;
    while (withNames.has(n)) n = `${currentMode === 'pairs' ? 'Mis reglas' : 'Mis reglas (individual)'} ${i++}`;
    return n;
  };
  let selected: string | undefined;

  for (const p of loadProfiles(engine)) {
    if (list.length >= MAX_CUSTOM_MODES) break;
    const rules = normalizeRules(p.rules, p.mode);
    const id = newModeId();
    list.push({ v: 1, id, name: L(p.name, p.name), icon: p.mode === 'pairs' ? 'pair' : 'solo', base: p.mode, rules });
    if (!selected && !settings.customMode && p.mode === currentMode && sameRules(rules, currentRules, p.mode)) selected = id;
  }
  // an edited but unsaved rule set was still persisted in settings: keep it as its own mode
  if (!selected && !settings.customMode && !sameRules(currentRules, defaultRulesFor(currentMode), currentMode)) {
    const existing = list.find((m) => m.base === currentMode && sameRules(m.rules, currentRules, currentMode));
    if (existing) selected = existing.id;
    else if (list.length < MAX_CUSTOM_MODES) {
      const id = newModeId();
      const name = pick();
      list.push({ v: 1, id, name: L(name, name.replace('Mis reglas', 'My rules')), icon: currentMode === 'pairs' ? 'pair' : 'solo', base: currentMode, rules: currentRules });
      selected = id;
    }
  }
  if (list.length) store(list);
  // the profiles now live on as modes: drop the old store so nothing reads stale copies
  clearProfiles();
  try {
    localStorage.setItem(MIGRATED_KEY, '1');
  } catch {
    /* ignore */
  }
  return selected ? { ...settings, customMode: selected } : settings;
}

/** the engine presets, then the player's modes as presets (for naming a rule set anywhere: lobby, new game) */
export function allPresets(engine: EngineApi): RulePreset[] {
  return [...(engine.RULE_PRESETS ?? []), ...loadCustomModes().map((m) => ({ id: m.id, mode: m.base, label: { ...m.name }, rules: m.rules }))];
}

/** the menu's last-setup line: "Parejas · Cubano clásico", "Individual · 3 jugadores", or a custom mode's name */
export function setupLine(engine: EngineApi, settings: AppSettings): string {
  const mode: GameMode = settings.mode ?? 'pairs';
  const c = customMode(settings.customMode);
  const players = mode === 'individual' ? t('menu.players', { n: (settings.soloOpponents ?? 2) + 1 }) : '';
  if (c && c.base === mode) return [loc(c.name), players].filter(Boolean).join(' · ');
  if (players) return `${t('mode.individual')} · ${players}`;
  const rules = rulesForMode(settings, mode);
  const p = allPresets(engine).find((x) => (x.mode ?? 'pairs') === mode && Object.keys(x.rules).every((k) => x.rules[k] === rules[k]));
  return `${t('mode.pairs')} · ${p ? loc(p.label) : t('settings.preset.custom')}`;
}
