import { MatchEntryStatus, MatchStatus, UserStatus } from '../generated/prisma/enums';
import { MatchmakingService } from './matchmaking.service';

class FakeRedisRaw {
  strings = new Map<string, string>();
  sortedSets = new Map<string, Map<string, number>>();

  async get(key: string) {
    return this.strings.get(key) ?? null;
  }

  multi() {
    const commands: Array<() => void> = [];
    return {
      set: (key: string, value: string) => {
        commands.push(() => this.strings.set(key, value));
        return this;
      },
      zAdd: (key: string, items: Array<{ score: number; value: string }>) => {
        commands.push(() => {
          const set = this.sortedSets.get(key) ?? new Map<string, number>();
          for (const item of items) set.set(item.value, item.score);
          this.sortedSets.set(key, set);
        });
        return this;
      },
      expire: () => this,
      zRem: (key: string, value: string) => {
        commands.push(() => this.sortedSets.get(key)?.delete(value));
        return this;
      },
      del: (key: string) => {
        commands.push(() => {
          this.strings.delete(key);
          this.sortedSets.delete(key);
        });
        return this;
      },
      exec: async () => {
        for (const command of commands) command();
      },
    };
  }

  async zRange(key: string, start: number, stop: number) {
    return [...(this.sortedSets.get(key) ?? new Map()).entries()]
      .sort((left, right) => left[1] - right[1])
      .slice(start, stop + 1)
      .map(([value]) => value);
  }

  async zRem(key: string, value: string) {
    this.sortedSets.get(key)?.delete(value);
  }

  async del(key: string) {
    this.strings.delete(key);
    this.sortedSets.delete(key);
  }
}

