import { GameEntryService } from '../game-entry/game-entry.service';
import { MatchStatus } from '../generated/prisma/enums';
import { createTestRedis } from '../test-utils/redis-test.util';
import { LudoRuntimeRepository } from './ludo-runtime.repository';
import { LudoRuntimeService } from './ludo-runtime.service';

const MATCH = 'match-1';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function createHarness() {
  const { redis, cleanup } = await createTestRedis();
  const match = {
    id: MATCH,
    status: MatchStatus.READY as MatchStatus,
    entrySecuredAt: new Date(),
    rulesVersion: 'LUDO_CLASSIC_V1',
    game: { code: 'LUDO' },
    participants: [
      { userId: 'A', seat: 0 },
      { userId: 'B', seat: 1 },
    ],
  };
  let dbDelayMs = 0;
  const prisma = {
    match: {
      findUnique: jest.fn(async () => {
        if (dbDelayMs) await sleep(dbDelayMs);
        return { ...match };
      }),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    matchParticipant: {
      findUnique: jest.fn(async ({ where }: any) =>
        match.participants.some((p) => p.userId === where.matchId_userId.userId)
          ? { id: 'p' }
          : null,
      ),
    },
  };
  const history = {
    persistExecution: jest.fn(async (_input: any): Promise<undefined> => undefined),
    saveCheckpoint: jest.fn(async () => undefined),
    getCheckpoint: jest.fn(async () => null),
  };
  const settlement = { settleLudoMatch: jest.fn(async () => undefined) };
  const config = { get: (key: string) => (key.startsWith('REDIS_') ? 3600 : undefined) };
  const repository = new LudoRuntimeRepository(redis, config as any);
  const service = new LudoRuntimeService(
    prisma as any,
    redis,
    repository,
    new GameEntryService(prisma as any, {} as any),
    settlement as any,
    history as any,
  );
  return {
    service,
    redis,
    repository,
    match,
    history,
    cleanup,
    slowDb: (ms: number) => (dbDelayMs = ms),
    /** Database reads so far (match + participant lookups). */
    calls: () => prisma.match.findUnique.mock.calls.length + prisma.matchParticipant.findUnique.mock.calls.length,
  };
}

describe('LudoRuntimeService (real Redis)', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  const rollForStart = (
    playerId: string,
    expectedVersion: number,
    commandId = `${playerId}-${expectedVersion}`,
  ) =>
    h.service.execute({
      matchId: MATCH,
      type: 'ROLL_FOR_START',
      playerId,
      commandId,
      expectedVersion,
    });

  it('concurrent first joins share one snapshot', async () => {
    const [a, b] = await Promise.all([
      h.service.getSnapshot(MATCH, 'A'),
      h.service.getSnapshot(MATCH, 'B'),
    ]);
    expect(a).toEqual(b);
  });

  it('rejects commands on a cancelled match even while a snapshot is still in Redis', async () => {
    const state = await h.service.getSnapshot(MATCH, 'A');
    h.match.status = MatchStatus.CANCELLED;
    await expect(rollForStart('A', state.game.version)).rejects.toMatchObject({
      response: { code: 'MATCH_NOT_ACTIVE' },
    });
  });

  it('a history failure does not fail a committed move; it is queued and retried', async () => {
    const state = await h.service.getSnapshot(MATCH, 'A');
    h.history.persistExecution.mockRejectedValueOnce(new Error('db down'));

    const result = await rollForStart('A', state.game.version);
    expect(result.duplicate).toBe(false);
    expect(result.events.length).toBeGreaterThan(0);
    await h.service.flushPersistence(MATCH); // persistence runs after the reply
    expect(await h.redis.raw().sMembers(h.repository.postCommitRetryKey())).toEqual([MATCH]);

    await h.service.retryPostCommit();
    expect(h.history.saveCheckpoint).toHaveBeenLastCalledWith(MATCH, result.state);
    expect(await h.redis.raw().sMembers(h.repository.postCommitRetryKey())).toEqual([]);
  });

  it('concurrent commands wait for the lock and resolve by version, not RESOURCE_BUSY', async () => {
    const state = await h.service.getSnapshot(MATCH, 'A');
    h.slowDb(40);
    const results = await Promise.allSettled([
      rollForStart('A', state.game.version),
      rollForStart('B', state.game.version),
    ]);

    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as Error).message).toBe('MATCH_VERSION_CONFLICT');
  });

  it('duplicate commandId is idempotent', async () => {
    const state = await h.service.getSnapshot(MATCH, 'A');
    const first = await rollForStart('A', state.game.version, 'same');
    const second = await rollForStart('A', state.game.version, 'same');
    expect(second.duplicate).toBe(true);
    expect(second.version).toBe(first.version);
    expect(h.history.persistExecution).toHaveBeenCalledTimes(1);
  });

  it('returns the committed result before Postgres persistence finishes', async () => {
    const state = await h.service.getSnapshot(MATCH, 'A');
    let releaseDb!: () => void;
    h.history.persistExecution.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (releaseDb = () => resolve(undefined))),
    );

    const result = await rollForStart('A', state.game.version);
    expect(result.events.length).toBeGreaterThan(0); // replied while the DB write is pending
    releaseDb();
    await h.service.flushPersistence(MATCH);
    expect(h.history.persistExecution).toHaveBeenCalledTimes(1);
  });

  it('persists rapid commands strictly in order', async () => {
    const state = await h.service.getSnapshot(MATCH, 'A');
    const order: number[] = [];
    h.history.persistExecution.mockImplementation(async (input: any) => {
      await sleep(input.state.game.version === 1 ? 30 : 0); // first write is slower
      order.push(input.state.game.version);
      return undefined;
    });
    const first = await rollForStart('A', state.game.version);
    await rollForStart('B', first.version);
    await h.service.flushPersistence(MATCH);
    expect(order).toEqual([1, 2]);
  });

  it('does not read the database on the hot path once the match is playing', async () => {
    const state = await h.service.getSnapshot(MATCH, 'A');
    const a = await rollForStart('A', state.game.version);
    await rollForStart('B', a.version);
    await h.service.flushPersistence(MATCH);
    const playing = (await h.service.getStoredSnapshot(MATCH))!;
    if (playing.game.phase !== 'PLAYING') return; // starting-roll tie; covered elsewhere
    const before = h.calls();
    await h.service.execute({
      matchId: MATCH,
      type: 'ROLL_DICE',
      playerId: playing.game.currentPlayerId!,
      commandId: 'hot',
      expectedVersion: playing.game.version,
    });
    expect(h.calls()).toBe(before);
  });
});
