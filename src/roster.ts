/**
 * The CPU characters the player picks from (partner + two rivals). Pure data: shared by the app
 * (levels, styles, slams), the UI (names, faces, cards) and the engine tests.
 */
import type { CpuProfile, Difficulty, Lineup, PlayStyle } from './contracts';
import { CHARACTER_FACES, type FaceSpec } from 'kuavatars/faces';

type L10n = { es: string; en: string };

/** the avatar faces live in the shared KuAvatars library */
export type { FaceSpec };

export interface Character {
  id: string;
  name: string;
  /** short form for tight spots (phone-width grid) */
  short?: string;
  level: Difficulty;
  style: PlayStyle;
  face: FaceSpec;
  /** style tag shown on the card (gendered in Spanish) */
  tag: L10n;
  /** one-line description */
  desc: L10n;
  /** slams: chance multiplier on meaningful plays (0 = never) and the cap on the share of plays slammed */
  slam: { p: number; cap: number };
  /** grammatical gender, for "Compañero/Compañera" */
  fem: boolean;
}

export const ROSTER: Character[] = [
  {
    id: 'lola',
    name: 'Lola',
    level: 'easy',
    style: 'carefree',
    face: CHARACTER_FACES.lola,
    tag: { es: 'Despreocupada', en: 'Carefree' },
    desc: { es: 'Juega por diversión. Pone la primera ficha que le cabe y nunca da golpe en la mesa.', en: 'Plays for fun. Puts down the first ficha that fits and never slams.' },
    slam: { p: 0, cap: 0 },
    fem: true,
  },
  {
    id: 'pepe',
    name: 'Pepe',
    level: 'easy',
    style: 'impulsive',
    face: CHARACTER_FACES.pepe,
    tag: { es: 'Impulsivo', en: 'Impulsive' },
    desc: { es: 'Se deshace rápido de sus fichas más pesadas y olvida lo que ya se jugó.', en: 'Gets rid of his heaviest fichas fast and forgets what has been played.' },
    slam: { p: 0.7, cap: 1 / 5 },
    fem: false,
  },
  {
    id: 'nico',
    name: 'Nico',
    level: 'easy',
    style: 'beginner',
    face: CHARACTER_FACES.nico,
    tag: { es: 'Principiante', en: 'Beginner' },
    desc: { es: 'Todavía está aprendiendo. Sigue lo básico, pero no capta lo que intentas decirle.', en: 'Still learning. Follows the basics but misses what you’re trying to tell him.' },
    slam: { p: 0.35, cap: 1 / 6 },
    fem: false,
  },
  {
    id: 'elena',
    name: 'Elena',
    level: 'normal',
    style: 'balanced',
    face: CHARACTER_FACES.elena,
    tag: { es: 'Equilibrada', en: 'Balanced' },
    desc: { es: 'Guarda un poco de cada número y apoya el juego de su pareja.', en: 'Keeps a bit of every number and backs up her partner’s play.' },
    slam: { p: 0.6, cap: 1 / 6 },
    fem: true,
  },
  {
    id: 'andres',
    name: 'Andrés',
    level: 'normal',
    style: 'byTheBook',
    face: CHARACTER_FACES.andres,
    tag: { es: 'Clásico', en: 'By the book' },
    desc: { es: 'Dobles pronto y fichas pesadas primero. Sólido y predecible.', en: 'Doubles early, heavy fichas first. Solid and predictable.' },
    slam: { p: 0.5, cap: 1 / 6 },
    fem: false,
  },
  {
    id: 'rosa',
    name: 'Rosa',
    level: 'normal',
    style: 'blocker',
    face: CHARACTER_FACES.rosa,
    tag: { es: 'Bloqueadora', en: 'Blocker' },
    desc: { es: 'Le gusta cerrar los extremos a sus rivales y obligarlos a pasar.', en: 'Likes to close the ends on her rivals and force a pass.' },
    slam: { p: 0.8, cap: 1 / 5 },
    fem: true,
  },
  {
    id: 'carlos',
    name: 'Carlos',
    level: 'hard',
    style: 'aggressive',
    face: CHARACTER_FACES.carlos,
    tag: { es: 'Agresivo', en: 'Aggressive' },
    desc: { es: 'Cuenta las fichas, empuja su número fuerte y da golpe cuando importa.', en: 'Counts the fichas, pushes his strong number and slams when it matters.' },
    slam: { p: 1, cap: 1 / 4 },
    fem: false,
  },
  {
    id: 'marta',
    name: 'Marta',
    level: 'hard',
    style: 'calculator',
    face: CHARACTER_FACES.marta,
    tag: { es: 'Calculadora', en: 'Cold calculator' },
    desc: { es: 'Nunca da golpe ni regala nada. Prepara el cerrado cuando le conviene.', en: 'Never slams, never gives anything away. Sets up the cerrado when it suits her.' },
    slam: { p: 0, cap: 0 },
    fem: true,
  },
  {
    id: 'julio',
    name: 'Don Julio',
    short: 'Julio',
    level: 'hard',
    style: 'teamPlayer',
    face: CHARACTER_FACES.julio,
    tag: { es: 'De equipo', en: 'Team player' },
    desc: { es: 'Recuerda cada pase y juega para preparar el juego de su pareja.', en: 'Remembers every pass and plays to set up his partner.' },
    slam: { p: 0.6, cap: 1 / 6 },
    fem: false,
  },
  {
    id: 'zorg',
    name: 'Papi Zorg',
    short: 'Zorg',
    level: 'master',
    style: 'perfect',
    face: CHARACTER_FACES.zorg,
    tag: { es: 'Perfecto', en: 'Perfect' },
    desc: { es: 'El jugador perfecto. Vino de muy lejos solo para contar tus fichas.', en: 'The perfect player. Came from very far away just to count your fichas.' },
    slam: { p: 0.5, cap: 1 / 6 },
    fem: false,
  },
];

const BY_ID = new Map(ROSTER.map((c) => [c.id, c]));
export const character = (id: string): Character => BY_ID.get(id) ?? ROSTER[3];
export const isCharacter = (id: unknown): id is string => typeof id === 'string' && BY_ID.has(id);

/** what the engine needs to play a character */
export const profileOf = (id: string): CpuProfile => {
  const c = character(id);
  return { level: c.level, style: c.style };
};

/** default lineup: Elena partner, Andrés and Carlos rivals (the faces the game always had in those seats) */
export const DEFAULT_LINEUP: Lineup = { 1: 'carlos', 2: 'elena', 3: 'andres' };

/** three different known characters, else the default */
export function sanitizeLineup(v: unknown): Lineup | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const ids = [o[1], o[2], o[3]];
  if (!ids.every(isCharacter) || new Set(ids).size !== 3) return null;
  return { 1: ids[0] as string, 2: ids[1] as string, 3: ids[2] as string };
}

/** a random lineup; `keep` pins some seats (the rest are drawn from the characters not yet seated) */
export function randomLineup(keep: Partial<Lineup> = {}, rnd: () => number = Math.random): Lineup {
  const used = new Set(Object.values(keep));
  const pool = ROSTER.map((c) => c.id).filter((id) => !used.has(id));
  const draw = () => pool.splice(Math.floor(rnd() * pool.length), 1)[0];
  return { 1: keep[1] ?? draw(), 2: keep[2] ?? draw(), 3: keep[3] ?? draw() };
}

export const LEVEL_STARS: Record<Difficulty, number> = { easy: 1, normal: 2, hard: 3, master: 4 };
