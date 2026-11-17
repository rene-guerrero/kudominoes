/**
 * Resolves the engine and the table view. The real modules are the unconditional path.
 * In dev builds only, `?mock=1` swaps in the lightweight mocks in ./mocks; the branch is
 * dead code in production (import.meta.env.DEV is false), so the mocks never reach the bundle.
 *
 * Start-up: the engine is small and needed for the settings, so it stays in the boot chunk. The
 * renderer (and three.js with it) is a dynamic import, so the menu can paint before it is fetched,
 * parsed and evaluated; `loadTableView()` returns the same `createTableView` as before.
 */
import type { EngineApi, TableView, TableViewOptions } from '../contracts';
import { engine as realEngine } from '../engine';

export type CreateView = (opts: TableViewOptions) => TableView;

const useMock = (): boolean => import.meta.env.DEV && new URLSearchParams(location.search).has('mock');

export async function loadEngine(): Promise<{ engine: EngineApi; mock: boolean }> {
  if (useMock()) return { engine: (await import('./mocks/engine')).engine, mock: true };
  return { engine: realEngine, mock: false };
}

let viewPromise: Promise<CreateView> | null = null;

/** The renderer chunk (three.js); memoised so every caller shares one download. */
export function loadTableView(): Promise<CreateView> {
  viewPromise ??= useMock()
    ? import('./mocks/view').then((m) => m.createTableView)
    : import('../render').then((m) => m.createTableView);
  return viewPromise;
}

/** Back-compat: everything at once (resolves only after the renderer chunk has loaded). */
export async function loadModules(): Promise<{ engine: EngineApi; createTableView: CreateView; mock: boolean }> {
  const [{ engine, mock }, createTableView] = await Promise.all([loadEngine(), loadTableView()]);
  return { engine, createTableView, mock };
}
