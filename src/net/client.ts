/**
 * Connection manager for one online room: HTTP (create / check a room), one WebSocket, `hello` on every
 * (re)connect, automatic reconnection with backoff, ping/pong for the server clock offset (turn
 * deadlines are server epoch ms) and a clean `leave`.
 *
 * The transport is pluggable (Backend): the real one talks to the room server; the dev mock
 * (src/net/mock) runs the protocol in the browser.
 */
import type { ClientMsg, CreateRoomResponse, ErrorCode, RoomInfoResponse, ServerMsg } from './protocol';
import { PROTOCOL_VERSION } from './protocol';
import { serverUrl } from './config';

/** the small part of a WebSocket the client uses */
export interface Conn {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((data: string) => void) | null;
  onclose: ((code: number) => void) | null;
}

export interface Backend {
  /** the creator becomes the host */
  createRoom(playerId: string): Promise<string>;
  roomInfo(code: string): Promise<RoomInfoResponse>;
  connect(code: string, playerId: string): Conn;
}

/** a request that could not reach the server at all (offline, server down) */
export class NetError extends Error {
  constructor(readonly code: 'offline' | ErrorCode | 'server') {
    super(code);
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  } catch {
    throw new NetError('offline');
  }
  if (res.status === 404) throw new NetError('room_not_found');
  if (!res.ok) throw new NetError('server');
  try {
    return (await res.json()) as T;
  } catch {
    throw new NetError('server');
  }
}

