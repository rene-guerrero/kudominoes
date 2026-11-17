/**
 * A small in-memory log of uncaught errors (window 'error' / 'unhandledrejection' and errors the app
 * reports itself), so the error screen can show the exact message + stack under "Detalles" — also in
 * production builds (the APK), where there is no console to look at.
 */
export interface LoggedError {
  at: number;
  where: string;
  message: string;
  stack: string;
}

const MAX = 12;
const log: LoggedError[] = [];
type Listener = (e: LoggedError, raw: unknown) => void;
const listeners: Listener[] = [];
let installed = false;

/** benign browser noise that is not an app failure */
export function isBenignError(message: string): boolean {
  return /ResizeObserver loop/i.test(message) || /^Script error\.?$/i.test(message);
}

export function describeError(err: unknown): { message: string; stack: string } {
  if (err instanceof Error) return { message: `${err.name}: ${err.message}`, stack: err.stack ?? '' };
  if (typeof err === 'string') return { message: err, stack: '' };
  try {
    return { message: JSON.stringify(err) ?? String(err), stack: '' };
  } catch {
    return { message: String(err), stack: '' };
  }
}

export function logError(where: string, err: unknown): LoggedError {
  const d = describeError(err);
  const e: LoggedError = { at: Date.now(), where, message: d.message, stack: d.stack };
  log.push(e);
  if (log.length > MAX) log.splice(0, log.length - MAX);
  for (const l of listeners.slice()) {
    try {
      l(e, err);
    } catch {
      /* ignore */
    }
  }
  return e;
}

/** record without alerting anyone (diagnostics shown under "Detalles" if an error screen comes up later) */
export function noteError(where: string, err: unknown): void {
  const d = describeError(err);
  log.push({ at: Date.now(), where, message: d.message, stack: d.stack });
  if (log.length > MAX) log.splice(0, log.length - MAX);
}

export function recentErrors(): readonly LoggedError[] {
  return log;
}

/** listen to every logged error (returns an unsubscribe function) */
export function onErrorLogged(l: Listener): () => void {
  listeners.push(l);
  return () => {
    const i = listeners.indexOf(l);
    if (i >= 0) listeners.splice(i, 1);
  };
}

/** text for the "Detalles" box: newest first */
export function errorReport(first?: LoggedError): string {
  const list = first ? [first, ...log.filter((e) => e !== first).reverse()] : log.slice().reverse();
  const head = `${typeof navigator !== 'undefined' ? navigator.userAgent : ''}\n${typeof location !== 'undefined' ? location.href : ''}`;
  return [
    head,
    ...list.slice(0, 6).map((e) => `[${new Date(e.at).toISOString().slice(11, 19)}] ${e.where}: ${e.message}${e.stack ? `\n${e.stack.split('\n').slice(0, 12).join('\n')}` : ''}`),
  ].join('\n\n');
}

/** capture window errors once (boot) */
export function installErrorLog(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (ev: ErrorEvent) => {
    // resource load errors (img/script) bubble without a message: not ours to report here
    if (!ev.message && !ev.error) return;
    const msg = ev.message || describeError(ev.error).message;
    if (isBenignError(msg)) return;
    logError('error', ev.error ?? msg);
  });
  window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
    const msg = describeError(ev.reason).message;
    if (isBenignError(msg)) return;
    logError('unhandledrejection', ev.reason);
  });
}
