import { GameEntryService } from '../../game-entry/game-entry.service';
import { DAMA_DRAW_PLIES, DamaColor, boardFrom } from '../../games/dama/domain';
import { createDamaMatch } from '../../games/dama/runtime';
import { MatchStatus } from '../../generated/prisma/enums';
import { createTestRedis } from '../../test-utils/redis-test.util';
import { DamaRuntimeRepository } from './dama-runtime.repository';
import { DamaRuntimeService } from './dama-runtime.service';

const MATCH = 'dama-1';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function createHarness() {
  const { redis, cleanup } = await createTestRedis();
  const match = {
    id: MATCH,
    status: MatchStatus.READY as MatchStatus,
    entrySecuredAt: new Date(),
    rulesVersion: 'DAMA_ET_V1',
    game: { code: 'DAMA' },
    participants: [
      { userId: 'A', seat: 0 },
      { userId: 'B', seat: 1 },
    ],
  };
  const prisma = {
    match: {
      findUnique: jest.fn(async () => ({ ...match })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    matchParticipant: {
      findUnique: jest.fn(async ({ where }: any) =>
        match.participants.some((p) => p.userId === where.matchId_userId.userId) ? { id: 'p' } : null,
      ),
    },
  };
  let persistDelayMs = 0;
  const persisted: number[] = [];
  const history = {
    persistExecution: jest.fn(async (input: any) => {
      if (persistDelayMs) await sleep(persistDelayMs);
      persisted.push(input.state.game.version);
    }),
    saveCheckpoint: jest.fn(async () => undefined),
    getCheckpoint: jest.fn(async () => null),
  };
  const settlement = { settleMatchResult: jest.fn(async () => undefined), settleDraw: jest.fn(async () => undefined) };
  const config = { get: (key: string) => (key.startsWith('REDIS_') ? 3600 : undefined) };
  const store = new DamaRuntimeRepository(redis, config as any);
  const service = new DamaRuntimeService(
    prisma as any,
    redis,
    store,
    new GameEntryService(prisma as any, {} as any),
    settlement as any,
    history as any,
  );
  return { service, store, prisma, history, settlement, persisted, cleanup, slowPersistence: (ms: number) => (persistDelayMs = ms) };
}

describe('DamaRuntimeService (real Redis)', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  const lightAndDark = async () => {
    const state = await h.service.getSnapshot(MATCH, 'A');
    const light = state.game.players.find((p) => p.color === DamaColor.LIGHT)!.userId;
    const dark = state.game.players.find((p) => p.color === DamaColor.DARK)!.userId;
    return { state, light, dark };
  };

  it('creates the match on first join: both players, Light to move, checkpoint saved', async () => {
    const { state, light } = await lightAndDark();
    expect(state.game.players.map((p) => p.userId).sort()).toEqual(['A', 'B']);
    expect(state.game.currentPlayerId).toBe(light);
    expect(h.history.saveCheckpoint).toHaveBeenCalledTimes(1);
    expect(h.service.legalMoves(state)).toHaveLength(7);
    await expect(h.service.getSnapshot(MATCH, 'stranger')).rejects.toMatchObject({ response: { code: 'MATCH_ACCESS_DENIED' } });
  });

  it('answers before the database write, keeps writes in order, and is idempotent', async () => {
    const { light, dark } = await lightAndDark();
    h.slowPersistence(150);
    // c3-d4 (18 → 27) is legal for whoever drew Light.
    const lightMove = { matchId: MATCH, type: 'MOVE' as const, playerId: light, commandId: 'cmd-1', expectedVersion: 0, path: [18, 27] };
    const startedAt = Date.now();
    const first = await h.service.execute(lightMove);
    expect(Date.now() - startedAt).toBeLessThan(150);
    expect(first).toMatchObject({ duplicate: false, version: 1 });
    expect(h.persisted).toEqual([]);

    const again = await h.service.execute(lightMove);
    expect(again).toMatchObject({ duplicate: true, events: [] });

    await h.service.execute({ matchId: MATCH, type: 'MOVE', playerId: dark, commandId: 'cmd-2', expectedVersion: 1, path: [45, 36] });
    await h.service.flushPersistence(MATCH);
    expect(h.persisted).toEqual([1, 2]);
    expect(h.prisma.match.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: MatchStatus.PLAYING }) }),
    );
  });

  it('a resignation is settled as a win for the opponent', async () => {
    const { light, dark } = await lightAndDark();
    await h.service.execute({ matchId: MATCH, type: 'RESIGN', playerId: dark, commandId: 'r', expectedVersion: 0 });
    await h.service.flushPersistence(MATCH);
    expect(h.settlement.settleMatchResult).toHaveBeenCalledWith(MATCH, [light, dark]);
    expect(h.prisma.match.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: MatchStatus.FINISHING, isDraw: false }) }),
    );
  });

  it('a draw is settled by returning the stakes', async () => {
    const near = createDamaMatch(MATCH, 'A', 'B');
    near.game.version = 50;
    near.game.plyCount = 50;
    near.game.pliesSinceProgress = DAMA_DRAW_PLIES - 1;
    near.game.board = boardFrom({ 0: 'L', 15: 'D', 50: 'd' });
    await h.store.saveSnapshotIfAbsent(MATCH, near);

    const result = await h.service.execute({ matchId: MATCH, type: 'MOVE', playerId: 'A', commandId: 'd', expectedVersion: 50, path: [0, 9] });
    expect(result.state.game.result).toBe('DRAW');
    await h.service.flushPersistence(MATCH);
    expect(h.settlement.settleDraw).toHaveBeenCalledWith(MATCH);
    expect(h.settlement.settleMatchResult).not.toHaveBeenCalled();
  });
});
