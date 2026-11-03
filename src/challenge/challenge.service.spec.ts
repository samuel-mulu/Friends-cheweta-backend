import { ConflictException } from '@nestjs/common';
import { UserStatus } from '../generated/prisma/enums';
import { LobbyService } from '../lobby/lobby.service';
import { createTestRedis } from '../test-utils/redis-test.util';
import { ChallengeService } from './challenge.service';
import { ChallengeAcceptFailedError } from './challenge.types';

/**
 * Runs the real Lua scripts against a local Redis (REDIS_TEST_URL, default
 * redis://127.0.0.1:6379). PostgreSQL is replaced by an in-memory stand-in
 * that enforces Match.challengeId uniqueness like the real schema.
 */

const MODE = 'mode-1';
let seq = 0;
const cmd = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

async function createHarness() {
  const { redis, cleanup } = await createTestRedis();
  const committedUsers = new Set<string>();
  const matches = new Map<string, any>();

  const prisma = {
    gameMode: {
      findUnique: jest.fn(async () => ({
        id: MODE,
        code: 'LUDO_1V1',
        name: 'Ludo',
        stakeAmountMinor: 100n,
        enabled: true,
        game: { enabled: true },
      })),
    },
    user: {
      findMany: jest.fn(async ({ where }: any) =>
        (where.id.in as string[]).map((id) => ({
          id,
          fullName: `Player ${id}`,
          status: UserStatus.ACTIVE,
          wallet: { availableBalance: 1_000n },
        })),
      ),
    },
    matchParticipant: {
      findFirst: jest.fn(async ({ where }: any) => {
        const ids: string[] = typeof where.userId === 'string' ? [where.userId] : where.userId.in;
        const userId = ids.find((id) => committedUsers.has(id));
        if (!userId) return null;
        return {
          userId,
          matchId: `other-${userId}`,
          match: {
            id: `other-${userId}`,
            status: 'PLAYING',
            stakeAmountMinor: 100n,
            gameMode: { stakeAmountMinor: 100n },
            participants: [],
          },
        };
      }),
      findMany: jest.fn(async ({ where }: any) =>
        (where.userId.in as string[])
          .filter((id) => committedUsers.has(id))
          .map((userId) => ({ userId })),
      ),
    },
  };

  let creationGate: Promise<void> | null = null;
  const matchCreation = {
    findByChallengeId: jest.fn(async (challengeId: string) => matches.get(challengeId) ?? null),
    createSecuredMatch: jest.fn(async ({ challengeId, playerIds }: any) => {
      if (creationGate) await creationGate;
      if (matches.has(challengeId)) throw new Error('P2002 challengeId');
      const match = {
        id: `match-${challengeId}`,
        gameModeId: MODE,
        status: 'READY',
        participants: playerIds.map((userId: string, seat: number) => ({ userId, seat })),
      };
      matches.set(challengeId, match);
      return match;
    }),
  };

  const lobby = new LobbyService(prisma as any, redis);
  const service = new ChallengeService(prisma as any, redis, lobby, matchCreation as any);
  for (const userId of ['A', 'B', 'C']) {
    await lobby.join(userId, MODE);
    await lobby.ready(userId);
  }

  return {
    service,
    lobby,
    redis,
    matchCreation,
    matches,
    committedUsers,
    cleanup,
    holdMatchCreation: () => {
      const gate = deferred();
      creationGate = gate.promise;
      return () => {
        creationGate = null;
        gate.resolve();
      };
    },
    state: async (userId: string) => (await lobby.getContext(userId))?.state ?? null,
  };
}

async function waitUntil(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i += 1) await new Promise((r) => setTimeout(r, 5));
}

