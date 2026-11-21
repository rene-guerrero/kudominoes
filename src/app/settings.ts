import type { AppSettings, EngineApi, GameMode, Lineup, RuleSettings, SettingDescriptor } from '../contracts';
import { TABLE_STYLES, TILE_BACKS } from '../contracts';
import { migrateRules, RULES_VERSION } from '../engine/rules';
import { DEFAULT_LINEUP, isCharacter } from '../roster';
import { sanitizeFace } from 'kuavatars/faces';
import { resolveQuality } from './perf';
import { DEFAULT_GESTURES, sanitizeGestures } from '../ui/chat';

const KEY = 'kudominoes.settings.v1';

export function defaultSettings(engine: EngineApi): AppSettings {
  const lang = 'es' as const; // Spanish is the default; English is opt-in in Ajustes
  return {
    language: lang,
    // auto: resolved per device on load (src/app/perf.ts); 'medium' is only a placeholder until then
    quality: 'medium',
    qualityMode: 'auto',
    sound: true,
    music: false,
    vibration: true,
    animationSpeed: 'normal',
    playerName: '', // empty = localized default ('Tú' / 'You')
    rules: { ...engine.DEFAULT_RULES },
    tileTheme: 'dark',
    reducedMotion: false,
    avatars: true,
    avatarFace: 0,
    lineup: { ...DEFAULT_LINEUP },
    rulesVersion: RULES_VERSION,
    settingsTab: 'game',
    tableStyle: 'green',
    tileBack: 'ornate',
    mode: 'pairs',
    rulesIndividual: { ...(engine.DEFAULT_RULES_INDIVIDUAL ?? {}) },
    soloOpponents: 2,
    soloLineup: [],
    rulesTabMode: 'pairs',
    gestures: [...DEFAULT_GESTURES],
  };
}

/** the stored rules of a mode */
export function rulesFor(s: AppSettings, mode: GameMode): RuleSettings {
  return mode === 'individual' ? (s.rulesIndividual ?? {}) : s.rules;
}

const isQuality = (v: unknown): v is AppSettings['quality'] => v === 'low' || v === 'medium' || v === 'high';

/** Keep only rules the engine knows, with values of the right type / one of the options. */
export function sanitizeRules(engine: EngineApi, stored: unknown, mode: GameMode = 'pairs'): RuleSettings {
  const solo = mode === 'individual' && !!engine.RULE_SETTINGS_INDIVIDUAL;
  const descriptors = solo ? engine.RULE_SETTINGS_INDIVIDUAL! : engine.RULE_SETTINGS;
  const out: RuleSettings = { ...(solo ? (engine.DEFAULT_RULES_INDIVIDUAL ?? {}) : engine.DEFAULT_RULES) };
  const src = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const byKey = new Map<string, SettingDescriptor>(descriptors.map((d) => [d.key, d]));
  for (const key of Object.keys(out)) {
    const v = src[key];
    if (v === undefined) continue;
    const d = byKey.get(key);
    // selects may mix value types (e.g. capicúa: 0 | 'double' | 2), so membership is what counts
    if (d?.type === 'select' && d.options) {
      if (!d.options.some((o) => o.value === v)) continue;
    } else if (typeof v !== typeof out[key]) continue;
    out[key] = v as RuleSettings[string];
  }
  // descriptors whose key is absent from DEFAULT_RULES still get their default
  for (const d of descriptors) if (!(d.key in out)) out[d.key] = d.default;
  return out;
}

/** a lineup slot may hold a character id or 'random' (drawn when the match starts) */
export const RANDOM = 'random';

/**
 * The stored new-game lineup: known characters (or 'random'), no character twice. Anything else —
 * including the old per-seat CPU levels (`cpuLevels`, which had no characters) — gives the default
 * lineup (Carlos / Elena / Andrés, the faces those seats always had).
 */
export function sanitizeLineupSetting(v: unknown): Lineup {
  if (!v || typeof v !== 'object') return { ...DEFAULT_LINEUP };
  const o = v as Record<string, unknown>;
  const ids = [o[1], o[2], o[3]];
  if (!ids.every((x) => x === RANDOM || isCharacter(x))) return { ...DEFAULT_LINEUP };
  const real = ids.filter((x) => x !== RANDOM);
  if (new Set(real).size !== real.length) return { ...DEFAULT_LINEUP };
  return { 1: ids[0] as string, 2: ids[1] as string, 3: ids[2] as string };
}

