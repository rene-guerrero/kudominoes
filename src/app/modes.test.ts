import { beforeEach, describe, expect, it } from 'vitest';
import { engine } from '../engine';
import type { AppSettings } from '../contracts';
import {
  BUILTIN_MODES,
  customMode,
  deleteCustomMode,
  loadCustomModes,
  migrateProfilesToModes,
  modeNameFree,
  rulesForMode,
  saveCustomMode,
} from './modes';
import { saveProfile } from './ruleProfiles';

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

/** one toggle flipped, so the rule set is valid but different from the default */
const tweaked = (base: 'pairs' | 'individual' = 'pairs') => {
  const rules = { ...(base === 'pairs' ? engine.DEFAULT_RULES : engine.DEFAULT_RULES_INDIVIDUAL) };
  const d = (base === 'pairs' ? engine.RULE_SETTINGS : engine.RULE_SETTINGS_INDIVIDUAL ?? []).find((x) => x.type === 'toggle')!;
  rules[d.key] = !rules[d.key];
  return rules;
};

const settings = (over: Partial<AppSettings> = {}): AppSettings =>
  ({
    language: 'es',
    rules: { ...engine.DEFAULT_RULES },
    rulesIndividual: { ...(engine.DEFAULT_RULES_INDIVIDUAL ?? {}) },
    mode: 'pairs',
    ...over,
  }) as AppSettings;

describe('local game modes', () => {
  beforeEach(() => {
    store.clear();
    saveCustomMode({ ...BUILTIN_MODES.pairs, id: 'm1', name: { es: 'Casa', en: 'Home' } });
  });

  it('keeps the two built-ins and stores/edits/deletes custom modes', () => {
    expect(loadCustomModes().map((m) => m.name.es)).toEqual(['Casa']);
    expect(modeNameFree('Parejas')).toBe(false);
    expect(modeNameFree('Casa')).toBe(false);
    expect(customMode('m1')?.name.es).toBe('Casa');
    saveCustomMode({ ...BUILTIN_MODES.individual, id: 'm1', name: { es: 'Casa 2', en: 'Home 2' } });
    expect(loadCustomModes().map((m) => m.name.es)).toEqual(['Casa 2']);
    expect(deleteCustomMode('m1')).toHaveLength(0);
    expect(customMode('m1')).toBeNull();
  });

  it('plays a custom mode\'s own rules only in its base mode', () => {
    const rules = tweaked();
    saveCustomMode({ ...BUILTIN_MODES.pairs, id: 'm1', rules });
    expect(rulesForMode(settings({ customMode: 'm1' }))).toEqual(rules);
    expect(rulesForMode(settings({ customMode: 'm1' }), 'individual')).toEqual(settings().rulesIndividual);
  });

  it('keeps tileSet in a custom mode through save/load and rulesForMode', () => {
    const d9 = { ...engine.DEFAULT_RULES, tileSet: 'double9' as const, target: 100 };
    saveCustomMode({ ...BUILTIN_MODES.pairs, id: 'm1', name: { es: 'Doble 9', en: 'Double 9' }, rules: d9 });
    expect(customMode('m1')?.rules.tileSet).toBe('double9');
    expect(customMode('m1')?.rules.target).toBe(100);
    expect(loadCustomModes()[0].rules.tileSet).toBe('double9');
    expect(rulesForMode(settings({ customMode: 'm1' })).tileSet).toBe('double9');
  });

  it('migrates saved profiles and the active rule set into modes once', () => {
    saveProfile(engine, 'Perfil', 'pairs', { ...engine.DEFAULT_RULES });
    const active = tweaked();
    const first = migrateProfilesToModes(engine, settings({ rules: active }));
    const modes = loadCustomModes();
    expect(modes.map((m) => m.name.es)).toContain('Perfil');
    expect(first.customMode).toBeTruthy();
    expect(customMode(first.customMode)?.rules).toEqual(active);
    // running again is a no-op
    const second = migrateProfilesToModes(engine, settings());
    expect(second.customMode).toBeUndefined();
    expect(loadCustomModes()).toHaveLength(modes.length);
  });
});
