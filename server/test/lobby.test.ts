import { describe, expect, it } from 'vitest';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../../src/net/protocol';
import {
  autoSeat,
  ensureHost,
  fillSeats,
  freeSeats,
  generateCode,
  LobbyError,
  newRoom,
  normalizeCode,
  publicRoom,
  removeMember,
  sanitizeName,
  seatOf,
  setCpu,
  setMode,
  setRules,
  sit,
  type RoomData,
} from '../src/lobby';

function join(r: RoomData, pid: string, now = 0): void {
  r.members[pid] = { playerId: pid, name: pid, face: 0, connected: true, cpuCovering: false, joinedAt: now };
  if (!r.hostId) r.hostId = pid;
  autoSeat(r, pid);
}

describe('room codes', () => {
  it('uses the protocol alphabet and length', () => {
    let x = 0;
    const rnd = () => ((x = (x * 9301 + 49297) % 233280), x / 233280);
    for (let i = 0; i < 500; i++) {
      const c = generateCode(rnd);
      expect(c).toHaveLength(ROOM_CODE_LENGTH);
      for (const ch of c) expect(ROOM_CODE_ALPHABET).toContain(ch);
    }
    expect(generateCode(() => 0.999999999)).toBe(ROOM_CODE_ALPHABET.at(-1)!.repeat(ROOM_CODE_LENGTH));
  });
  it('normalizes user input', () => {
    expect(normalizeCode('7kqm')).toBe('7KQM');
    expect(normalizeCode(' KUDO-7KQM ')).toBe('7KQM');
    expect(normalizeCode('kudo-7kqm')).toBe('7KQM');
    expect(normalizeCode('7KQ0')).toBeNull(); // 0 is not in the alphabet
    expect(normalizeCode('7KQMX')).toBeNull();
  });
});

describe('names', () => {
  it('trims, strips invisible characters and caps the length', () => {
    expect(sanitizeName('  Ana  ')).toBe('Ana');
    expect(sanitizeName('A‮B​C')).toBe('ABC');
    expect(sanitizeName('x'.repeat(40))).toHaveLength(16);
    expect(sanitizeName('')).toBe('Jugador');
    expect(sanitizeName(42)).toBe('Jugador');
  });
});

describe('seats and host', () => {
  it('auto-seats arrivals in order and the creator is host', () => {
    const r = newRoom('ABCD', 0);
    join(r, 'p1');
    join(r, 'p2');
    expect(seatOf(r, 'p1')).toBe(0);
    expect(seatOf(r, 'p2')).toBe(1);
    expect(r.hostId).toBe('p1');
    expect(freeSeats(r)).toBe(2);
  });

  it('sit moves, stands up and refuses a taken seat', () => {
    const r = newRoom('ABCD', 0);
    join(r, 'p1');
    join(r, 'p2');
    sit(r, 'p2', 2);
    expect(seatOf(r, 'p2')).toBe(2);
    expect(r.seats[1].kind).toBe('empty');
    expect(() => sit(r, 'p2', 0)).toThrow(LobbyError);
    sit(r, 'p2', null);
    expect(seatOf(r, 'p2')).toBeNull();
  });

  it('sitting on a CPU swaps places with it', () => {
    const r = newRoom('ABCD', 0);
    join(r, 'p1');
    setCpu(r, 'p1', 1, 'carlos');
    sit(r, 'p1', 1);
    expect(seatOf(r, 'p1')).toBe(1);
    expect(r.seats[0]).toEqual({ kind: 'cpu', characterId: 'carlos' });
  });

  it('only the host sets CPUs, mode and rules', () => {
    const r = newRoom('ABCD', 0);
    join(r, 'p1');
    join(r, 'p2');
    expect(() => setCpu(r, 'p2', 2, 'elena')).toThrow(/not_host/);
    setCpu(r, 'p1', 2, 'elena');
    expect(r.seats[2]).toEqual({ kind: 'cpu', characterId: 'elena' });
    expect(() => setCpu(r, 'p1', 3, 'elena')).toThrow(); // already seated
    expect(() => setCpu(r, 'p1', 1, 'carlos')).toThrow(); // a human sits there
    expect(() => setCpu(r, 'p1', 3, 'nobody')).toThrow();
    expect(() => setMode(r, 'p2', 'individual', 3)).toThrow(/not_host/);
    expect(() => setRules(r, 'p2', {})).toThrow(/not_host/);
    setRules(r, 'p1', { target: 'garbage' });
    expect(r.rules.target).toBe(newRoom('X', 0).rules.target); // invalid values fall back to defaults
  });

  it('a newcomer takes a CPU seat when no seat is empty', () => {
    const r = newRoom('ABCD', 0);
    join(r, 'p1');
    for (const [s, c] of [[1, 'carlos'], [2, 'elena'], [3, 'andres']] as const) setCpu(r, 'p1', s, c);
    join(r, 'p2');
    expect(seatOf(r, 'p2')).toBe(1);
  });

  it('switching to 3-player individual moves players out of the unused seat', () => {
    const r = newRoom('ABCD', 0);
    join(r, 'p1');
    join(r, 'p2');
    sit(r, 'p2', 2);
    setCpu(r, 'p1', 1, 'carlos');
    setMode(r, 'p1', 'individual', 3); // seats 0, 1, 3
    expect(r.seats[2].kind).toBe('empty');
    expect(seatOf(r, 'p2')).toBe(3);
    expect(r.rules.boneyardDraw).toBe(true); // individual defaults
    expect(() => setMode(r, 'p1', 'individual', 5)).toThrow();
  });

  it('fillSeats seats waiting players then distinct roster CPUs', () => {
    const r = newRoom('ABCD', 0);
    join(r, 'p1');
    join(r, 'p2');
    sit(r, 'p2', null);
    setCpu(r, 'p1', 3, 'zorg');
    fillSeats(r, () => 0.3);
    expect(seatOf(r, 'p2')).not.toBeNull();
    const cpus = r.seats.filter((s) => s.kind === 'cpu').map((s) => (s as { characterId: string }).characterId);
    expect(cpus).toHaveLength(2);
    expect(new Set(cpus).size).toBe(2);
    expect(r.seats.every((s) => s.kind !== 'empty')).toBe(true);
  });

  it('host passes to the next connected human; a leaving player in a match becomes a CPU', () => {
    const r = newRoom('ABCD', 0);
    join(r, 'p1', 1);
    join(r, 'p2', 2);
    join(r, 'p3', 3);
    r.members.p1.connected = false;
    r.members.p2.connected = false;
    expect(ensureHost(r)).toBe(true);
    expect(r.hostId).toBe('p3');
    r.members.p1.connected = true;
    expect(ensureHost(r)).toBe(false); // the new host keeps it
    r.phase = 'playing';
    removeMember(r, 'p3');
    expect(r.seats[2].kind).toBe('cpu');
    expect(r.hostId).toBe('p1');
    expect(publicRoom(r).hostId).toBe('p1');
  });

  it('in a running match newcomers only get CPU seats', () => {
    const r = newRoom('ABCD', 0);
    join(r, 'p1');
    fillSeats(r, () => 0.5);
    r.phase = 'playing';
    expect(freeSeats(r)).toBe(3);
    join(r, 'p2');
    expect(r.seats[seatOf(r, 'p2')!]).toEqual({ kind: 'human', playerId: 'p2' });
    expect(freeSeats(r)).toBe(2);
  });
});
