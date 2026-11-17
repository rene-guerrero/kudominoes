/**
 * Online play: where the room server lives, and the share link.
 *
 * Order: `VITE_MP_URL` (build-time env) → dev: the same host on port 8787 (`npx wrangler dev`) →
 * production: MP_SERVER_URL below.
 */

// deployed room server (server/, `npx wrangler deploy`)
export const MP_SERVER_URL = 'https://kudominoes-rooms.renegue1256.workers.dev';

/** the published web build; share links always point here (also from the Android app) */
export const WEB_URL = 'https://rene-guerrero.github.io/kudominoes/';

export function serverUrl(): string {
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
  if (import.meta.env.DEV) return true;
  return !serverUrl().includes('<');
}