describe('MatchmakingService manual ready lobby', () => {
  const gameMode = {
    id: 'mode-1',
    enabled: true,
    playerCount: 2,
    stakeAmountMinor: 100n,
    game: { enabled: true, code: 'LUDO' },
  };

  function createService() {
    const raw = new FakeRedisRaw();
    let matchCounter = 0;
    const matches = new Map<string, any>();
    const userNames = new Map([
      ['user-1', 'Alpha'],
      ['user-2', 'Beta'],
      ['user-3', 'Gamma'],
    ]);

    const prisma = {
      gameMode: {
        findUnique: jest.fn(async () => gameMode),
      },
      user: {
        findUnique: jest.fn(async ({ where, select }: any) => {
          if (select?.fullName) return { fullName: userNames.get(where.id) ?? `Player ${where.id}` };
          return { status: UserStatus.ACTIVE, wallet: { availableBalance: 1000n } };
        }),
        findUniqueOrThrow: jest.fn(async ({ where }: any) => ({ fullName: userNames.get(where.id) ?? `Player ${where.id}` })),
        findMany: jest.fn(async ({ where }: any) => {
          const ids: string[] = where?.id?.in ?? [];
          return ids.map((id) => ({ id, status: UserStatus.ACTIVE }));
        }),
      },
      match: {
        findUnique: jest.fn(async ({ where }: any) => matches.get(where.id) ?? null),
        findMany: jest.fn(async ({ where }: any) => {
          const ids: string[] = where?.id?.in ?? [];
          return ids.map((id) => matches.get(id)).filter((match): match is any => Boolean(match));
        }),
      },
      matchParticipant: {
        deleteMany: jest.fn(),
        findFirst: jest.fn(async () => null),
      },
    };

    const gaming = {
      createOpenMatch: jest.fn(async (gameModeId: string, userId: string) => {
        const match = {
          id: `match-${++matchCounter}`,
          status: MatchStatus.WAITING,
          gameModeId,
          participants: [{ userId }],
          entries: [{ userId, status: MatchEntryStatus.LOCKED }],
        };
        matches.set(match.id, match);
        return match;
      }),
      joinOpenMatch: jest.fn(async (matchId: string, userId: string) => {
        const match = matches.get(matchId);
        match.participants.push({ userId });
        match.entries.push({ userId, status: MatchEntryStatus.LOCKED });
        return match;
      }),
      getMatchForUser: jest.fn(async (matchId: string) => ({
        id: matchId,
        gameMode: { ...gameMode, stakeAmountMinor: gameMode.stakeAmountMinor.toString() },
      })),
    };

    const gameEntry = {
      secureParticipantEntry: jest.fn(async () => undefined),
      cancelAndRefund: jest.fn(async () => undefined),
    };

    const redis = {
      raw: () => raw,
      key: (...parts: string[]) => ['test', ...parts].join(':'),
      getJson: async <T>(key: string) => {
        const value = await raw.get(key);
        return value === null ? null : (JSON.parse(value) as T);
      },
      withLock: async <T>(_key: string, action: () => Promise<T>, _ttlMs?: number, _waitMs?: number) => action(),
    };

    const config = { get: jest.fn(() => 60) };
    const service = new MatchmakingService(
      prisma as any,
      redis as any,
      gaming as any,
      gameEntry as any,
      config as any,
    );

    return { service, gaming, prisma };
  }

  it('keeps multiple ready players in the lobby without auto-pairing', async () => {
    const { service, gaming } = createService();

    const first = await service.join('user-1', { gameModeId: gameMode.id });
    const second = await service.join('user-2', { gameModeId: gameMode.id });
    const third = await service.join('user-3', { gameModeId: gameMode.id });

    expect(first.status).toBe('QUEUED');
    expect(second.status).toBe('QUEUED');
    expect(third.status).toBe('QUEUED');
    expect(gaming.joinOpenMatch).not.toHaveBeenCalled();

    const lobby = await service.list(gameMode.id, 'user-3');
    expect(lobby.players).toHaveLength(3);
    expect(lobby.players.map((player) => player.displayName)).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('matches only when a player challenges a selected ready ticket', async () => {
    const { service, gaming } = createService();

    const first = await service.join('user-1', { gameModeId: gameMode.id });
    expect(first.status).toBe('QUEUED');
    if (first.status !== 'QUEUED') throw new Error('Expected queued result');

    const matched = await service.join('user-2', { gameModeId: gameMode.id, ticketId: first.ticketId });

    expect(matched.status).toBe('MATCHED');
    expect(gaming.joinOpenMatch).toHaveBeenCalledWith(first.matchId, 'user-2');

    const lobby = await service.list(gameMode.id, 'user-2');
    expect(lobby.players).toHaveLength(0);
  });

  it('shows up to 100 ready players without creating matches automatically', async () => {
    const { service, gaming } = createService();

    for (let index = 1; index <= 100; index += 1) {
      const result = await service.join(`bulk-user-${index}`, { gameModeId: gameMode.id });
      expect(result.status).toBe('QUEUED');
    }

    const lobby = await service.list(gameMode.id, 'bulk-user-1');
    expect(lobby.players).toHaveLength(100);
    expect(gaming.joinOpenMatch).not.toHaveBeenCalled();
  });

  it('DB4: loads a 100-ticket lobby with a fixed, small number of Prisma calls (no N+1)', async () => {
    const { service, prisma } = createService();

    for (let index = 1; index <= 100; index += 1) {
      await service.join(`bulk-user-${index}`, { gameModeId: gameMode.id });
    }

    prisma.match.findUnique.mockClear();
    prisma.match.findMany.mockClear();
    prisma.user.findUnique.mockClear();
    prisma.user.findMany.mockClear();

    const lobby = await service.list(gameMode.id, 'bulk-user-1');

    expect(lobby.players).toHaveLength(100);
    // Previously: up to ~4 sequential calls *per ticket* (one of them a
    // literal duplicate match fetch) - i.e. hundreds of round trips for 100
    // tickets. Now: exactly one batched findMany per model, regardless of
    // how many tickets are ready.
    expect(prisma.match.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.match.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});
