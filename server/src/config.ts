/**
 * Server tunables. The protocol constants are the defaults; tests (and only tests) shorten them via
 * Worker vars, e.g. `wrangler dev --var KUDO_TURN_TIMEOUT_MS:1500`.
 */
import { DEFAULT_TUNABLES, type Tunables } from '../../src/net/room/core';

export type { Tunables };

export interface Env {
  ROOMS: DurableObjectNamespace;
  KUDO_TURN_TIMEOUT_MS?: string;
  KUDO_GRACE_MS?: string;
  KUDO_IDLE_TTL_MS?: string;
  /** pause between the end of a hand and the next deal (clients show the hand summary meanwhile) */
  KUDO_NEXT_HAND_MS?: string;
  /** multiplier on CPU think delays (1 = like the local game; tests use ~0.05) */
  KUDO_CPU_SPEED?: string;
  /** comma-separated extra allowed CORS / WebSocket origins */
  KUDO_EXTRA_ORIGINS?: string;
}

const num = (v: string | undefined, d: number, min = 0): number => {
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) && n >= min ? n : d;
};

export function tunables(env: Partial<Env>): Tunables {
  const d = DEFAULT_TUNABLES;
  return {
    turnTimeoutMs: num(env.KUDO_TURN_TIMEOUT_MS, d.turnTimeoutMs, 200),
    graceMs: num(env.KUDO_GRACE_MS, d.graceMs, 0),
    idleTtlMs: num(env.KUDO_IDLE_TTL_MS, d.idleTtlMs, 1000),
    nextHandMs: num(env.KUDO_NEXT_HAND_MS, d.nextHandMs, 0),
    cpuSpeed: num(env.KUDO_CPU_SPEED, d.cpuSpeed, 0),
  };
}
