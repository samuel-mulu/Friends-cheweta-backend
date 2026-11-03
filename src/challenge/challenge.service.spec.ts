import { ConflictException } from '@nestjs/common';
import { UserStatus } from '../generated/prisma/enums';
import { ChallengeService } from './challenge.service';

class FakeRedisRaw {
  strings = new Map<string, string>();
  zsets = new Map<string, Map<string, number>>();

  async get(key: string) {
    return this.strings.get(key) ?? null;
  }

  async set(key: string, value: string) {
    this.strings.set(key, value);
    return 'OK';
  }

  async zRangeByScore(key: string, min: number, max: number) {
    return [...(this.zsets.get(key) ?? new Map()).entries()]
      .filter(([, score]) => score >= min && score <= max)
      .map(([member]) => member);
  }

  async eval(_script: string, input: { keys: string[]; arguments: string[] }) {
    if (input.keys.length === 7 && input.arguments.length === 3) return this.reserve(input.keys, input.arguments);
    if (input.keys.length === 3) return this.claimAccept(input.keys, input.arguments);
    if (input.keys.length === 7 && input.arguments.length === 2) return this.accepted(input.keys, input.arguments);
    return this.terminal(input.keys, input.arguments);
  }

  private reserve(keys: string[], args: string[]) {
    const [challengerCtxKey, opponentCtxKey, challengerReservationKey, opponentReservationKey, challengeKey, readyKey, expiresKey] = keys;
    const challengerRaw = this.strings.get(challengerCtxKey);
    const opponentRaw = this.strings.get(opponentCtxKey);
    if (!challengerRaw || !opponentRaw) return 'LOBBY_NOT_JOINED';
    const challenger = JSON.parse(challengerRaw);
    const opponent = JSON.parse(opponentRaw);
    if (challenger.state !== 'READY') return 'LOBBY_NOT_READY';
    if (opponent.state !== 'READY') return 'CHALLENGE_TARGET_NOT_READY';
    if (this.strings.has(challengerReservationKey) || this.strings.has(opponentReservationKey)) return 'LOBBY_USER_BUSY';
    const challenge = JSON.parse(args[0]);
    challenger.state = 'CHALLENGED';
    opponent.state = 'CHALLENGED';
    this.strings.set(challengerReservationKey, args[1]);
    this.strings.set(opponentReservationKey, args[1]);
    this.strings.set(challengeKey, args[0]);
    this.strings.set(challengerCtxKey, JSON.stringify(challenger));
    this.strings.set(opponentCtxKey, JSON.stringify(opponent));
    this.zsets.get(readyKey)?.delete(challenge.challengerId);
    this.zsets.get(readyKey)?.delete(challenge.opponentId);
    const expires = this.zsets.get(expiresKey) ?? new Map<string, number>();
    expires.set(args[1], Number(args[2]));
    this.zsets.set(expiresKey, expires);
    return 'OK';
  }

  private terminal(keys: string[], args: string[]) {
    const [challengeKey, challengerReservationKey, opponentReservationKey, challengerCtxKey, opponentCtxKey, readyKey, expiresKey] = keys;
    const raw = this.strings.get(challengeKey);
    if (!raw) return 'CHALLENGE_NOT_FOUND';
    const challenge = JSON.parse(raw);
    if (challenge.status !== 'PENDING' && !(challenge.status === 'ACCEPTING' && args[1] === 'CANCELLED')) return 'ALREADY_TERMINAL';
    const updated = JSON.parse(args[2]);
    this.strings.set(challengeKey, JSON.stringify(updated));
    this.strings.delete(challengerReservationKey);
    this.strings.delete(opponentReservationKey);
    this.zsets.get(expiresKey)?.delete(args[0]);
    if (['REJECTED', 'CANCELLED', 'EXPIRED'].includes(args[1])) {
      const ready = this.zsets.get(readyKey) ?? new Map<string, number>();
      for (const [key, userId] of [[challengerCtxKey, challenge.challengerId], [opponentCtxKey, challenge.opponentId]] as const) {
        const contextRaw = this.strings.get(key);
        if (!contextRaw) continue;
        const context = JSON.parse(contextRaw);
        context.state = 'READY';
        this.strings.set(key, JSON.stringify(context));
        ready.set(userId, Number(args[3]));
      }
      this.zsets.set(readyKey, ready);
    }
    return 'OK';
  }

