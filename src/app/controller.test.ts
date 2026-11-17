import { describe, it, expect } from 'vitest';
import { engine } from '../engine';
import { GameSession, type SessionHooks } from './controller';
import type { GameEvent, MatchState, Move, Seat, TableView } from '../contracts';

/** a table that animates nothing; the human (seat 0) plays its first legal move */
function fakeView(log: string[]): TableView {
  return {
    handle: async (ev: GameEvent) => void log.push(ev.type),
    requestHumanMove: async (legal: Move[]) => legal[Math.floor(Math.random() * legal.length)],
    setTurn: () => {},
    reset: () => {},
    setQuality: () => {},
    setPaused: () => {},
    dispose: () => {},
    restore: async () => {},
  };
}

function hooks(over: Partial<SessionHooks> = {}): SessionHooks {
  return {
    onEvent: () => {},
    onTurn: () => {},
    showHandSummary: async () => {},
    showMatchEnd: async () => 'menu',
    save: () => {},
    setSfxMuted: () => {},
    ...over,
  };
}

function session(match: MatchState, h: SessionHooks, log: string[], resume = false): GameSession {
  return new GameSession(
    {
      engine,
      view: fakeView(log),
      hooks: h,
      profile: (s: Seat) => ({ level: s === 2 ? 'hard' : 'normal' }),
      speed: () => 0,
    },
    match,
    resume,
  );
}

const solo = (players: 2 | 3 | 4, draw = true) =>
  engine.createMatch({ ...engine.DEFAULT_RULES_INDIVIDUAL!, boneyardDraw: draw }, undefined, { mode: 'individual', players });

describe('GameSession flow (scripted, no rendering)', () => {
  for (const players of [2, 3, 4] as const)
    for (const draw of players === 4 ? [true] : [true, false])
      it(`individual, ${players} players${draw ? '' : ' (no boneyard draw)'}: a whole match runs to the end`, async () => {
        const log: string[] = [];
        let ends = 0;
        let saved: MatchState | null = null;
        const res = await session(solo(players, draw), hooks({ showMatchEnd: async () => (ends++, 'menu'), save: (m) => void (saved = m) }), log).run();
        expect(res).toBe('menu');
        expect(ends).toBe(1);
        expect(log.filter((t) => t === 'handStart').length).toBeGreaterThan(0);
        expect(log[log.length - 1]).toBe('matchEnd');
        expect(saved!.over).toBe(true);
      }, 60000);

  it('pairs: a whole match runs to the end (starter choice included)', async () => {
    const log: string[] = [];
    const res = await session(engine.createMatch(engine.DEFAULT_RULES), hooks({ pickStarter: async (m) => m.hand!.turn }), log).run();
    expect(res).toBe('menu');
  }, 60000);

  it('cancel mid-hand (Salir al menú) resolves "cancelled" and touches nothing afterwards', async () => {
    const log: string[] = [];
    let turns = 0;
    let s!: GameSession;
    const h = hooks({
      onTurn: () => {
        if (++turns === 5) s.cancel();
      },
    });
    s = session(solo(2), h, log);
    const res = await s.run();
    expect(res).toBe('cancelled');
    const n = log.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(log.length).toBe(n);
  });

  it('resuming a saved individual hand (Continuar) and a finished-hand save both continue', async () => {
    // play a few moves, keep the save, resume it in a new session
    let saved: { m: MatchState; ev: GameEvent[] } | null = null;
    let turns = 0;
    let s!: GameSession;
    s = session(
      solo(3),
      hooks({
        save: (m, ev) => void (saved = { m, ev }),
        onTurn: () => {
          if (++turns === 6) s.cancel();
        },
      }),
      [],
    );
    expect(await s.run()).toBe('cancelled');
    const snap = JSON.parse(JSON.stringify(saved!.m)) as MatchState;
    const res = await session(snap, hooks(), [], true).run();
    expect(res).toBe('menu');
  }, 60000);

  it('rematch: the hook result is returned as is', async () => {
    const res = await session(solo(2), hooks({ showMatchEnd: async () => 'rematch' }), []).run();
    expect(res).toBe('rematch');
  }, 60000);
});