export function httpBackend(base = serverUrl()): Backend {
  return {
    async createRoom(pid) {
      const r = await fetchJson<CreateRoomResponse>(`${base}/api/rooms?pid=${encodeURIComponent(pid)}`, { method: 'POST', body: '{}' });
      return r.code;
    },
    async roomInfo(code) {
      try {
        return await fetchJson<RoomInfoResponse>(`${base}/api/rooms/${code}`);
      } catch (e) {
        if (e instanceof NetError && e.code === 'room_not_found') return { exists: false };
        throw e;
      }
    },
    connect(code, pid) {
      const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/rooms/${code}/ws?pid=${encodeURIComponent(pid)}`);
      const conn: Conn = {
        send: (d) => ws.readyState === WebSocket.OPEN && ws.send(d),
        close: (c, r) => {
          try {
            ws.close(c, r);
          } catch {
            /* already closed */
          }
        },
        onopen: null,
        onmessage: null,
        onclose: null,
      };
      ws.onopen = () => conn.onopen?.();
      ws.onmessage = (e) => typeof e.data === 'string' && conn.onmessage?.(e.data);
      ws.onclose = (e) => conn.onclose?.(e.code);
      // errors are always followed by close
      return conn;
    },
  };
}

export type ConnState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface Identity {
  playerId: string;
  name: string;
  face: number;
}

export interface ClientOpts {
  backend: Backend;
  code: string;
  identity: () => Identity;
  onMessage: (msg: ServerMsg) => void;
  onState?: (s: ConnState) => void;
  /** a fatal error (room gone / full / wrong version): the client stopped and will not reconnect */
  onFatal?: (code: ErrorCode) => void;
  /** timers (injectable for tests) */
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
  random?: () => number;
}

const FATAL: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['room_not_found', 'room_full', 'version_mismatch']);
const PING_MS = 10_000;
/** no message at all for this long = the socket is dead (mobile networks drop silently) */
const DEAD_MS = 25_000;
const BACKOFF = [400, 900, 1800, 3500, 6000, 9000];

export class RoomClient {
  readonly code: string;
  private o: ClientOpts;
  private conn: Conn | null = null;
  private state: ConnState = 'connecting';
  private attempt = 0;
  private stopped = false;
  private retryTimer: unknown = null;
  private pingTimer: unknown = null;
  private deadTimer: unknown = null;
  /** serverNow - localNow, from the lowest-RTT pong seen on this connection */
  private offset = 0;
  private bestRtt = Infinity;
  private now: () => number;
  private st: (fn: () => void, ms: number) => unknown;
  private ct: (h: unknown) => void;

  constructor(o: ClientOpts) {
    this.o = o;
    this.code = o.code;
    this.now = o.now ?? (() => Date.now());
    this.st = o.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.ct = o.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get connState(): ConnState {
    return this.state;
  }

  /** server epoch ms now (estimated) */
  serverNow(): number {
    return this.now() + this.offset;
  }

  /** a server epoch time as local Date.now() time */
  toLocal(serverMs: number): number {
    return serverMs - this.offset;
  }

  get clockOffset(): number {
    return this.offset;
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  send(msg: ClientMsg): boolean {
    if (!this.conn || this.state !== 'open') return false;
    this.conn.send(JSON.stringify(msg));
    return true;
  }

  /** leave the room for good: tell the server, close, never reconnect */
  leave(): void {
    if (this.stopped) return;
    this.send({ t: 'leave' });
    this.stop();
  }

  /** stop without telling the server (e.g. a fatal error) */
  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const c = this.conn;
    this.conn = null;
    if (c) {
      c.onclose = null;
      c.onmessage = null;
      c.close(1000, 'leave');
    }
    this.setState('closed');
  }

  /**
   * Drop the socket and connect again right away (the server answers hello with a full snapshot):
   * used to catch up after the tab was in the background, or when the client is out of sync.
   */
  resync(): void {
    if (this.stopped) return;
    this.attempt = 0;
    this.dropConn();
    this.open();
  }

  /** the network came back / the app is visible again: if we are waiting to retry, retry now */
  nudge(): void {
    if (this.stopped || this.state === 'open' || this.state === 'connecting') return;
    if (this.retryTimer) this.ct(this.retryTimer);
    this.retryTimer = null;
    this.open();
  }

  private setState(s: ConnState): void {
    if (this.state === s) return;
    this.state = s;
    this.o.onState?.(s);
  }

  private clearTimers(): void {
    for (const h of [this.retryTimer, this.pingTimer, this.deadTimer]) if (h) this.ct(h);
    this.retryTimer = this.pingTimer = this.deadTimer = null;
  }

  private dropConn(): void {
    this.clearTimers();
    const c = this.conn;
    this.conn = null;
    if (c) {
      c.onclose = null;
      c.onmessage = null;
      c.onopen = null;
      c.close(4000, 'resync');
    }
  }

  private open(): void {
    if (this.stopped) return;
    this.setState(this.attempt === 0 && this.state !== 'reconnecting' ? 'connecting' : 'reconnecting');
    let c: Conn;
    try {
      c = this.o.backend.connect(this.code, this.o.identity().playerId);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.conn = c;
    this.bestRtt = Infinity;
    c.onopen = () => {
      if (this.conn !== c) return;
      const id = this.o.identity();
      c.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, playerId: id.playerId, name: id.name, face: id.face } satisfies ClientMsg));
      this.ping();
      this.armDead();
    };
    c.onmessage = (data) => {
      if (this.conn !== c) return;
      this.armDead();
      let msg: ServerMsg;
      try {
        msg = JSON.parse(data) as ServerMsg;
      } catch {
        return;
      }
      this.onServer(msg);
    };
    c.onclose = () => {
      if (this.conn !== c) return;
      this.conn = null;
      this.clearTimers();
      if (!this.stopped) this.scheduleRetry();
    };
    // a socket that never opens (server down) still ends in onclose; guard a hang too
    this.armDead();
  }

  private onServer(msg: ServerMsg): void {
    if (msg.t === 'pong') {
      const t = this.now();
      const rtt = Math.max(0, t - msg.at);
      if (rtt <= this.bestRtt) {
        this.bestRtt = rtt;
        this.offset = msg.serverNow + rtt / 2 - t;
      }
      return;
    }
    if (msg.t === 'welcome' || msg.t === 'sync') {
      this.attempt = 0;
      this.setState('open');
    }
    if (msg.t === 'error' && FATAL.has(msg.code)) {
      this.stop();
      this.o.onFatal?.(msg.code);
      return;
    }
    this.o.onMessage(msg);
  }

  private ping(): void {
    if (!this.conn) return;
    this.conn.send(JSON.stringify({ t: 'ping', at: this.now() } satisfies ClientMsg));
    if (this.pingTimer) this.ct(this.pingTimer);
    this.pingTimer = this.st(() => this.ping(), PING_MS);
  }

  private armDead(): void {
    if (this.deadTimer) this.ct(this.deadTimer);
    this.deadTimer = this.st(() => {
      this.deadTimer = null;
      if (this.stopped) return;
      this.dropConn();
      this.scheduleRetry();
    }, DEAD_MS);
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    this.setState('reconnecting');
    const base = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)];
    this.attempt++;
    const jitter = base * 0.25 * ((this.o.random ?? Math.random)() - 0.5);
    if (this.retryTimer) this.ct(this.retryTimer);
    this.retryTimer = this.st(() => {
      this.retryTimer = null;
      this.open();
    }, base + jitter);
  }
}