  private claimAccept(keys: string[], args: string[]) {
    const [challengeKey, challengerReservationKey, opponentReservationKey] = keys;
    const raw = this.strings.get(challengeKey);
    if (!raw) return 'CHALLENGE_NOT_FOUND';
    const challenge = JSON.parse(raw);
    if (challenge.status !== 'PENDING') return 'CHALLENGE_NOT_PENDING';
    if (Number(args[3]) <= Number(args[2])) return 'CHALLENGE_EXPIRED';
    if (this.strings.get(challengerReservationKey) !== args[0] || this.strings.get(opponentReservationKey) !== args[0]) return 'CHALLENGE_NOT_PENDING';
    this.strings.set(challengeKey, args[1]);
    return 'OK';
  }

  private accepted(keys: string[], args: string[]) {
    const [challengeKey, challengerReservationKey, opponentReservationKey, challengerCtxKey, opponentCtxKey, readyKey, expiresKey] = keys;
    const raw = this.strings.get(challengeKey);
    if (!raw) return 'CHALLENGE_NOT_FOUND';
    this.strings.set(challengeKey, args[1]);
    this.strings.delete(challengerReservationKey);
    this.strings.delete(opponentReservationKey);
    this.strings.delete(challengerCtxKey);
    this.strings.delete(opponentCtxKey);
    this.zsets.get(readyKey)?.delete(JSON.parse(raw).challengerId);
    this.zsets.get(readyKey)?.delete(JSON.parse(raw).opponentId);
    this.zsets.get(expiresKey)?.delete(args[0]);
    return 'OK';
  }
}

