/**
 * Kudominoes' room core for kunet's local hosts (the Node dev host, the Android Wi-Fi host, the
 * hosting device's own loopback): the same RoomCore the Durable Object runs, with the default timers.
 */
import type { CodeRules, MakeCore } from 'kunet';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../protocol';
import { DEFAULT_TUNABLES, RoomCore } from './core';
import { normalizeCode, type RoomData } from './lobby';

export const GAME_ID = 'kudominoes';

export const makeCore: MakeCore = (io, data) => new RoomCore(io, DEFAULT_TUNABLES, data ? resumed(data as RoomData, io.now()) : null);

/**
 * A saved room coming back after the host app restarted: nobody is connected any more. Everyone gets
 * the usual grace period to come back (then a CPU covers their seat), and the turn clock restarts when
 * the first player is back.
 */
function resumed(r: RoomData, now: number): RoomData {
  const out: RoomData = JSON.parse(JSON.stringify(r));
  for (const m of Object.values(out.members)) {
    if (!m.connected) continue;
    m.connected = false;
    out.schedule.grace[m.playerId] = now + DEFAULT_TUNABLES.graceMs;
  }
  out.schedule.game = null;
  out.schedule.idle = now + DEFAULT_TUNABLES.idleTtlMs;
  return out;
}

export const CODE_RULES: CodeRules = { alphabet: ROOM_CODE_ALPHABET, length: ROOM_CODE_LENGTH };

export { normalizeCode };
