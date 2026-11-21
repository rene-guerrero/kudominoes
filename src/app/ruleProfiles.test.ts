import { beforeEach, describe, expect, it } from 'vitest';
import { engine } from '../engine';
import { allPresets, deleteProfile, loadProfiles, saveProfile } from './ruleProfiles';
import { presetName } from '../ui/settings';

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

describe('rule profiles', () => {
  beforeEach(() => store.clear());

  it('saves, names, overwrites by name and deletes', () => {
    const d = engine.RULE_SETTINGS.find((x) => x.type === 'toggle')!;
    const rules = { ...engine.DEFAULT_RULES, [d.key]: !engine.DEFAULT_RULES[d.key] };
    let list = saveProfile(engine, '  Casa  ', 'pairs', rules);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Casa');
    expect(presetName(allPresets(engine), rules, 'pairs')).toBe('Casa');
    // same name (any case) overwrites
    list = saveProfile(engine, 'casa', 'pairs', engine.DEFAULT_RULES);
    expect(list).toHaveLength(1);
    // another mode is a separate profile
    list = saveProfile(engine, 'Casa', 'individual', engine.DEFAULT_RULES_INDIVIDUAL ?? {});
    expect(list.map((p) => p.mode)).toEqual(['pairs', 'individual']);
    list = deleteProfile(engine, list[0].id);
    expect(loadProfiles(engine).map((p) => p.mode)).toEqual(['individual']);
  });

  it('drops junk and unknown rule values from storage', () => {
    store.set('kudominoes.ruleProfiles.v1', JSON.stringify([null, { id: 'x', name: '' }, { id: 'y', name: 'Ok', rules: { nope: 1 } }]));
    const list = loadProfiles(engine);
    expect(list).toHaveLength(1);
    expect(list[0].rules).toEqual(engine.DEFAULT_RULES);
    expect('nope' in list[0].rules).toBe(false);
  });
});
