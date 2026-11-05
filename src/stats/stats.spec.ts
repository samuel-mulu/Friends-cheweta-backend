import { MatchStatus, UserRole } from '../generated/prisma/enums';
import { computePlayerMatchStats, summarizePlayerStats } from './stats.compute';
import { StatsService } from './stats.service';

const ev = (type: string, payload: Record<string, unknown>) => ({ type, payload });

describe('computePlayerMatchStats', () => {
  it('counts rolls, sixes, captures, tokens lost and home per player', () => {
    const rows = computePlayerMatchStats({
      playerIds: ['a', 'b'],
      winnerOrder: ['b', 'a'],
      colorByUser: { a: 'RED', b: 'YELLOW' },
      events: [
        ev('DICE_ROLLED', { playerId: 'a', diceValue: 6 }),
        ev('DICE_ROLLED', { playerId: 'a', diceValue: 3 }),
        ev('DICE_ROLLED', { playerId: 'b', diceValue: 6 }),
        ev('TOKEN_CAPTURED', { playerId: 'b', tokenIds: ['RED-1', 'RED-2'] }),
        ev('TOKEN_FINISHED', { playerId: 'b' }),
      ],
    });
    expect(rows).toEqual([
      {
        userId: 'a',
        position: 2,
        won: false,
        rolls: 2,
        sixes: 1,
        captures: 0,
        tokensLost: 2,
        tokensHome: 0,
      },
      {
        userId: 'b',
        position: 1,
        won: true,
        rolls: 1,
        sixes: 1,
        captures: 2,
        tokensLost: 0,
        tokensHome: 1,
      },
    ]);
  });
});

describe('summarizePlayerStats', () => {
  const row = (won: boolean) => ({ won, rolls: 10, sixes: 2, captures: 1, tokensHome: 4 });

  it('computes win rate, six rate and streaks (oldest first)', () => {
    const summary = summarizePlayerStats([row(true), row(true), row(false), row(true)]);
    expect(summary).toMatchObject({
      games: 4,
      wins: 3,
      winRate: 0.75,
      bestStreak: 2,
      currentStreak: 1,
      sixRate: 0.2,
      captures: 4,
    });
  });

  it('is all zeros for a new player', () => {
    expect(summarizePlayerStats([])).toMatchObject({
      games: 0,
      winRate: 0,
      sixRate: 0,
      bestStreak: 0,
    });
  });
});

describe('StatsService', () => {
  function harness(match: any) {
    const prisma = {
      match: { findUnique: jest.fn(async () => match) },
      matchEvent: {
        findMany: jest.fn(async () => [ev('DICE_ROLLED', { playerId: 'a', diceValue: 6 })]),
      },
      playerMatchStat: {
        createMany: jest.fn(async ({ data }: any) => ({ count: data.length })),
        groupBy: jest.fn(async ({ where }: any) =>
          where.won
            ? [
                { userId: 'a', _count: { _all: 3 } },
                { userId: 'b', _count: { _all: 3 } },
              ]
            : [
                { userId: 'a', _count: { _all: 6 } },
                { userId: 'b', _count: { _all: 4 } },
                { userId: 'c', _count: { _all: 9 } },
              ],
        ),
        findMany: jest.fn(async () => [
          {
            id: 's1',
            matchId: 'm1',
            userId: 'a',
            createdAt: new Date(),
            position: 1,
            won: true,
            rolls: 1,
            sixes: 1,
            captures: 0,
            tokensLost: 0,
            tokensHome: 4,
            user: { fullName: 'Abel' },
          },
        ]),
      },
      user: {
        findMany: jest.fn(async ({ where }: any) =>
          where.id.in.map((id: string) => ({ id, fullName: id.toUpperCase() })),
        ),
      },
    };
    return { service: new StatsService(prisma as any), prisma };
  }

  const finished = {
    status: MatchStatus.FINISHED,
    source: 'CHALLENGE',
    winnerOrder: ['a', 'b'],
    participants: [{ userId: 'a' }, { userId: 'b' }],
    checkpoint: {
      state: {
        game: {
          players: [
            { userId: 'a', color: 'RED' },
            { userId: 'b', color: 'YELLOW' },
          ],
        },
      },
    },
  };

  it('records one row per player, idempotently (skipDuplicates)', async () => {
    const { service, prisma } = harness(finished);
    expect(await service.recordMatch('m1')).toBe(2);
    expect(prisma.playerMatchStat.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
  });

  it('never records practice or unfinished matches', async () => {
    expect(await harness({ ...finished, source: 'PRACTICE' }).service.recordMatch('m1')).toBe(0);
    expect(
      await harness({ ...finished, status: MatchStatus.PLAYING }).service.recordMatch('m1'),
    ).toBe(0);
  });

  it('ranks the leaderboard by wins, then win rate', async () => {
    const board = await harness(finished).service.leaderboard('all');
    // a and b both have 3 wins; b has the better rate (3/4 > 3/6); c has no wins.
    expect(board.entries.map((e) => [e.rank, e.userId, e.wins])).toEqual([
      [1, 'b', 3],
      [2, 'a', 3],
      [3, 'c', 0],
    ]);
    expect(board.entries[0].displayName).toBe('B');
  });

  it('match stats are visible to participants and admins only', async () => {
    const { service } = harness(finished);
    await expect(
      service.matchStats('m1', { id: 'a', role: UserRole.PLAYER }),
    ).resolves.toMatchObject({ players: [{ userId: 'a', displayName: 'Abel' }] });
    await expect(
      service.matchStats('m1', { id: 'z', role: UserRole.PLAYER }),
    ).rejects.toMatchObject({ response: { code: 'MATCH_ACCESS_DENIED' } });
    await expect(
      service.matchStats('m1', { id: 'z', role: UserRole.ADMIN }),
    ).resolves.toBeDefined();
  });
});
