import { KARTA_TABLE_V1 } from '../../games/karta';
import { createTestRedis } from '../../test-utils/redis-test.util';
import { KartaTableService } from './karta-table.service';
import { afterRound, nextRoundSeats, withoutPlayer, type KartaTable } from './karta-table.rules';

/** Runs against a local Redis (REDIS_TEST_URL); the database and sockets are stand-ins. */

const MODE = 'karta-table-50';
const STAKE = 5000n;

function baseTable(extra: Partial<KartaTable> = {}): KartaTable {
  return {
    id: 't1',
    gameId: 'karta',
    gameModeId: MODE,
    stakeMinor: '5000',
    platformFeeBps: 0,
    maxSeats: 4,
    starterId: 'A',
    receiverId: 'B',
    queue: ['C', 'D'],
    round: 1,
    matchId: 'm1',
    status: 'PLAYING',
    nextAt: null,
    raise: null,
    last: null,
    leaving: [],
    createdAt: new Date(0).toISOString(),
    ...extra,
  };
}

describe('Karta table seating rules', () => {
  it('the receiver wins: they start, the next in the queue receives, the loser waits last', () => {
    const between = afterRound(baseTable(), 'B', 'A', '9500', 0, 3000);
    expect(between).toMatchObject({ starterId: 'B', receiverId: null, queue: ['C', 'D', 'A'] });
    expect(nextRoundSeats(between, () => true)).toEqual({
      starterId: 'B',
      receiverId: 'C',
      queue: ['D', 'A'],
      dropped: [],
    });
  });

  it('the starter wins: they keep starting', () => {
    const between = afterRound(baseTable(), 'A', 'B', '9500', 0, 3000);
    expect(nextRoundSeats(between, () => true)).toMatchObject({
      starterId: 'A',
      receiverId: 'C',
      queue: ['D', 'B'],
    });
  });

  it('a loser who left the table is not seated again', () => {
    const between = afterRound(baseTable({ leaving: ['A'] }), 'B', 'A', '9500', 0, 3000);
    expect(between.queue).toEqual(['C', 'D']);
  });

  it('players who cannot play are dropped; fewer than two closes the table', () => {
    const between = afterRound(baseTable(), 'B', 'A', '9500', 0, 3000);
    expect(nextRoundSeats(between, (id) => id !== 'B')).toMatchObject({
      starterId: 'C',
      receiverId: 'D',
      queue: ['A'],
      dropped: ['B'],
    });
    expect(nextRoundSeats(between, (id) => id === 'C')).toBeNull();
  });

  it('a starter leaving between rounds hands the deal to the first in the queue', () => {
    const between = afterRound(baseTable(), 'B', 'A', '9500', 0, 3000);
    expect(withoutPlayer(between, 'B')).toMatchObject({ starterId: 'C', queue: ['D', 'A'] });
    expect(withoutPlayer(between, 'D').queue).toEqual(['C', 'A']);
  });
});

