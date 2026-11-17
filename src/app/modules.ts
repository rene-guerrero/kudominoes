/**
 * Resolves the engine and the table view. The real modules are the unconditional path.
 * In dev builds only, `?mock=1` swaps in the lightweight mocks in ./mocks; the branch is
 * dead code in production (import.meta.env.DEV is false), so the mocks never reach the bundle.
 */
import type { EngineApi, TableView, TableViewOptions } from '../contracts';
import { engine as realEngine } from '../engine';
import { createTableView as realCreateTableView } from '../render';

type CreateView = (opts: TableViewOptions) => TableView;

export async function loadModules(): Promise<{ engine: EngineApi; createTableView: CreateView; mock: boolean }> {
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('mock')) {
    const [e, r] = await Promise.all([import('./mocks/engine'), import('./mocks/view')]);
    return { engine: e.engine, createTableView: r.createTableView, mock: true };
  }
  return { engine: realEngine, createTableView: realCreateTableView, mock: false };
}
