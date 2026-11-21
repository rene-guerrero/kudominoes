/**
 * DEV ONLY (`?mpmock=1`) — an in-browser room: the real room logic (src/net/room/core.ts, the same code
 * the Durable Object runs) with setTimeout as its single alarm and in-page sockets, so the online UI can
 * be built and clicked through without wrangler. Lazily imported, never in production builds.
 */
import type { PublicRoom, RoomInfoResponse, ServerMsg } from '../protocol';
import { DEFAULT_TUNABLES, RoomCore, type Attachment } from '../room/core';

/** the mock server's clock runs ahead of the browser's, to exercise the client's clock offset */
export const MOCK_SKEW_MS = 2500;

export interface MockSocket {
  send(msg: ServerMsg): void;
  close(): void;
}

interface Entry {
  att: Attachment | null;
  open: boolean;
}

export class MockRoom {
  private socks = new Map<MockSocket, Entry>();
  private core: RoomCore<MockSocket>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** the room is gone (idle clean-up): the hub forgets it */
  onEmpty: (() => void) | null = null;

  constructor(
    readonly code: string,
    host = '',
  ) {
    this.core = new RoomCore<MockSocket>(
      {
        now: () => Date.now() + MOCK_SKEW_MS,
        seed: () => (Math.random() * 0x7fffffff) | 0,
        sockets: () => [...this.socks].filter(([, e]) => e.open).map(([s]) => s),
        attachment: (s) => this.socks.get(s)?.att ?? null,
        setAttachment: (s, a) => {
          const e = this.socks.get(s);
          if (e) e.att = a;
        },
        send: (s, msg) => {
          if (this.socks.get(s)?.open) s.send(msg);
        },
        close: (s) => {
          const e = this.socks.get(s);
          if (!e || !e.open) return;
          e.open = false;
          s.close();
        },
      },
      { ...DEFAULT_TUNABLES, idleTtlMs: 5 * 60_000 },
    );
    this.core.create(code, host);
    this.arm();
  }

  get phase(): PublicRoom['phase'] | null {
    return this.core.data?.phase ?? null;
  }

  info(): RoomInfoResponse {
    return this.core.info();
  }

  attach(sock: MockSocket): void {
    this.socks.set(sock, { att: null, open: true });
    this.core.accept(sock, null);
    this.arm();
  }

  detach(sock: MockSocket): void {
    const e = this.socks.get(sock);
    if (!e) return;
    e.open = false;
    this.core.socketGone(sock);
    this.socks.delete(sock);
    this.arm();
  }

  receive(sock: MockSocket, raw: string): void {
    if (!this.socks.get(sock)?.open) return;
    this.core.message(sock, raw);
    this.arm();
  }

  /** the single alarm, like the Durable Object's */
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const at = this.core.nextAlarm();
    if (at === null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.core.alarm() === 'deleted') return this.onEmpty?.();
      this.arm();
    }, Math.max(1, at - (Date.now() + MOCK_SKEW_MS)));
  }
}
