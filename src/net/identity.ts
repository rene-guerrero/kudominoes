/**
 * Who this device is online (no accounts): a random player id generated once and kept in localStorage,
 * plus helpers for room codes ("7KQM", shown as KUDO-7KQM).
 */
import { MAX_NAME_LENGTH, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from './protocol';

const PID_KEY = 'kudominoes.playerId.v1';
/** the room this tab is in (sessionStorage: a reload rejoins, a new tab does not) */
const ROOM_KEY = 'kudominoes.room.v1';

function randomId(): string {
  const a = new Uint8Array(12);
  (globalThis.crypto ?? ({ getRandomValues: (x: Uint8Array) => x.map(() => Math.floor(Math.random() * 256)) } as Crypto)).getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

let memPid: string | null = null;

export function playerId(): string {
  try {
    // dev only: `?newpid=1` gives this tab its own identity, so two tabs of one browser can play together
    if (import.meta.env.DEV && (new URLSearchParams(location.search).has('newpid') || sessionStorage.getItem('kudominoes.devpid'))) {
      let d = sessionStorage.getItem('kudominoes.devpid');
      if (!d) sessionStorage.setItem('kudominoes.devpid', (d = randomId()));
      return d;
    }
    let id = localStorage.getItem(PID_KEY);
    if (!id || !/^[0-9a-f]{8,64}$/.test(id)) {
      id = randomId();
      localStorage.setItem(PID_KEY, id);
    }
    return id;
  } catch {
    memPid ??= randomId();
    return memPid;
  }
}

/** keep only code characters, upper-cased; "kudo-7kqm" / "7kqm" → "7KQM" ('' if not a full code) */
export function normalizeCode(raw: string | null | undefined): string {
  if (!raw) return '';
  let s = raw.toUpperCase().replace(/\s+/g, '');
  if (s.startsWith('KUDO-')) s = s.slice(5);
  else if (s.startsWith('KUDO') && s.length > ROOM_CODE_LENGTH) s = s.slice(4);
  s = filterCodeChars(s);
  return s.length === ROOM_CODE_LENGTH ? s : '';
}

/** typing filter for the code input: upper-case, alphabet only (O→0? no: ambiguous letters are dropped) */
export function filterCodeChars(s: string): string {
  let out = '';
  for (const ch of s.toUpperCase()) if (ROOM_CODE_ALPHABET.includes(ch)) out += ch;
  return out.slice(0, ROOM_CODE_LENGTH);
}

export const displayCode = (code: string) => `KUDO-${code}`;

export function cleanName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

export function rememberRoom(code: string | null): void {
  try {
    if (code) sessionStorage.setItem(ROOM_KEY, code);
    else sessionStorage.removeItem(ROOM_KEY);
  } catch {
    /* private mode: no auto-rejoin after a reload */
  }
}

export function rememberedRoom(): string {
  try {
    return normalizeCode(sessionStorage.getItem(ROOM_KEY));
  } catch {
    return '';
  }
}
