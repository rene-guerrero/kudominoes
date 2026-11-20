/**
 * One Durable Object per room (SQLite-backed, WebSocket Hibernation API). The room logic is RoomCore
 * (src/net/room/core.ts, shared with the dev mock room and local play); this class only adapts it to
 * the platform.
 *
 * Persistence: the whole room (lobby, MatchState, timer schedule) is one small JSON value under the
 * storage key 'room'. It is loaded in the constructor (which also runs when the object wakes from
 * hibernation) and written after every change, so nothing important lives only in memory. Per-socket
 * identity is in the socket attachment (survives hibernation). Only the phrase rate limiter is
 * in-memory (losing it on hibernation is harmless).
 *
 * Timers: one alarm per object, set to the earliest entry of RoomData.schedule (turn deadline / CPU
 * think delay / next deal, per-player disconnect grace, idle deletion).
 */
import { DurableObject } from 'cloudflare:workers';
import { RoomCore, type Attachment } from '../../src/net/room/core';
import type { RoomData } from '../../src/net/room/lobby';
import { tunables, type Env } from './config';

export class Room extends DurableObject<Env> {
  private core: RoomCore<WebSocket>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = new RoomCore<WebSocket>(
      {
        now: () => Date.now(),
        seed: () => crypto.getRandomValues(new Uint32Array(1))[0] | 0,
        sockets: () => this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN),
        attachment: (ws) => (ws.deserializeAttachment() as Attachment | null) ?? null,
        setAttachment: (ws, a) => ws.serializeAttachment(a),
        send: (ws, msg) => {
          try {
            ws.send(JSON.stringify(msg));
          } catch {
            /* socket going away */
          }
        },
        close: (ws, code, reason) => {
          try {
            ws.close(code, reason);
          } catch {
            /* already closed */
          }
        },
      },
      tunables(env),
    );
    ctx.blockConcurrencyWhile(async () => {
      this.core.data = (await ctx.storage.get<RoomData>('room')) ?? null;
    });
  }

  // ───────────────────────── HTTP (from the Worker) ─────────────────────────

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server);
      this.core.accept(server, url.searchParams.get('pid'));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === '/init' && req.method === 'POST') {
      if (!this.core.create(url.searchParams.get('code') ?? '', url.searchParams.get('host'))) return new Response('exists', { status: 409 });
      await this.save();
      return new Response('created', { status: 201 });
    }
    if (url.pathname === '/info') return Response.json(this.core.info());
    return new Response('not found', { status: 404 });
  }

  // ───────────────────────── WebSocket handlers ─────────────────────────

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    this.core.message(ws, raw);
    await this.save();
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      /* already closed */
    }
    this.core.socketGone(ws);
    await this.save();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.core.socketGone(ws);
    await this.save();
  }

  // ───────────────────────── alarm ─────────────────────────

  async alarm(): Promise<void> {
    if (this.core.alarm() === 'deleted') {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.save();
  }

  private async save(): Promise<void> {
    const r = this.core.data;
    if (!r) return;
    await this.ctx.storage.put('room', r);
    const at = this.core.nextAlarm();
    if (at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(at, Date.now() + 1));
  }
}
