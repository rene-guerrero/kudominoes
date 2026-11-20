/**
 * Kudominoes' room core for kunet's local hosts (the Node dev host, the Android Wi-Fi host, the
 * hosting device's own loopback): the same RoomCore the Durable Object runs, with the default timers.
 */
import type { CodeRules, MakeCore } from 'kunet';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../protocol';
import { DEFAULT_TUNABLES, RoomCore } from './core';
import { normalizeCode, type RoomData } from './lobby';

export const GAME_ID = 'kudominoes';

export const makeCore: MakeCore = (io, data) => new RoomCore(io, DEFAULT_TUNABLES, (data as RoomData | null) ?? null);

export const CODE_RULES: CodeRules = { alphabet: ROOM_CODE_ALPHABET, length: ROOM_CODE_LENGTH };

export { normalizeCode };
