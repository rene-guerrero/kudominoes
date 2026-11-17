/**
 * DEV ONLY (`?mpmock=1`): a Backend that runs rooms in the browser. The tab that creates a room hosts
 * it (MockRoom, real engine); other tabs of the same origin reach it over a BroadcastChannel, so two
 * tabs can play together. A small delay mimics the network. Closing the hosting tab ends the room.
 */
import type { Backend, Conn } from '../client';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, type RoomInfoResponse, type ServerMsg } from '../protocol';
import { MockRoom, type MockSocket } from './room';

const LATENCY = 25;
type Wire =
  | { k: 'info?'; code: string; rid: string }
  | { k: 'info'; rid: string; info: RoomInfoResponse }
  | { k: 'open'; code: string; cid: string }
  | { k: 'c2s'; cid: string; data: string }
  | { k: 's2c'; cid: string; data: string }
  | { k: 'close'; cid: string; from: 'client' | 'server' };

const uid = () => Math.random().toString(36).slice(2, 10);

class Hub {
  private rooms = new Map<string, MockRoom>();
  private ch: BroadcastChannel | null = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('kudo-mpmock') : null;
  /** server side: sockets of remote clients, by connection id */
  private remote = new Map<string, { room: MockRoom; sock: MockSocket }>();
  /** client side: my connections to rooms in other tabs */
  private mine = new Map<string, Conn>();
  private infoWait = new Map<string, (i: RoomInfoResponse) => void>();

  constructor() {
    this.ch?.addEventListener('message', (e) => this.onWire(e.data as Wire));
    // the hosting tab goes away: tell its remote clients their connection dropped
    window.addEventListener('pagehide', () => {
      for (const cid of this.remote.keys()) this.post({ k: 'close', cid, from: 'server' });
    });
  }

  private post(w: Wire): void {
    this.ch?.postMessage(w);
  }

  createRoom(pid: string): string {
    let code = '';
    do {
      code = Array.from({ length: ROOM_CODE_LENGTH }, () => ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)]).join('');
    } while (this.rooms.has(code));
    const room = new MockRoom(code);
    room.hostId = pid;
    room.onEmpty = () => setTimeout(() => this.rooms.delete(code), 30_000);
    this.rooms.set(code, room);
    return code;
  }

  private localInfo(code: string): RoomInfoResponse | null {
    const r = this.rooms.get(code);
    if (!r) return null;
    const pr = r.publicRoom();
    const free = pr.seats.filter((o) => o.kind !== 'human').length;
    return { exists: true, phase: pr.phase, freeSeats: pr.phase === 'lobby' ? free : 0 };
  }

  roomInfo(code: string): Promise<RoomInfoResponse> {
    const local = this.localInfo(code);
    if (local) return Promise.resolve(local);
    return new Promise((resolve) => {
      const rid = uid();
      const t = setTimeout(() => {
        this.infoWait.delete(rid);
        resolve({ exists: false });
      }, 500);
      this.infoWait.set(rid, (i) => {
        clearTimeout(t);
        resolve(i);
      });
      this.post({ k: 'info?', code, rid });
    });
  }

  connect(code: string): Conn {
    const conn: Conn = { send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null };
    let closed = false;
    const fireClose = (c: number) => {
      if (closed) return;
      closed = true;
      setTimeout(() => conn.onclose?.(c), LATENCY);
    };
    const room = this.rooms.get(code);
    if (room) {
      // same tab: direct calls with a little latency
      const sock: MockSocket = {
        send: (msg: ServerMsg) => {
          const data = JSON.stringify(msg);
          setTimeout(() => !closed && conn.onmessage?.(data), LATENCY);
        },
        close: () => {
          room.detach(sock);
          fireClose(1000);
        },
      };
      conn.send = (d) => setTimeout(() => !closed && room.receive(sock, d), LATENCY);
      conn.close = (c = 1000) => {
        if (closed) return;
        room.detach(sock);
        fireClose(c);
      };
      setTimeout(() => {
        if (closed) return;
        room.attach(sock);
        conn.onopen?.();
      }, LATENCY);
      return conn;
    }
    // another tab hosts it (or nobody: the open times out like a dead server)
    const cid = uid();
    this.mine.set(cid, conn);
    conn.send = (d) => !closed && this.post({ k: 'c2s', cid, data: d });
    conn.close = (c = 1000) => {
      if (closed) return;
      this.post({ k: 'close', cid, from: 'client' });
      this.mine.delete(cid);
      fireClose(c);
    };
    (conn as Conn & { __remoteClose?: () => void }).__remoteClose = () => {
      this.mine.delete(cid);
      fireClose(1006);
    };
    this.post({ k: 'open', code, cid });
    return conn;
  }

  private onWire(w: Wire): void {
    switch (w.k) {
      case 'info?': {
        const i = this.localInfo(w.code);
        if (i) this.post({ k: 'info', rid: w.rid, info: i });
        break;
      }
      case 'info':
        this.infoWait.get(w.rid)?.(w.info);
        this.infoWait.delete(w.rid);
        break;
      case 'open': {
        const room = this.rooms.get(w.code);
        if (!room) break;
        const sock: MockSocket = {
          send: (msg) => this.post({ k: 's2c', cid: w.cid, data: JSON.stringify(msg) }),
          close: () => {
            room.detach(sock);
            this.remote.delete(w.cid);
            this.post({ k: 'close', cid: w.cid, from: 'server' });
          },
        };
        this.remote.set(w.cid, { room, sock });
        room.attach(sock);
        this.post({ k: 's2c', cid: w.cid, data: '__open__' });
        break;
      }
      case 'c2s': {
        const r = this.remote.get(w.cid);
        if (r) r.room.receive(r.sock, w.data);
        break;
      }
      case 's2c': {
        const c = this.mine.get(w.cid);
        if (!c) break;
        if (w.data === '__open__') c.onopen?.();
        else c.onmessage?.(w.data);
        break;
      }
      case 'close':
        if (w.from === 'client') {
          const r = this.remote.get(w.cid);
          if (r) {
            this.remote.delete(w.cid);
            r.room.detach(r.sock);
          }
        } else {
          const c = this.mine.get(w.cid) as (Conn & { __remoteClose?: () => void }) | undefined;
          c?.__remoteClose?.();
        }
        break;
    }
  }
}

let hub: Hub | null = null;

export function mockBackend(): Backend {
  hub ??= new Hub();
  const hb = hub;
  return {
    createRoom: async (pid) => hb.createRoom(pid),
    roomInfo: (code) => hb.roomInfo(code),
    connect: (code) => hb.connect(code),
  };
}