async function harness() {
  const { redis, cleanup } = await createTestRedis();
  const balances = new Map<string, bigint>(
    ['A', 'B', 'C', 'D', 'E'].map((id) => [id, 100_000n] as const),
  );
  const online = new Set(['A', 'B', 'C', 'D', 'E']);
  const contexts = new Map<string, any>();
  const matches = new Map<string, any>();

  const prisma = {
    wallet: {
      findUnique: jest.fn(async ({ where }: any) => ({
        availableBalance: balances.get(where.userId) ?? 0n,
      })),
    },
    matchParticipant: { findFirst: jest.fn(async () => null) },
    user: {
      findMany: jest.fn(async ({ where }: any) =>
        (where.id.in as string[]).map((id) => ({ id, fullName: `Player ${id}` })),
      ),
    },
    gameMode: {
      findFirst: jest.fn(async ({ where }: any) =>
        [5000n, 10_000n].includes(where.stakeAmountMinor) ? { id: 'listed' } : null,
      ),
    },
    match: { findUnique: jest.fn(async () => ({ status: 'FINISHED' })) },
    matchSettlement: { findUnique: jest.fn(async () => ({ payoutAmountMinor: 9500n })) },
  };
  const lobby = {
    leave: jest.fn(async () => ({})),
    getContext: jest.fn(async (id: string) => contexts.get(id) ?? null),
  };
  const matchCreation = {
    createSecuredMatch: jest.fn(async (input: any) => {
      const existing = matches.get(input.matchmakingKey);
      if (existing) return existing;
      const match = { id: `match-${matches.size + 2}`, ...input };
      matches.set(input.matchmakingKey, match);
      return match;
    }),
  };
  const settlement = { settleMatchResult: jest.fn(async () => ({})) };
  const presence = { isOnline: jest.fn(async (id: string) => online.has(id)) };
  const publisher = { publishUser: jest.fn(), publishLobby: jest.fn() };
  const runtime = { onExecuted: jest.fn(() => () => undefined) };
  const turnTimer = { forfeitAbsent: jest.fn(async () => undefined) };

  const service = new KartaTableService(
    redis,
    prisma as any,
    lobby as any,
    matchCreation as any,
    settlement as any,
    presence as any,
    publisher as any,
    runtime as any,
    turnTimer as any,
  );

  /** Open a table from a first round between A (seat 0, starter) and B. */
  const open = async () =>
    (await service.open({
      id: 'm1',
      rulesVersion: KARTA_TABLE_V1,
      gameId: 'karta',
      gameModeId: MODE,
      stakeAmountMinor: STAKE.toString(),
      platformFeeBps: 500,
      gameMode: { playerCount: 4 },
      participants: [
        { userId: 'A', seat: 0 },
        { userId: 'B', seat: 1 },
      ],
    }))!;

  /** The round's match ended with [winner, loser]. */
  const roundEnds = (matchId: string, winnerOrder: string[], finishReason = 'SCORE') =>
    service.onRoundFinished({
      game: { matchId, rulesVersion: KARTA_TABLE_V1, phase: 'FINISHED', winnerOrder, finishReason },
      secret: { seed: 's' },
    } as any);

  /** Let the pause pass and start the next round. */
  const nextRound = async (tableId: string) => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 10_000);
    try {
      await service.startNextRound(tableId);
    } finally {
      clock.mockRestore();
    }
  };

  return {
    service,
    redis,
    cleanup,
    balances,
    online,
    contexts,
    matchCreation,
    publisher,
    turnTimer,
    open,
    roundEnds,
    nextRound,
    mine: (id: string) => service.mine(id),
  };
}

