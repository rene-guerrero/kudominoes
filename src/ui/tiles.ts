/** Procedural SVG dominoes for the overlay (summary hands, ends indicator, logo). */

const SPOTS: Record<number, [number, number][]> = {
  0: [],
  1: [[0.5, 0.5]],
  2: [[0.27, 0.27], [0.73, 0.73]],
  3: [[0.27, 0.27], [0.5, 0.5], [0.73, 0.73]],
  4: [[0.27, 0.27], [0.73, 0.27], [0.27, 0.73], [0.73, 0.73]],
  5: [[0.27, 0.27], [0.73, 0.27], [0.5, 0.5], [0.27, 0.73], [0.73, 0.73]],
  6: [[0.27, 0.23], [0.73, 0.23], [0.27, 0.5], [0.73, 0.5], [0.27, 0.77], [0.73, 0.77]],
};

import type { TileTheme } from '../contracts';

const PAL: Record<TileTheme, { pip: string; one: string; face: string; edge: string; stroke: string; line: string }> = {
  classic: { pip: '#1a1410', one: '#c8231b', face: '#fff8ec', edge: '#b9a27f', stroke: '#e7d6b8', line: '#b9a27f' },
  dark: { pip: '#f4ecdb', one: '#e2372b', face: '#2a2724', edge: '#0d0c0b', stroke: '#4a443e', line: '#8d857a' },
};
let theme: TileTheme = 'dark';
/** HTML mini-tiles follow the same theme as the 3D tiles */
export function setTileTheme(t: TileTheme): void {
  theme = t;
}

/**
 * One half of a tile. Pips are black except the single red pip of the 1. `along` = the tile's long
 * axis ('y' for vertical tiles, 'x' for horizontal); the 6 is always two lines of three along it.
 */
function half(v: number, ox: number, oy: number, s: number, along: 'x' | 'y' = 'y', th: TileTheme = theme) {
  const color = v === 1 ? PAL[th].one : PAL[th].pip;
  return SPOTS[v]
    .map(([x, y]) => {
      const [px, py] = along === 'x' ? [y, x] : [x, y];
      return `<circle cx="${(ox + px * s).toFixed(2)}" cy="${(oy + py * s).toFixed(2)}" r="${(s * 0.095).toFixed(2)}" fill="${color}"/>`;
    })
    .join('');
}

/** Vertical (default) or horizontal tile. Size = short side in px. */
export function tileSvg(a: number, b: number, opts: { size?: number; horizontal?: boolean; cls?: string; theme?: TileTheme } = {}): string {
  const th = opts.theme ?? theme;
  const s = 20;
  const w = opts.horizontal ? s * 2 : s;
  const hh = opts.horizontal ? s : s * 2;
  const px = opts.size ?? 18;
  const pw = opts.horizontal ? px * 2 : px;
  const ph = opts.horizontal ? px : px * 2;
  const lc = PAL[th].line;
  const line = opts.horizontal
    ? `<rect x="${s - 0.6}" y="3" width="1.2" height="${s - 6}" rx=".6" fill="${lc}"/>`
    : `<rect x="3" y="${s - 0.6}" width="${s - 6}" height="1.2" rx=".6" fill="${lc}"/>`;
  const h1 = half(a, 0, 0, s, opts.horizontal ? 'x' : 'y', th);
  const h2 = opts.horizontal ? half(b, s, 0, s, 'x', th) : half(b, 0, s, s, 'y', th);
  const P = PAL[th];
  return `<svg class="tile ${opts.cls ?? ''}" viewBox="-1 -1 ${w + 2} ${hh + 3}" width="${pw}" height="${ph}" aria-label="${a}-${b}" role="img">
<rect x="0" y="1.4" width="${w}" height="${hh}" rx="3.4" fill="${P.edge}"/>
<rect x="0" y="0" width="${w}" height="${hh}" rx="3.4" fill="${P.face}" stroke="${P.stroke}" stroke-width=".6"/>${line}${h1}${h2}</svg>`;
}

/** Just one square face (for the open-ends indicator). */
export function faceSvg(v: number, px = 26): string {
  const s = 20;
  return `<svg class="face" viewBox="-1 -1 22 23.4" width="${px}" height="${px}" aria-label="${v}" role="img">
<rect x="0" y="1.4" width="${s}" height="${s}" rx="4" fill="${PAL[theme].edge}"/>
<rect x="0" y="0" width="${s}" height="${s}" rx="4" fill="${PAL[theme].face}" stroke="${PAL[theme].stroke}" stroke-width=".6"/>${half(v, 0, 0, s)}</svg>`;
}