describe('ChallengeService (real Redis Lua)', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('lets only one challenger reserve the same opponent', async () => {
    const results = await Promise.allSettled([
      h.service.create('A', 'B', cmd()),
      h.service.create('C', 'B', cmd()),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await h.state('B')).toBe('CHALLENGED');
  });

  it('accept creates exactly one match and removes both players from the lobby', async () => {
    const { challenge } = await h.service.create('A', 'B', cmd());
    const result = await h.service.accept('B', challenge.id, cmd());

    expect(result.event).toBe('challenge:accepted');
    expect(result.challenge.match?.id).toBe(`match-${challenge.id}`);
    expect(result.matchReady.map((m) => m.userId).sort()).toEqual(['A', 'B']);
    expect(h.matchCreation.createSecuredMatch).toHaveBeenCalledTimes(1);
    expect(await h.state('A')).toBeNull();
    expect(await h.state('B')).toBeNull();
  });

  it('concurrent accepts with different commandIds create one match', async () => {
    const { challenge } = await h.service.create('A', 'B', cmd());
    const results = await Promise.allSettled([
      h.service.accept('B', challenge.id, cmd()),
      h.service.accept('B', challenge.id, cmd()),
    ]);

    expect(h.matches.size).toBe(1);
    expect(h.matchCreation.createSecuredMatch).toHaveBeenCalledTimes(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(ConflictException);
    }
  });

  it('duplicate accept commandId returns the same match without creating another', async () => {
    const { challenge } = await h.service.create('A', 'B', cmd());
    const commandId = cmd();
    const first = await h.service.accept('B', challenge.id, commandId);
    const second = await h.service.accept('B', challenge.id, commandId);

    expect(second.duplicate).toBe(true);
    expect(second.challenge.match?.id).toBe(first.challenge.match?.id);
    expect(h.matchCreation.createSecuredMatch).toHaveBeenCalledTimes(1);
  });

  it('cancel during an in-flight accept is refused and the accept wins', async () => {
    const { challenge } = await h.service.create('A', 'B', cmd());
    const release = h.holdMatchCreation();
    const accepting = h.service.accept('B', challenge.id, cmd());
    await waitUntil(() => h.matchCreation.createSecuredMatch.mock.calls.length > 0);

    await expect(h.service.cancel('A', challenge.id, cmd())).rejects.toMatchObject({
      response: { code: 'CHALLENGE_NOT_PENDING' },
    });
    release();
    const accepted = await accepting;

    expect(accepted.event).toBe('challenge:accepted');
    expect(h.matches.size).toBe(1);
  });

  it('disconnect during an in-flight accept does not cancel it', async () => {
    const { challenge } = await h.service.create('A', 'B', cmd());
    const release = h.holdMatchCreation();
    const accepting = h.service.accept('B', challenge.id, cmd());
    await waitUntil(() => h.matchCreation.createSecuredMatch.mock.calls.length > 0);

    expect(await h.service.cancelForUser('A')).toBeNull();
    release();
    expect((await accepting).event).toBe('challenge:accepted');
  });

  it('a cancelled challenge cannot be accepted and both players return to READY', async () => {
    const { challenge } = await h.service.create('A', 'B', cmd());
    const cancelled = await h.service.cancel('A', challenge.id, cmd());

    expect(cancelled.restoredPlayers.map((p) => p.userId).sort()).toEqual(['A', 'B']);
    await expect(h.service.accept('B', challenge.id, cmd())).rejects.toMatchObject({
      response: { code: 'CHALLENGE_NOT_PENDING' },
    });
    expect(await h.state('A')).toBe('READY');
    expect(await h.state('B')).toBe('READY');
    expect(h.matches.size).toBe(0);
  });

  it('reject restores both players to READY', async () => {
    const { challenge } = await h.service.create('A', 'B', cmd());
    const rejected = await h.service.reject('B', challenge.id, cmd());
    expect(rejected.challenge.status).toBe('REJECTED');
    expect(await h.state('A')).toBe('READY');
    expect(await h.state('B')).toBe('READY');
  });

  it('disconnect cancel does not restore the player who left', async () => {
    await h.service.create('A', 'B', cmd());
    const cancelled = await h.service.cancelForUser('A');
    expect(cancelled?.restoredPlayers.map((p) => p.userId)).toEqual(['B']);
  });

  it('sweep expires unanswered challenges; later accept fails', async () => {
    const { challenge } = await h.service.create('A', 'B', cmd());
    const transitions = await h.service.sweep(challenge.expiresAtMs + 1);

    expect(transitions.map((t) => t.event)).toEqual(['challenge:expired']);
    await expect(h.service.accept('B', challenge.id, cmd())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(h.matches.size).toBe(0);
  });

  it('accept after expiry (before the sweep) fails and reports the expiry', async () => {
    const { challenge } = await h.service.create('A', 'B', cmd());
    const realNow = Date.now;
    Date.now = () => challenge.expiresAtMs + 1;
    try {
      const error = await h.service.accept('B', challenge.id, cmd()).catch((e) => e);
      expect(error).toBeInstanceOf(ChallengeAcceptFailedError);
      expect(error.transition.event).toBe('challenge:expired');
    } finally {
      Date.now = realNow;
    }
    expect(h.matches.size).toBe(0);
  });

  it('failed match creation cancels, keeps eligible players READY and routes committed ones to their match', async () => {
    const { challenge } = await h.service.create('A', 'B', cmd());
    h.committedUsers.add('A');
    h.matchCreation.createSecuredMatch.mockRejectedValueOnce(
      new ConflictException({ code: 'LOBBY_ACTIVE_MATCH' }),
    );

    const error = await h.service.accept('B', challenge.id, cmd()).catch((e) => e);
    expect(error).toBeInstanceOf(ChallengeAcceptFailedError);
    expect(error.transition.event).toBe('challenge:cancelled');
    expect(error.transition.restoredPlayers.map((p: any) => p.userId)).toEqual(['B']);
    expect(error.transition.leftUserIds).toEqual(['A']);
    expect(error.transition.matchReady).toEqual([
      { userId: 'A', match: expect.objectContaining({ id: 'other-A' }) },
    ]);
    expect(await h.state('A')).toBeNull();
    expect(await h.state('B')).toBe('READY');
  });

  it('sweep resolves a stale ACCEPTING challenge from the database outcome', async () => {
    const withMatch = await h.service.create('A', 'B', cmd());
    // Simulate a process that died after claiming: the match committed, Redis cleanup never ran.
    await h.redis
      .raw()
      .set(
        h.redis.key('challenge', withMatch.challenge.id),
        JSON.stringify({ ...withMatch.challenge, status: 'ACCEPTING', acceptingAtMs: 0 }),
      );
    h.matches.set(withMatch.challenge.id, {
      id: 'match-x',
      participants: [
        { userId: 'A', seat: 0 },
        { userId: 'B', seat: 1 },
      ],
    });

    const [accepted] = await h.service.sweep(withMatch.challenge.expiresAtMs + 1);
    expect(accepted.event).toBe('challenge:accepted');
    expect(await h.state('A')).toBeNull();
  });

  it('sweep releases a stale ACCEPTING challenge that never produced a match', async () => {
    const { challenge } = await h.service.create('A', 'B', cmd());
    await h.redis
      .raw()
      .set(
        h.redis.key('challenge', challenge.id),
        JSON.stringify({ ...challenge, status: 'ACCEPTING', acceptingAtMs: 0 }),
      );

    const [released] = await h.service.sweep(challenge.expiresAtMs + 1);
    expect(released.event).toBe('challenge:cancelled');
    expect(await h.state('A')).toBe('READY');
    expect(await h.state('B')).toBe('READY');
  });

  it('a young ACCEPTING challenge is left alone by the sweep', async () => {
    const { challenge } = await h.service.create('A', 'B', cmd());
    await h.redis
      .raw()
      .set(
        h.redis.key('challenge', challenge.id),
        JSON.stringify({ ...challenge, status: 'ACCEPTING', acceptingAtMs: Date.now() }),
      );
    expect(await h.service.sweep(challenge.expiresAtMs + 1)).toEqual([]);
  });

  it('rejects create when a player already holds a committed match', async () => {
    h.committedUsers.add('A');
    await expect(h.service.create('A', 'B', cmd())).rejects.toMatchObject({
      response: { code: 'LOBBY_ACTIVE_MATCH' },
    });
  });
});
