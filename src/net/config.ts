/**
 * Online play: where the room server lives, and the share link.
 *
 * Order: a page served by a local host (Jugar con amigos: the PC dev host or a phone) talks to its own
 * origin → `VITE_MP_URL` (build-time env) → dev: the same host on port 8787 (`npx wrangler dev`) →
 * production: MP_SERVER_URL below.
 */
import { joinOrigin, localServed, type LocalServed } from 'kunet';

// deployed room server (server/, `npx wrangler deploy`)
export const MP_SERVER_URL = 'https://kudominoes-rooms.renegue1256.workers.dev';

/** the published web build; share links always point here (also from the Android app) */
export const WEB_URL = 'https://rene-guerrero.github.io/kudominoes/';

/** set when a local host (not GitHub Pages / the app) served this page */
export function served(): LocalServed | null {
  return typeof window === 'undefined' ? null : localServed('kudominoes');
}

/** online (internet room server) or local (a host on the same network) */
export type NetMode = 'online' | 'local';

export function serverUrl(): string {
  if (served()) return location.origin;
  const env = (import.meta.env.VITE_MP_URL as string | undefined)?.trim();
  if (env) return env.replace(/\/+$/, '');
  if (import.meta.env.DEV) return `http://${location.hostname || 'localhost'}:8787`;
  return MP_SERVER_URL;
}

/** dev only: `?mpmock=1` runs an in-browser room server (no network; tabs talk over BroadcastChannel) */
export function useMockServer(): boolean {
  return import.meta.env.DEV && new URLSearchParams(location.search).has('mpmock');
}

/** the link a player shares: opens the game and joins the room */
export function shareLink(code: string): string {
  const local = served();
  if (local) return `${joinOrigin(local)}/?sala=${code}`;
  if (import.meta.env.DEV) {
    const u = new URL(location.href);
    u.search = '';
    u.hash = '';
    u.searchParams.set('sala', code);
    if (useMockServer()) u.searchParams.set('mpmock', '1');
    return u.toString();
  }
  return `${WEB_URL}?sala=${code}`;
}

/** online play is offered only once a real server URL is configured (dev and env overrides always count) */
export function onlineAvailable(): boolean {
  if (served()) return false; // a local page plays with its host, not over the internet
  if (import.meta.env.DEV) return true;
  return !serverUrl().includes('<');
}

/**
 * "Jugar con amigos" (same Wi-Fi, no internet) is offered on a page a local host served. Dev: always (it
 * plays over the in-browser mock). The Android app hosts in phase 2.
 */
export function localPlayAvailable(): boolean {
  return !!served() || import.meta.env.DEV;
}
