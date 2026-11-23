/**
 * Rule profiles: named rule sets the player saves on this device (Ajustes → Reglas), per mode.
 * They show up next to "Cubano clásico" in Reglas, in the new-game rules line, and in the online
 * room's rules sheet (the host can pick any of them). Stored in localStorage only.
 */
import type { EngineApi, GameMode, RulePreset, RuleSettings } from '../contracts';
import { sanitizeRules } from './settings';

const KEY = 'kudominoes.ruleProfiles.v1';
export const MAX_PROFILES = 20;
export const MAX_NAME = 24;

export interface RuleProfile {
  id: string;
  name: string;
  mode: GameMode;
  rules: RuleSettings;
}

export function loadProfiles(engine: EngineApi): RuleProfile[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    const out: RuleProfile[] = [];
    for (const p of raw) {
      if (!p || typeof p !== 'object') continue;
      const o = p as Record<string, unknown>;
      const name = typeof o.name === 'string' ? o.name.trim().slice(0, MAX_NAME) : '';
      if (!name || typeof o.id !== 'string') continue;
      const mode: GameMode = o.mode === 'individual' ? 'individual' : 'pairs';
      out.push({ id: o.id, name, mode, rules: sanitizeRules(engine, o.rules, mode) });
      if (out.length >= MAX_PROFILES) break;
    }
    return out;
  } catch {
    return [];
  }
}

function store(list: RuleProfile[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage full / private mode: non-fatal */
  }
}

/** save (or overwrite, when a profile of that mode already has this name) */
export function saveProfile(engine: EngineApi, name: string, mode: GameMode, rules: RuleSettings): RuleProfile[] {
  const n = name.trim().slice(0, MAX_NAME);
  if (!n) return loadProfiles(engine);
  const list = loadProfiles(engine);
  const same = list.find((p) => p.mode === mode && p.name.toLocaleLowerCase() === n.toLocaleLowerCase());
  if (same) {
    same.name = n;
    same.rules = { ...rules };
  } else {
    if (list.length >= MAX_PROFILES) return list;
    list.push({ id: `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`, name: n, mode, rules: { ...rules } });
  }
  store(list);
  return list;
}

export function deleteProfile(engine: EngineApi, id: string): RuleProfile[] {
  const list = loadProfiles(engine).filter((p) => p.id !== id);
  store(list);
  return list;
}

export function profilesAsPresets(list: RuleProfile[]): RulePreset[] {
  return list.map((p) => ({ id: p.id, mode: p.mode, label: { es: p.name, en: p.name }, rules: p.rules }));
}

/** the engine presets, then the player's profiles (for naming the current rules) */
export function allPresets(engine: EngineApi): RulePreset[] {
  return [...(engine.RULE_PRESETS ?? []), ...profilesAsPresets(loadProfiles(engine))];
}

/** forget the old profiles (they were migrated into local game modes) */
export function clearProfiles(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
