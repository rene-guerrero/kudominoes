import type { RestoreState, TableStyle, TableView, TableViewOptions, TileBack, TileTheme } from '../contracts';
import { TableViewImpl } from './tableView';

export { layoutChain } from './chainLayout';
export type { ChainBounds, ChainLayoutResult, TilePose } from './chainLayout';
/**
 * Settings previews (2D canvas only, no WebGL; cached per arguments): PNG data URLs drawn with the
 * same procedural painters as the 3D table / tile atlas.
 *   tableThumb(style, w, h)    top-down table swatch (rail + felt + emblem on the room colour)
 *   tileBackThumb(back, w, h)  one tile back seen from above, portrait
 */
export { tableThumb, tileBackThumb } from './textures';

/** TableView with the optional extras implemented. */
export interface TableViewExt extends TableView {
  setSpeed(x: number): void;
  setReducedMotion(r: boolean): void;
  setLanguage(lang: 'es' | 'en'): void;
  setPlayerNames(names: [string, string, string, string]): void;
  setTileTheme(theme: TileTheme): void;
  setTableStyle(style: TableStyle): void;
  setTileBack(back: TileBack): void;
  restore(state: RestoreState): Promise<void>;
}

export function createTableView(opts: TableViewOptions): TableViewExt {
  return new TableViewImpl(opts);
}