describe('KartaTableService (real Redis)', () => {
  let h: Awaited<ReturnType<typeof harness>>;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('players join the back of the queue mid-game until the table is full', async () => {
    const table = await h.open();
    await h.service.join('C', table.id);
    const view = await h.service.join('D', table.id);
    expect(view).toMatchObject({
      starterId: 'A',
      receiverId: 'B',
      queue: ['C', 'D'],
      freeSeats: 0,
    });
    expect(view.players.map((p) => p.userId)).toEqual(['A', 'B', 'C', 'D']);
    await expect(h.service.join('E', table.id)).rejects.toMatchObject({
      response: { code: 'TABLE_FULL' },
    });
    expect(await h.service.openTables([MODE])).toEqual([]);
  });

  it('a player who cannot cover the stake cannot sit down', async () => {
    const table = await h.open();
    h.balances.set('C', 100n);
    await expect(h.service.join('C', table.id)).rejects.toMatchObject({
      response: { code: 'INSUFFICIENT_BALANCE_FOR_MATCH' },
    });
  });

  it('B wins: B starts, C receives, the queue is D then A; the next round is created once', async () => {
    const table = await h.open();
    await h.service.join('C', table.id);
    await h.service.join('D', table.id);

    await h.roundEnds('m1', ['B', 'A']);
    expect(await h.mine('A')).toMatchObject({
      status: 'BETWEEN',
      starterId: 'B',
      queue: ['C', 'D', 'A'],
      last: { winnerId: 'B', loserId: 'A', payoutMinor: '9500' },
    });

    await Promise.all([h.nextRound(table.id), h.nextRound(table.id)]);
    expect(h.matchCreation.createSecuredMatch).toHaveBeenCalledTimes(1);
    expect(h.matchCreation.createSecuredMatch).toHaveBeenCalledWith(
      expect.objectContaining({
        playerIds: ['B', 'C'],
        stakeAmountMinor: STAKE,
        matchmakingKey: `karta-table:${table.id}:2`,
      }),
    );
    expect(await h.mine('D')).toMatchObject({
      status: 'PLAYING',
      round: 2,
      starterId: 'B',
      receiverId: 'C',
      queue: ['D', 'A'],
    });
    expect(h.publisher.publishUser).toHaveBeenCalledWith(
      'C',
      'match:ready',
      expect.anything(),
      expect.any(String),
    );
  });

  it('a round that ends twice (retry) rotates once', async () => {
    const table = await h.open();
    await h.service.join('C', table.id);
    await h.roundEnds('m1', ['A', 'B']);
    await h.roundEnds('m1', ['A', 'B']);
    expect(await h.mine('A')).toMatchObject({ starterId: 'A', queue: ['C', 'B'] });
  });

  it('players who went offline or cannot cover the stake are removed before the next round', async () => {
    const table = await h.open();
    await h.service.join('C', table.id);
    await h.service.join('D', table.id);
    await h.roundEnds('m1', ['B', 'A']);
    h.balances.set('C', 100n);
    h.online.delete('D');

    await h.nextRound(table.id);
    expect(await h.mine('A')).toMatchObject({ starterId: 'B', receiverId: 'A', queue: [] });
    expect(await h.mine('C')).toBeNull();
    expect(h.publisher.publishUser).toHaveBeenCalledWith('C', 'karta:table:removed', {
      tableId: table.id,
      reason: 'INSUFFICIENT_BALANCE',
    });
    expect(h.publisher.publishUser).toHaveBeenCalledWith('D', 'karta:table:removed', {
      tableId: table.id,
      reason: 'OFFLINE',
    });
  });

  it('the two players agree to raise the stake; it applies from the next round', async () => {
    const table = await h.open();
    await h.service.join('C', table.id);
    await expect(h.service.proposeRaise('C', 10_000)).rejects.toMatchObject({
      response: { code: 'TABLE_NOT_IN_ROUND' },
    });
    await expect(h.service.proposeRaise('A', 7_000)).rejects.toMatchObject({
      response: { code: 'TABLE_RAISE_INVALID' },
    });
    await h.service.proposeRaise('A', 10_000);
    await expect(h.service.answerRaise('A', true)).rejects.toMatchObject({
      response: { code: 'TABLE_NO_RAISE' },
    });
    expect(await h.service.answerRaise('B', true)).toMatchObject({
      stakeMinor: '10000',
      raise: null,
    });

    await h.roundEnds('m1', ['A', 'B']);
    await h.nextRound(table.id);
    expect(h.matchCreation.createSecuredMatch).toHaveBeenCalledWith(
      expect.objectContaining({ playerIds: ['A', 'C'], stakeAmountMinor: 10_000n }),
    );
  });

  it('a declined raise keeps the stake', async () => {
    await h.open();
    await h.service.proposeRaise('B', 10_000);
    expect(await h.service.answerRaise('A', false)).toMatchObject({ stakeMinor: '5000' });
  });

  it('leaving: waiting players go at once; a player in the round resigns it and is not seated again', async () => {
    const table = await h.open();
    await h.service.join('C', table.id);
    await h.service.join('D', table.id);

    await h.service.leave('D');
    expect(await h.mine('D')).toBeNull();
    expect((await h.mine('A'))?.queue).toEqual(['C']);

    await h.service.leave('A');
    expect(h.turnTimer.forfeitAbsent).toHaveBeenCalledWith('m1', 'A');
    await h.roundEnds('m1', ['B', 'A'], 'RESIGN');
    expect(await h.mine('A')).toBeNull();
    expect(await h.mine('B')).toMatchObject({ starterId: 'B', queue: ['C'] });
  });

  it('the table closes when fewer than two players are left', async () => {
    const table = await h.open();
    await h.roundEnds('m1', ['B', 'A'], 'RESIGN');
    await h.nextRound(table.id);
    expect(await h.mine('B')).toBeNull();
    expect(h.publisher.publishUser).toHaveBeenCalledWith('B', 'karta:table:closed', {
      tableId: table.id,
    });
  });

  it('"I\'m ready" at a table stake takes a free seat at an open table', async () => {
    const table = await h.open();
    h.contexts.set('E', { gameModeId: MODE, state: 'READY' });
    expect(await h.service.seatReady('E')).toMatchObject({ id: table.id, queue: ['E'] });
    h.contexts.set('C', { gameModeId: 'another-stake', state: 'READY' });
    expect(await h.service.seatReady('C')).toBeNull();
  });

  it('only players seated at the table may watch its round', async () => {
    const table = await h.open();
    await h.service.join('C', table.id);
    expect(await h.service.canWatch('m1', 'C')).toBe(true);
    expect(await h.service.canWatch('m1', 'E')).toBe(false);
  });
});
