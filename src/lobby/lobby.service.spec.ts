import { ConflictException } from '@nestjs/common';
import { MatchStatus, UserStatus } from '../generated/prisma/enums';
import { LobbyService } from './lobby.service';

describe('LobbyService eligibility', () => {
  function createHarness(committed?: { matchId: string; status: MatchStatus } | null) {
    const contexts = new Map<string, any>();
    const prisma = {
      gameMode: {
        findUnique: jest.fn(async () => ({
          id: 'mode-1',
          code: 'LUDO_1V1',
          name: 'Ludo',
          stakeAmountMinor: 100n,
          enabled: true,
          game: { enabled: true },
        })),
      },
      user: {
        findUnique: jest.fn(async () => ({ status: UserStatus.ACTIVE, fullName: 'Player' })),
      },
      matchParticipant: {
        findFirst: jest.fn(async () =>
          committed
            ? { matchId: committed.matchId, match: { status: committed.status } }
            : null,
        ),
      },
    };
    const redisRaw = {
      multi: () => {
        const ops: Array<() => void> = [];
        const chain: any = {
          zAdd: () => chain,
          expire: () => chain,
          set: (_key: string, value: string) => {
            ops.push(() => contexts.set('user', JSON.parse(value)));
            return chain;
          },
          sAdd: () => chain,
          zRem: () => chain,
          sRem: () => chain,
          del: () => chain,
          exec: async () => {
            for (const op of ops) op();
          },
        };
        return chain;
      },
    };
    const redis = {
      raw: () => redisRaw,
      key: (...parts: string[]) => parts.join(':'),
      getJson: async () => contexts.get('ctx') ?? null,
      setJson: async () => undefined,
    };
    const service = new LobbyService(prisma as any, redis as any);
    return { service, prisma, contexts };
  }

  it('allows READY when the user only has FINISHED match history', async () => {
    const { service, contexts } = createHarness(null);
    contexts.set('ctx', { gameModeId: 'mode-1', state: 'ONLINE', joinedAt: new Date().toISOString() });
    await expect(service.ready('user-1')).resolves.toMatchObject({ gameModeId: 'mode-1' });
  });

  it('allows READY when prior match is CANCELLED', async () => {
    const { service, contexts, prisma } = createHarness(null);
    contexts.set('ctx', { gameModeId: 'mode-1', state: 'ONLINE', joinedAt: new Date().toISOString() });
    prisma.matchParticipant.findFirst.mockResolvedValue(null);
    await expect(service.ready('user-1')).resolves.toMatchObject({ gameModeId: 'mode-1' });
  });

  it('denies READY when user has a WAITING commitment', async () => {
    const { service, contexts } = createHarness({ matchId: 'm-waiting', status: MatchStatus.WAITING });
    contexts.set('ctx', { gameModeId: 'mode-1', state: 'ONLINE', joinedAt: new Date().toISOString() });
    await expect(service.ready('user-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('join only requires an active user (committed WAITING is a READY concern)', async () => {
    const { service, prisma } = createHarness({ matchId: 'm-waiting', status: MatchStatus.WAITING });
    (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce({ status: UserStatus.BLOCKED, fullName: 'X' });
    await expect(service.join('user-1', 'mode-1')).rejects.toMatchObject({
      response: { code: 'PLAYER_NOT_ELIGIBLE' },
    });
    expect(prisma.matchParticipant.findFirst).not.toHaveBeenCalled();
  });
});
