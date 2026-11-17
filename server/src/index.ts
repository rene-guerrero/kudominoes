/**
 * Worker entry: routes the room API to one Durable Object per room code.
 *   POST /api/rooms                → { code }              (optional ?pid= makes that player the host)
 *   GET  /api/rooms/:code          → RoomInfoResponse
 *   GET  /api/rooms/:code/ws?pid=  → WebSocket (forwarded to the room)
 */
import type { CreateRoomResponse, RoomInfoResponse } from '../../src/net/protocol';
import type { Env } from './config';
import { generateCode, isValidPlayerId, normalizeCode } from './lobby';

export { Room } from './room';

const FIXED_ORIGINS = ['https://rene-guerrero.github.io', 'https://localhost', 'capacitor://localhost', 'http://localhost'];

export function originAllowed(origin: string | null, env: Partial<Env>): boolean {
  if (!origin) return true; // native apps / server-to-server
  if (FIXED_ORIGINS.includes(origin)) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return true;
  // local network dev (vite --host on a phone): http://192.168.x.x:port
  if (/^http:\/\/(192\.168|10)\.\d+\.\d+(\.\d+)?(:\d+)?$/.test(origin)) return true;
  const extra = (env.KUDO_EXTRA_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return extra.includes(origin);
}

function cors(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('Origin');
  if (!origin || !originAllowed(origin, env)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (body: unknown, status: number, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

const stub = (env: Env, code: string) => env.ROOMS.get(env.ROOMS.idFromName(code));

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const h = cors(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });

    const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean); // ['api','rooms',code?,'ws'?]
    if (parts[0] !== 'api' || parts[1] !== 'rooms') {
      if (url.pathname === '/' || url.pathname === '/health') return json({ ok: true, service: 'kudominoes-rooms' }, 200, h);
      return json({ error: 'not_found' }, 404, h);
    }

    // POST /api/rooms — create a room under a fresh code (the room object itself refuses a taken code)
    if (parts.length === 2) {
      if (req.method !== 'POST') return json({ error: 'method' }, 405, h);
      const pid = url.searchParams.get('pid');
      for (let i = 0; i < 12; i++) {
        const code = generateCode(() => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296);
        const qs = new URLSearchParams({ code });
        if (pid && isValidPlayerId(pid)) qs.set('host', pid);
        const res = await stub(env, code).fetch(`https://room/init?${qs}`, { method: 'POST' });
        if (res.status === 201) return json({ code } satisfies CreateRoomResponse, 201, h);
        if (res.status !== 409) return json({ error: 'create_failed' }, 500, h);
      }
      return json({ error: 'no_free_code' }, 503, h);
    }

    const code = normalizeCode(decodeURIComponent(parts[2]));
    if (!code) {
      if (parts.length === 3 && req.method === 'GET') return json({ exists: false } satisfies RoomInfoResponse, 200, h);
      return json({ error: 'bad_code' }, 400, h);
    }

    // GET /api/rooms/:code
    if (parts.length === 3 && req.method === 'GET') {
      const res = await stub(env, code).fetch('https://room/info');
      return json(await res.json(), 200, h);
    }

    // GET /api/rooms/:code/ws
    if (parts.length === 4 && parts[3] === 'ws') {
      if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'expected_websocket' }, 426, h);
      if (!originAllowed(req.headers.get('Origin'), env)) return new Response('origin not allowed', { status: 403 });
      const target = new URL(`https://room/ws`);
      const pid = url.searchParams.get('pid');
      if (pid) target.searchParams.set('pid', pid);
      return stub(env, code).fetch(new Request(target.toString(), req));
    }

    return json({ error: 'not_found' }, 404, h);
  },
} satisfies ExportedHandler<Env>;
