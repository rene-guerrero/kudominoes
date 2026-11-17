import type { FaceSpec } from '../roster';

/**
 * Faces are composable: every face is the same round head with a few features (lashes, brows, smirk,
 * freckles, glasses, aviators, moustache) — or Papi Zorg's alien head. The human picks one of
 * HUMAN_FACES; the CPU seats wear their characters' faces (src/roster.ts).
 */
export const HUMAN_FACES: FaceSpec[] = [
  { iris: '#3F7FD9' }, // 0 plain
  { iris: '#2F9B63', lashes: true }, // 1 lashes
  { iris: '#7A4A22', brows: 'thick' }, // 2 thick brows
  { iris: '#5B3FA8', stache: 'brown' }, // 3 handlebar moustache (no mouth)
  { iris: '#B8741F', freckles: true }, // 4 freckles
  { iris: '#3F7FD9', glasses: true }, // 5 round glasses
  { iris: '#2F9B63', brows: 'raised', smirk: true }, // 6 raised brow + smirk
  { iris: '#7A4A22', aviators: true, brows: 'aviator' }, // 7 aviator sunglasses
  { iris: '#1E9C9C', lashes: true, glasses: true }, // 8 lashes + round glasses
];
export const FACE_COUNT = HUMAN_FACES.length;