describe('ChallengeService', () => {
  function createHarness() {
    const raw = new FakeRedisRaw();
    const redis = {
      raw: () => raw,
      key: (...parts: string[]) => ['test', ...parts].join(':'),
      getJson: async <T>(key: string) => {
        const value = await raw.get(key);
        return value ? (JSON.parse(value) as T) : null;
      },
      setJson: async (key: string, value: unknown) => {
        raw.strings.set(key, JSON.stringify(value));
      },
    };
    const prisma = {
      user: { findUnique: jest.fn(async ({ where }: any) => ({ fullName: where.id, status: UserStatus.ACTIVE })) },
      gameMode: { findUnique: jest.fn(async () => ({ enabled: true, game: { enabled: true } })) },
      matchParticipant: {
        findFirst: jest.fn(async () => null),
        findMany: jest.fn(async () => []),
      },
    };
    const lobby = {
      requireContext: jest.fn(async (userId: string) => ({
        gameModeId: 'mode-1',
        state: 'READY',
        joinedAt: new Date().toISOString(),
        readyAt: new Date().toISOString(),
      })),
      findCommittedMatchForUser: jest.fn(async () => null),
      leave: jest.fn(async () => ({})),
      restoreReady: jest.fn(async (userIds: string[]) =>
        userIds.map((userId) => ({ userId, displayName: userId, state: 'READY' as const })),
      ),
    };
    const matchCreation = {
      findByChallengeId: jest.fn(async () => null),
      createSecuredMatch: jest.fn(async ({ challengeId }: any) => ({
        id: `match-${challengeId}`,
        sessionCode: 'LD-ABC123',
        gameModeId: 'mode-1',
        status: 'READY',
      })),
    };
    for (const userId of ['A', 'B', 'C']) {
      raw.strings.set(redis.key('lobby', 'user', userId), JSON.stringify({
        gameModeId: 'mode-1',
        state: 'READY',
        joinedAt: new Date().toISOString(),
      }));
    }
    raw.zsets.set(redis.key('lobby', 'mode-1', 'ready'), new Map([['A', 1], ['B', 2], ['C', 3]]));
    return { service: new ChallengeService(prisma as any, redis as any, lobby as any, matchCreation as any), raw, redis, matchCreation, lobby, prisma };
  }

  it('allows only one challenger to reserve the same opponent', async () => {
    const { service, raw, redis } = createHarness();
    const results = await Promise.allSettled([
      service.create('A', 'B', '00000000-0000-4000-8000-000000000001'),
      service.create('C', 'B', '00000000-0000-4000-8000-000000000002'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(raw.strings.get(redis.key('challenge', 'user', 'B'))).toBeTruthy();
  });

  it('returns an idempotent result for duplicate accept commandIds', async () => {
    const { service } = createHarness();
    const created = await service.create('A', 'B', '00000000-0000-4000-8000-000000000003');

    const first = await service.accept('B', created.challenge.id, '00000000-0000-4000-8000-000000000004');
    const second = await service.accept('B', created.challenge.id, '00000000-0000-4000-8000-000000000004');

    expect(first.challenge.status).toBe('ACCEPTED');
    expect(first.challenge.match).toMatchObject({ status: 'READY' });
    expect(second.duplicate).toBe(true);
    expect(second.challenge.status).toBe('ACCEPTED');
  });

  it('restores both users to ready after reject', async () => {
    const { service, raw, redis } = createHarness();
    const created = await service.create('A', 'B', '00000000-0000-4000-8000-000000000005');

    const rejected = await service.reject('B', created.challenge.id, '00000000-0000-4000-8000-000000000006');

    expect(rejected.challenge.status).toBe('REJECTED');
    expect(raw.strings.has(redis.key('challenge', 'user', 'A'))).toBe(false);
    expect(JSON.parse(raw.strings.get(redis.key('lobby', 'user', 'A'))!).state).toBe('READY');
    expect(JSON.parse(raw.strings.get(redis.key('lobby', 'user', 'B'))!).state).toBe('READY');
  });

  it('rejects accepting an expired challenge', async () => {
    const { service } = createHarness();
    const created = await service.create('A', 'B', '00000000-0000-4000-8000-000000000007');
    await service.expireDue(Date.parse(created.challenge.expiresAt) + 1);

    await expect(service.accept('B', created.challenge.id, '00000000-0000-4000-8000-000000000008')).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects create when either player has a committed WAITING match', async () => {
    const { service, prisma } = createHarness();
    (prisma.matchParticipant.findFirst as jest.Mock).mockResolvedValueOnce({
      userId: 'A',
      matchId: 'waiting-1',
      match: { status: 'WAITING' },
    });

    await expect(service.create('A', 'B', '00000000-0000-4000-8000-000000000009')).rejects.toMatchObject({
      response: { code: 'LOBBY_ACTIVE_MATCH' },
    });
  });

  it('on accept failure restores eligible players and leaves committed ones', async () => {
    const { service, matchCreation, lobby, prisma, raw, redis } = createHarness();
    const created = await service.create('A', 'B', '00000000-0000-4000-8000-00000000000a');
    matchCreation.createSecuredMatch.mockRejectedValueOnce(Object.assign(new ConflictException({ code: 'LOBBY_ACTIVE_MATCH', message: 'blocked' }), {}));
    (prisma.matchParticipant.findMany as jest.Mock).mockResolvedValueOnce([
      { userId: 'A', matchId: 'playing-1', match: { status: 'PLAYING' } },
    ]);

    await expect(service.accept('B', created.challenge.id, '00000000-0000-4000-8000-00000000000b')).rejects.toMatchObject({
      lobbyRecovery: expect.objectContaining({
        leftUserIds: ['A'],
        available: [expect.objectContaining({ userId: 'B' })],
      }),
    });
    expect(lobby.leave).toHaveBeenCalledWith('A');
    expect(lobby.restoreReady).toHaveBeenCalledWith(['B'], 'mode-1');
    expect(raw.strings.has(redis.key('challenge', 'user', 'A'))).toBe(false);
  });
});
