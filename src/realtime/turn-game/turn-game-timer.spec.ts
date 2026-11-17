import { GameEntryService } from '../../game-entry/game-entry.service';
import { MatchStatus } from '../../generated/prisma/enums';
import { createTestRedis } from '../../test-utils/redis-test.util';
import { DamaRuntimeRepository } from '../dama/dama-runtime.repository';
import { DamaRuntimeService } from '../dama/dama-runtime.service';
import { DamaTurnTimerService } from '../dama/dama-turn-timer.service';
import { MatchJoinTracker } from '../match-join-tracker';
import { TurnTiming } from './turn-game-timer';

const MATCH = 'timer-1';

async function createHarness() {
  const { redis, cleanup } = await createTestRedis();
  const match = {
    id: MATCH,
    status: MatchStatus.READY as MatchStatus,
    entrySecuredAt: new Date(),
    rulesVersion: 'DAMA_ET_V1',
    game: { code: 'DAMA' },
    gameMode: { turnDurationSeconds: 30 },
    participants: [
      { userId: 'A', seat: 0 },
      { userId: 'B', seat: 1 },
    ],
  };
  const prisma = {
    match: { findUnique: jest.fn(async () => ({ ...match })), updateMany: jest.fn(async () => ({ count: 1 })) },
    matchParticipant: { findUnique: jest.fn(async () => ({ id: 'p' })) },
  };
  const history = {
    persistExecution: jest.fn(async () => undefined),
    saveCheckpoint: jest.fn(async () => undefined),
    getCheckpoint: jest.fn(async () => null),
  };
  const config = { get: (key: string) => (key.startsWith('REDIS_') ? 3600 : 3) };
  const store = new DamaRuntimeRepository(redis, config as any);
  const runtime = new DamaRuntimeService(
    prisma as any,
    redis,
    store,
    new GameEntryService(prisma as any, {} as any),
    { settleMatchResult: jest.fn(), settleDraw: jest.fn() } as any,
    history as any,
  );
  const publisher = { publishTurnGame: jest.fn(), publishRoom: jest.fn(), matchRoom: (id: string) => `match:${id}` };
  const joins = new MatchJoinTracker(redis);
  const timer = new DamaTurnTimerService(runtime, redis, prisma as any, publisher as any, joins, config as any);

  /** Both players join, then the running turn clock is moved into the past. */
  const expireTurn = async () => {
    const state = await runtime.getSnapshot(MATCH, 'A');
    await timer.onMatchJoined(MATCH, 'A', state);
    const timing = await timer.onMatchJoined(MATCH, 'B', state);
    const past = Date.now() - 1000;
    const expired: TurnTiming = { ...timing, turnEndsAt: new Date(past).toISOString() };
    await redis.setJson(redis.key('runtime', 'dama', MATCH, 'timing'), expired, 600);
    await redis.raw().zAdd(redis.key('runtime', 'dama', 'turn-deadlines'), [{ score: past, value: MATCH }]);
    return state;
  };
  return { redis, store, runtime, timer, publisher, cleanup, expireTurn };
}

describe('TurnGameTimer (real Redis)', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.runtime.flushPersistence();
    await h.cleanup();
  });

  it('plays for the absent player and counts a strike when the clock runs out', async () => {
    const state = await h.expireTurn();
    await h.timer.processDue();

    const after = await h.runtime.getStoredSnapshot(MATCH);
    expect(after!.game.version).toBe(1);
    expect(h.publisher.publishRoom).toHaveBeenCalledWith(
      `match:${MATCH}`,
      'dama:auto_played',
      expect.objectContaining({ playerId: state.game.currentPlayerId, strikes: 1, maxStrikes: 3 }),
      MATCH,
    );
  });

  it('does not wait for a busy match: the timeout is retried on the next tick with no strike lost', async () => {
    const state = await h.expireTurn();
    const lockKey = h.store.lockKey(MATCH);
    await h.redis.raw().set(lockKey, 'a-player-command', { PX: 5000 });

    const startedAt = Date.now();
    await h.timer.processDue();
    expect(Date.now() - startedAt).toBeLessThan(200); // no lock wait
    expect((await h.runtime.getStoredSnapshot(MATCH))!.game.version).toBe(0);
    expect(h.publisher.publishRoom).not.toHaveBeenCalled();

    await h.redis.raw().del(lockKey);
    await h.timer.processDue();
    expect((await h.runtime.getStoredSnapshot(MATCH))!.game.version).toBe(1);
    expect(h.publisher.publishRoom).toHaveBeenCalledWith(
      `match:${MATCH}`,
      'dama:auto_played',
      expect.objectContaining({ playerId: state.game.currentPlayerId, strikes: 1 }),
      MATCH,
    );
  });
});