/** individual-mode opponents: up to three different known characters, in order */
export function sanitizeSoloLineup(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) if (isCharacter(x) && !out.includes(x) && out.length < 3) out.push(x);
  return out;
}

export function loadSettings(engine: EngineApi): AppSettings {
  const def = defaultSettings(engine);
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return resolveQuality(def);
    const s = JSON.parse(raw) as Partial<AppSettings>;
    const pick = <K extends keyof AppSettings>(k: K, ok: (v: unknown) => boolean): AppSettings[K] =>
      ok(s[k]) ? (s[k] as AppSettings[K]) : def[k];
    // rules stored before the tens-scale scoring (no rulesVersion) are migrated: structural choices are
    // kept, everything on the points scale takes the new Cuban defaults
    const storedRules = typeof s.rulesVersion === 'number' && s.rulesVersion >= RULES_VERSION ? s.rules : migrateRules(s.rules as RuleSettings | undefined, s.rulesVersion);
    // graphics quality: settings saved before the auto mode existed (no qualityMode) cannot tell a level
    // the player picked from the old per-device guess, so they move to auto; 'manual' stays as chosen
    const qualityMode = s.qualityMode === 'manual' && isQuality(s.quality) ? 'manual' : 'auto';
    return resolveQuality({
      language: pick('language', (v) => v === 'es' || v === 'en'),
      quality: pick('quality', isQuality),
      qualityMode,
      autoQuality: isQuality(s.autoQuality) ? s.autoQuality : undefined,
      sound: pick('sound', (v) => typeof v === 'boolean'),
      music: pick('music', (v) => typeof v === 'boolean'),
      vibration: pick('vibration', (v) => typeof v === 'boolean'),
      animationSpeed: pick('animationSpeed', (v) => v === 'normal' || v === 'fast'),
      // the old stored default 'Tú'/'You' becomes '' so the name follows the language
      playerName: /^(Tú|You)$/.test(String(s.playerName ?? '')) ? '' : pick('playerName', (v) => typeof v === 'string').trim().slice(0, 14),
      rules: sanitizeRules(engine, storedRules),
      tileTheme: s.tileTheme === 'classic' || s.tileTheme === 'dark' ? s.tileTheme : def.tileTheme,
      reducedMotion: typeof s.reducedMotion === 'boolean' ? s.reducedMotion : false,
      avatars: typeof s.avatars === 'boolean' ? s.avatars : true,
      avatarFace: sanitizeFace(s.avatarFace ?? 0),
      lineup: sanitizeLineupSetting(s.lineup),
      rulesVersion: RULES_VERSION,
      settingsTab: s.settingsTab === 'game' || s.settingsTab === 'rules' || s.settingsTab === 'av' ? s.settingsTab : 'game',
      tableStyle: TABLE_STYLES.includes(s.tableStyle as never) ? s.tableStyle : def.tableStyle,
      tileBack: TILE_BACKS.includes(s.tileBack as never) ? s.tileBack : def.tileBack,
      // individual mode (settings saved before it existed: pairs, individual defaults)
      mode: s.mode === 'individual' ? 'individual' : 'pairs',
      rulesIndividual: sanitizeRules(engine, s.rulesIndividual, 'individual'),
      soloOpponents: s.soloOpponents === 1 || s.soloOpponents === 2 || s.soloOpponents === 3 ? s.soloOpponents : 2,
      soloLineup: sanitizeSoloLineup(s.soloLineup),
      gestures: sanitizeGestures(s.gestures),
      rulesTabMode: s.rulesTabMode === 'individual' ? 'individual' : s.rulesTabMode === 'pairs' ? 'pairs' : s.mode === 'individual' ? 'individual' : 'pairs',
    });
  } catch {
    return resolveQuality(def);
  }
}

export function saveSettings(s: AppSettings): void {
  try {
    // drop keys of older versions (difficulty, cpuLevels) so they never come back
    const { difficulty: _d, cpuLevels: _c, ...rest } = s as AppSettings & { difficulty?: unknown; cpuLevels?: unknown };
    void _d;
    void _c;
    localStorage.setItem(KEY, JSON.stringify({ ...rest, rulesVersion: RULES_VERSION }));
  } catch {
    /* storage full / private mode — non-fatal */
  }
}

/** The effective match target (in points on the active scale). */
export function findTarget(engine: EngineApi, rules: RuleSettings): number | null {
  if (engine.matchTarget) return engine.matchTarget(rules);
  return typeof rules.target === 'number' ? rules.target : null;
}
