/**
 * Jugar con amigos in the Android app: this phone hosts the room (the same RoomCore the Worker runs)
 * and other phones join it over Wi-Fi (the KuLocal plugin serves the game on the phone's Wi-Fi / hotspot
 * address) and over Bluetooth (Nearby Connections), both at once; or this phone joins a game another
 * phone hosts. The room is saved after every change, so "Reanudar la partida anterior" can bring it back
 * after the app was closed.
 */
import { LocalHost, loopbackBackend } from 'kunet';
import type { Backend } from '../net/client';
import {
  discoverHosts,
  discoverNearby,
  keepAwake,
  nativeBackend,
  nativeLocalAvailable,
  nearbyBackend,
  nearbyDisconnectAll,
  nearbyPermission,
  onNearbyError,
  locationEnabled,
  openLocationSettings,
  isLocationError,
  startNearbyHost,
  startWifiHost,
  type NearbyHostHandle,
  type WifiHost,
} from 'kunet/native';
import { CODE_RULES, GAME_ID, makeCore, normalizeCode } from '../net/room/local';
import type { NearbyGame } from '../ui/online';

const SAVE_KEY = 'kudominoes.localRoom.v1';
/** a saved room older than this is not offered any more */
const RESUME_MAX_AGE_MS = 12 * 60 * 60_000;

interface Saved {
  code: string;
  at: number;
  data: unknown;
}

export { nativeLocalAvailable, nearbyPermission, onNearbyError, locationEnabled, openLocationSettings, isLocationError };

export class LocalPlay {
  private host: LocalHost | null = null;
  private wifi: WifiHost | null = null;
  private bt: NearbyHostHandle | null = null;
  private joinedBt = false;

  get hosting(): boolean {
    return !!this.wifi || !!this.bt;
  }

  /** origins other devices open (best first); empty = no Wi-Fi / hotspot address */
  get origins(): string[] {
    return this.wifi?.origins ?? [];
  }

  /** other phones can find this room over Bluetooth */
  get bluetooth(): boolean {
    return !!this.bt;
  }

  private ensureHost(): LocalHost {
    this.host ??= new LocalHost(makeCore, {
      codes: CODE_RULES,
      maxRooms: 4,
      onRoomChange: (code, data) => (data ? save(code, data) : forget(code)),
    });
    return this.host;
  }

  /**
   * Start hosting: the Wi-Fi server always, Bluetooth too when `bluetooth` (permission already granted).
   * The backend is this phone's own player (in-memory loopback).
   */
  async startHosting(name: string, bluetooth: boolean): Promise<Backend> {
    const host = this.ensureHost();
    const norm = (s: string) => normalizeCode(s) ?? '';
    if (!this.wifi) {
      try {
        this.wifi = await startWifiHost(host, { game: GAME_ID, name, normalizeCode: norm });
      } catch (e) {
        if (!bluetooth) throw e;
        console.warn('[local] no Wi-Fi server, Bluetooth only', e);
      }
    }
    if (bluetooth && !this.bt) {
      try {
        this.bt = await startNearbyHost(host, { game: GAME_ID, name, normalizeCode: norm });
      } catch (e) {
        console.warn('[local] Bluetooth hosting unavailable', e);
      }
    }
    if (!this.wifi && !this.bt) throw new Error('start');
    void keepAwake(true);
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

  /** shown in "Partidas cercanas" on other phones (Wi-Fi and Bluetooth) */
  announce(code: string): void {
    void this.wifi?.advertise(code);
    void this.bt?.advertise(code);
  }

  /** the link a joiner opens (null = this phone has no Wi-Fi / hotspot address) */
  joinUrl(code: string): string | null {
    const o = this.origins[0];
    return o ? `${o}/?sala=${code}` : null;
  }

  /** the host leaves: the room ends for everyone */
  async stopHosting(): Promise<void> {
    const wifi = this.wifi;
    const bt = this.bt;
    this.wifi = null;
    this.bt = null;
    this.host?.stop();
    this.host = null;
    void keepAwake(false);
    await wifi?.stop();
    await bt?.stop();
  }

  /** back from the background: run the timers that came due meanwhile */
  wake(): void {
    this.host?.wake();
  }

  /** join a game another phone hosts: over Wi-Fi (its address) or Bluetooth */
  joinBackend(game: NearbyGame | { origin: string }, myName: string): Backend {
    if ('via' in game && game.via === 'bluetooth' && game.endpoint) {
      this.joinedBt = true;
      return nearbyBackend(GAME_ID, { id: game.endpoint, code: game.code, name: game.name }, myName) as unknown as Backend;
    }
    return nativeBackend(game.origin) as unknown as Backend;
  }

  /** a joiner left the room: drop the Bluetooth link */
  leaveJoined(): void {
    if (!this.joinedBt) return;
    this.joinedBt = false;
    void nearbyDisconnectAll();
  }

  /**
   * Games nearby: Wi-Fi (NSD) always, Bluetooth when allowed. A room found both ways is listed once,
   * over Wi-Fi (faster). Returns a stop function.
   */
  discover(bluetooth: boolean, onChange: (games: NearbyGame[]) => void): () => void {
    let wifi: NearbyGame[] = [];
    let bt: NearbyGame[] = [];
    const emit = () => {
      const codes = new Set(wifi.map((g) => g.code));
      onChange([...wifi, ...bt.filter((g) => !codes.has(g.code))]);
    };
    const stopWifi = discoverHosts(GAME_ID, (hosts) => {
      wifi = hosts.map((h) => ({ key: `w:${h.key}`, name: h.name, code: h.code, origin: h.origin, via: 'wifi' as const }));
      emit();
    });
    const stopBt = bluetooth
      ? discoverNearby(GAME_ID, (games) => {
          bt = games.map((g) => ({ key: `b:${g.id}`, name: g.name, code: g.code, origin: '', via: 'bluetooth' as const, endpoint: g.id }));
          emit();
        })
      : () => {};
    return () => {
      stopWifi();
      stopBt();
    };
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
