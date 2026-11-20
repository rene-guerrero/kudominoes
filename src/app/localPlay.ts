/**
 * Jugar con amigos in the Android app: this phone hosts the room (the same RoomCore the Worker runs)
 * and serves the game on its Wi-Fi / hotspot address through the KuLocal plugin, or it joins a game
 * another phone hosts. The room is saved after every change, so "Reanudar la partida anterior" can bring
 * it back after the app was closed.
 */
import { LocalHost, loopbackBackend } from 'kunet';
import type { Backend } from '../net/client';
import { discoverHosts, keepAwake, nativeBackend, nativeLocalAvailable, startWifiHost, type NearbyHost, type WifiHost } from 'kunet/native';
import { CODE_RULES, GAME_ID, makeCore, normalizeCode } from '../net/room/local';

const SAVE_KEY = 'kudominoes.localRoom.v1';
/** a saved room older than this is not offered any more */
const RESUME_MAX_AGE_MS = 12 * 60 * 60_000;

interface Saved {
  code: string;
  at: number;
  data: unknown;
}

export { nativeLocalAvailable, type NearbyHost };

export class LocalPlay {
  private host: LocalHost | null = null;
  private wifi: WifiHost | null = null;
  private starting: Promise<WifiHost> | null = null;

  get hosting(): boolean {
    return !!this.wifi;
  }

  /** origins other devices open (best first) */
  get origins(): string[] {
    return this.wifi?.origins ?? [];
  }

  private ensureHost(): LocalHost {
    this.host ??= new LocalHost(makeCore, {
      codes: CODE_RULES,
      maxRooms: 4,
      onRoomChange: (code, data) => (data ? save(code, data) : forget(code)),
    });
    return this.host;
  }

  /** start serving on the network; the backend is this phone's own player (in-memory loopback) */
  async startHosting(name: string): Promise<Backend> {
    const host = this.ensureHost();
    if (!this.wifi) {
      this.starting ??= startWifiHost(host, { game: GAME_ID, name, normalizeCode: (s) => normalizeCode(s) ?? '' });
      try {
        this.wifi = await this.starting;
      } finally {
        this.starting = null;
      }
      void keepAwake(true);
    }
    // (kunet carries this game's own frames: its rooms answer this game's RoomInfoResponse)
    return loopbackBackend(host) as unknown as Backend;
  }

  /** bring back the saved room (call startHosting first); returns its code */
  resumeSaved(): string | null {
    const s = savedRoom();
    if (!s || !this.host) return null;
    this.host.resumeRoom(s.code, s.data);
    return s.code;
  }

  /** shown in "Partidas cercanas" on other phones */
  announce(code: string): void {
    void this.wifi?.advertise(code);
  }

  /** the link a joiner opens (null = this phone has no Wi-Fi / hotspot address) */
  joinUrl(code: string): string | null {
    const o = this.origins[0];
    return o ? `${o}/?sala=${code}` : null;
  }

  /** the host leaves: the room ends for everyone */
  async stopHosting(): Promise<void> {
    const wifi = this.wifi;
    this.wifi = null;
    this.host?.stop();
    this.host = null;
    void keepAwake(false);
    await wifi?.stop();
  }

  /** back from the background: run the timers that came due meanwhile */
  wake(): void {
    this.host?.wake();
  }

  joinBackend(origin: string): Backend {
    return nativeBackend(origin) as unknown as Backend;
  }

  discover(onChange: (games: NearbyHost[]) => void): () => void {
    return discoverHosts(GAME_ID, onChange);
  }
}

// ───────────────────────── saved room ─────────────────────────

function save(code: string, data: unknown): void {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ code, at: Date.now(), data } satisfies Saved));
  } catch {
    /* storage full / private: no resume */
  }
}

function forget(code: string): void {
  try {
    const s = JSON.parse(localStorage.getItem(SAVE_KEY) ?? 'null') as Saved | null;
    if (!s || s.code === code) localStorage.removeItem(SAVE_KEY);
  } catch {
    /* ignore */
  }
}

/** a recent saved room with a match in it (a lobby is quicker to create again) */
export function savedRoom(): Saved | null {
  try {
    const s = JSON.parse(localStorage.getItem(SAVE_KEY) ?? 'null') as Saved | null;
    if (!s || typeof s.code !== 'string' || Date.now() - s.at > RESUME_MAX_AGE_MS) return null;
    const phase = (s.data as { phase?: string } | null)?.phase;
    return phase === 'playing' ? s : null;
  } catch {
    return null;
  }
}
