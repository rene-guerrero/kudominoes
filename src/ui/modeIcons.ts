/** Small inline icons for local game modes (the mode dropdown, editor and read-only view). */
const WRAP = (inner: string) => `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">${inner}</svg>`;

const half = (x: number) => `<rect x="${x}" y="3" width="9" height="18" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M${x + 1.8} 12h5.4" stroke="currentColor" stroke-width="1.4"/><circle cx="${x + 4.5}" cy="7.3" r="1.1" fill="currentColor"/><circle cx="${x + 4.5}" cy="16.5" r="1.1" fill="currentColor"/>`;

const ICONS: Record<string, string> = {
  // two dominoes, side by side
  pair: WRAP(half(2.4) + half(12.6)),
  // one domino
  solo: WRAP(half(7.5)),
  star: WRAP('<path d="M12 3.2l2.5 5.2 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>'),
  flame: WRAP('<path d="M12.5 2.5c.8 3-1.4 4.3-2.7 6.1-1.2 1.7-1.4 3.3-.4 4.6.7-1 1.5-1.6 2.4-2-.3 2.1 1 3 1.8 3.9 1.3 1.4 1.3 3-.2 4.4a6 6 0 1 1 7.6-9.2c-1.2-2.4-3-4.2-4.2-6.6-.5 1-1.2 1.7-2 2.1.7-1.6.5-3-.3-3.3z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>'),
  crown: WRAP('<path d="M3.5 8l3.4 3 5.1-6 5.1 6 3.4-3-1.7 10H5.2z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><path d="M5.2 18h13.6" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>'),
  shield: WRAP('<path d="M12 3l7 2.6v5.7c0 4.4-2.9 7.7-7 9.7-4.1-2-7-5.3-7-9.7V5.6z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><path d="M8.7 12l2.2 2.2 4.5-4.7" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>'),
};

/** the ids offered in the mode editor */
export const MODE_ICON_IDS = Object.keys(ICONS);

/** inline SVG for a mode icon id (falls back to the single-domino icon) */
export const modeIconSvg = (id: string): string => ICONS[id] ?? ICONS.solo;
