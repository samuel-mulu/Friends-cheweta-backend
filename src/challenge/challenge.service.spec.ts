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

async function createHarness(playerCount = 2, users = ['A', 'B', 'C']) {
  const { redis, cleanup } = await createTestRedis();
  const committedUsers = new Set<string>();
  const matches = new Map<string, any>();

  const finishedMatches = new Map<string, any>();
  const prisma = {
    match: { findUnique: jest.fn(async ({ where }: any) => finishedMatches.get(where.id) ?? null) },
    gameMode: {
      findUnique: jest.fn(async () => ({
        id: MODE,
        code: playerCount > 2 ? `LUDO_${playerCount}P` : 'LUDO_1V1',
        name: 'Ludo',
        playerCount,
        rulesVersion: 'LUDO_CLASSIC_V3',
        stakeAmountMinor: 100n,
        enabled: true,
        // 1v1 stays game-neutral (no Ludo goal defaults); tables are Ludo.
        game: { enabled: true, code: playerCount > 2 ? 'LUDO' : 'GAME' },
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
    createSecuredMatch: jest.fn(
      async ({ challengeId, playerIds, source, rematchOfMatchId }: any) => {
        if (creationGate) await creationGate;
        if (matches.has(challengeId)) throw new Error('P2002 challengeId');
        const match = {
          source,
          rematchOfMatchId,
          id: `match-${challengeId}`,
          gameModeId: MODE,
          status: 'READY',
          participants: playerIds.map((userId: string, seat: number) => ({ userId, seat })),
        };
        matches.set(challengeId, match);
        return match;
      },
    ),
  };

  const lobby = new LobbyService(prisma as any, redis);
  const service = new ChallengeService(prisma as any, redis, lobby, matchCreation as any);
  for (const userId of users) {
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
    finishedMatches,
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

  it('a player who is only online can challenge a ready player in one step', async () => {
    await h.lobby.unready('A');
    const { challenge } = await h.service.create('A', 'B', cmd());
    expect(challenge.status).toBe('PENDING');
    expect(await h.state('A')).toBe('CHALLENGED');

    // If the challenge ends, the challenger is left READY (they wanted to play).
    await h.service.reject('B', challenge.id, cmd());
    expect(await h.state('A')).toBe('READY');
  });

  it('the target must still be ready', async () => {
    await h.lobby.unready('B');
    await expect(h.service.create('A', 'B', cmd())).rejects.toMatchObject({
      response: { code: 'CHALLENGE_TARGET_NOT_READY' },
    });
  });

  it('the chosen goal (first to N home) is carried to the match; default is 4', async () => {
    const classic = await h.service.create('A', 'B', cmd());
    expect(classic.challenge.tokensToWin).toBe(4);
    await h.service.cancel('A', classic.challenge.id, cmd());

    const { challenge } = await h.service.create('A', 'B', cmd(), 2);
    expect(challenge.tokensToWin).toBe(2);
    await h.service.accept('B', challenge.id, cmd());
    expect(h.matchCreation.createSecuredMatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ tokensToWin: 2 }),
    );
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

  describe('rematch', () => {
    const finish = (id = 'old-1', finishedAgoMs = 1_000) =>
      h.finishedMatches.set(id, {
        status: 'FINISHED',
        gameModeId: MODE,
        finishedAt: new Date(Date.now() - finishedAgoMs),
        tokensToWin: 3,
        participants: [{ userId: 'A' }, { userId: 'B' }],
      });

    it('a rematch keeps the previous goal', async () => {
      finish();
      const { challenge } = await h.service.createRematch('A', 'old-1', cmd());
      expect(challenge.tokensToWin).toBe(3);
      await h.service.accept('B', challenge.id, cmd());
      expect(h.matchCreation.createSecuredMatch).toHaveBeenLastCalledWith(
        expect.objectContaining({ tokensToWin: 3 }),
      );
    });

    it('accepting creates exactly one new match linked to the previous one', async () => {
      finish();
      const { challenge } = await h.service.createRematch('A', 'old-1', cmd());
      expect(challenge).toMatchObject({ kind: 'REMATCH', opponentId: 'B', sourceMatchId: 'old-1' });

      const accepted = await h.service.accept('B', challenge.id, cmd());
      expect(accepted.challenge.match).toMatchObject({
        source: 'REMATCH',
        rematchOfMatchId: 'old-1',
      });

      const again = await h.service.accept('B', challenge.id, cmd());
      expect(again.challenge.match?.id).toBe(accepted.challenge.match?.id);
      expect(h.matchCreation.createSecuredMatch).toHaveBeenCalledTimes(1);
    });

    it('both players requesting at once yields one pending rematch', async () => {
      finish();
      const results = await Promise.allSettled([
        h.service.createRematch('A', 'old-1', cmd()),
        h.service.createRematch('B', 'old-1', cmd()),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
      expect(rejected.reason).toMatchObject({ response: { code: 'CHALLENGE_ALREADY_PENDING' } });
    });

    it('is recoverable after reconnect and can be rejected cleanly', async () => {
      finish();
      const { challenge } = await h.service.createRematch('A', 'old-1', cmd());
      expect((await h.service.activeForUser('B'))?.id).toBe(challenge.id);

      await h.service.reject('B', challenge.id, cmd());
      expect(await h.service.activeForUser('B')).toBeNull();
      await expect(h.service.accept('B', challenge.id, cmd())).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('only participants of a recently finished match can request it', async () => {
      finish();
      await expect(h.service.createRematch('C', 'old-1', cmd())).rejects.toMatchObject({
        response: { code: 'MATCH_ACCESS_DENIED' },
      });
      h.finishedMatches.set('live', { ...h.finishedMatches.get('old-1'), status: 'PLAYING' });
      await expect(h.service.createRematch('A', 'live', cmd())).rejects.toMatchObject({
        response: { code: 'REMATCH_NOT_AVAILABLE' },
      });
      finish('stale', 60 * 60_000);
      await expect(h.service.createRematch('A', 'stale', cmd())).rejects.toMatchObject({
        response: { code: 'REMATCH_EXPIRED' },
      });
    });

    it('expires when unanswered', async () => {
      finish();
      const { challenge } = await h.service.createRematch('A', 'old-1', cmd());
      const [expired] = await h.service.sweep(challenge.expiresAtMs + 1);
      expect(expired.event).toBe('challenge:expired');
      expect(await h.service.activeForUser('A')).toBeNull();
    });
  });

  describe('invite', () => {
    it('joining by code (any case/format) creates the match with the inviter', async () => {
      const { challenge } = await h.service.createInvite('A', MODE, cmd(), 1);
      expect(challenge.tokensToWin).toBe(1);
      expect(challenge.inviteCode).toMatch(/^[A-Z2-9]{10}$/);

      const typed = `${challenge.inviteCode!.slice(0, 5).toLowerCase()}-${challenge.inviteCode!.slice(5)}`;
      const joined = await h.service.joinInvite('C', typed, cmd());

      expect(joined.challenge.match).toMatchObject({ source: 'INVITE' });
      expect(joined.matchReady.map((m) => m.userId).sort()).toEqual(['A', 'C']);
    });

    it('two players joining the same code at once create one match', async () => {
      const { challenge } = await h.service.createInvite('A', MODE, cmd());
      const results = await Promise.allSettled([
        h.service.joinInvite('B', challenge.inviteCode!, cmd()),
        h.service.joinInvite('C', challenge.inviteCode!, cmd()),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(h.matches.size).toBe(1);
    });

    it('rejects own code, unknown codes, and cancelled invites', async () => {
      const { challenge } = await h.service.createInvite('A', MODE, cmd());
      await expect(h.service.joinInvite('A', challenge.inviteCode!, cmd())).rejects.toMatchObject({
        response: { code: 'INVITE_SELF' },
      });
      await expect(h.service.joinInvite('B', 'ZZZZZZZZZZ', cmd())).rejects.toMatchObject({
        response: { code: 'INVITE_NOT_FOUND' },
      });

      await h.service.cancel('A', challenge.id, cmd());
      await expect(h.service.joinInvite('B', challenge.inviteCode!, cmd())).rejects.toMatchObject({
        response: { code: 'CHALLENGE_NOT_PENDING' },
      });
      expect(h.matches.size).toBe(0);
    });

    it('an inviter cannot hold two open invites', async () => {
      await h.service.createInvite('A', MODE, cmd());
      await expect(h.service.createInvite('A', MODE, cmd())).rejects.toMatchObject({
        response: { code: 'CHALLENGE_ALREADY_PENDING' },
      });
    });

    it('disconnecting cancels a pending invite', async () => {
      const { challenge } = await h.service.createInvite('A', MODE, cmd());
      expect((await h.service.cancelForUser('A'))?.event).toBe('challenge:cancelled');
      await expect(h.service.joinInvite('B', challenge.inviteCode!, cmd())).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  /** A, B and C are READY at the same stake (in that order), auto-match on by default. */
  describe('automatic matching', () => {
    /** Change what a ready player asked for (e.g. the Ludo goal) in place. */
    const setPrefs = async (userId: string, prefs: Record<string, unknown>) => {
      const context = await h.lobby.getContext(userId);
      await h.redis
        .raw()
        .set(h.redis.key('lobby', 'user', userId), JSON.stringify({ ...context, ...prefs }), {
          EX: 180,
        });
    };
    const matched = () =>
      [...h.matches.values()].map((m) => m.participants.map((p: any) => p.userId).sort());

    it('pairs a newly ready player with the one who waited longest and starts the match', async () => {
      const result = await h.service.autoPair('C');
      expect(result?.event).toBe('challenge:accepted');
      expect(result?.challenge).toMatchObject({ kind: 'AUTO', challengerId: 'A', opponentId: 'C' });
      expect(matched()).toEqual([['A', 'C']]);
      expect(result?.matchReady.map((m) => m.userId).sort()).toEqual(['A', 'C']);
      expect(await h.state('A')).toBeNull();
      expect(await h.state('B')).toBe('READY');
    });

    it('pairs only the same terms: auto-match on for both, and the same goal', async () => {
      await setPrefs('A', { autoMatch: false });
      await setPrefs('B', { tokensToWin: 2 });
      await setPrefs('C', { tokensToWin: 4 });
      expect(await h.service.autoPair('C')).toBeNull();
      await setPrefs('C', { tokensToWin: 2 });
      expect((await h.service.autoPair('C'))?.challenge).toMatchObject({
        challengerId: 'B',
        opponentId: 'C',
        tokensToWin: 2,
      });
      expect(h.matchCreation.createSecuredMatch).toHaveBeenLastCalledWith(
        expect.objectContaining({ tokensToWin: 2 }),
      );
    });

    it('a player who turned auto-match off is never paired automatically', async () => {
      await setPrefs('C', { autoMatch: false });
      expect(await h.service.autoPair('C')).toBeNull();
      expect(h.matchCreation.createSecuredMatch).not.toHaveBeenCalled();
    });

    it('a manual request racing a pairing: each player ends up in exactly one of them', async () => {
      const [manual, auto] = await Promise.allSettled([
        h.service.create('B', 'A', cmd()),
        h.service.autoPair('C'),
      ]);
      const pairedWithA = matched().some((players) => players.includes('A'));
      if (manual.status === 'fulfilled') {
        // The request reserved A and B first: C finds nobody free.
        expect(pairedWithA).toBe(false);
        expect(await h.state('A')).toBe('CHALLENGED');
        expect(await h.state('C')).toBe('READY');
      } else {
        // The pairing took A first: the request was refused cleanly.
        expect(auto.status === 'fulfilled' && auto.value?.challenge.opponentId).toBe('C');
        expect(manual.reason).toBeInstanceOf(ConflictException);
        expect(await h.state('B')).toBe('READY');
      }
    });

    it('players readying at the same moment are each in at most one match', async () => {
      await Promise.all([
        h.service.autoPair('A'),
        h.service.autoPair('B'),
        h.service.autoPair('C'),
      ]);
      const everyone = matched().flat();
      expect(everyone.length).toBeGreaterThanOrEqual(2);
      expect(new Set(everyone).size).toBe(everyone.length);
      expect(h.matchCreation.createSecuredMatch).toHaveBeenCalledTimes(matched().length);
    });

    it('a pairing whose match cannot start returns both to READY and pairs someone else next', async () => {
      h.matchCreation.createSecuredMatch.mockRejectedValueOnce(new Error('database down'));
      const failed = await h.service.autoPair('C');
      expect(failed?.event).toBe('challenge:cancelled');
      expect(failed?.restoredPlayers.map((p) => p.userId).sort()).toEqual(['A', 'C']);
      expect(await h.state('A')).toBe('READY');

      // A and C cool down; C is paired with B instead.
      expect((await h.service.autoPair('C'))?.challenge).toMatchObject({
        challengerId: 'B',
        opponentId: 'C',
      });
    });

    it('someone who just declined a player is not auto-paired with them right away', async () => {
      const { challenge } = await h.service.create('B', 'A', cmd());
      await h.service.reject('A', challenge.id, cmd());
      // B is skipped (cooldown); C, who has waited longest, is paired with A.
      expect((await h.service.autoPair('A'))?.challenge).toMatchObject({
        challengerId: 'C',
        opponentId: 'A',
      });
      expect(matched()).toEqual([['A', 'C']]);
    });

    it('a manual request plays the goal the waiting player chose', async () => {
      await setPrefs('B', { tokensToWin: 1 });
      const { challenge } = await h.service.create('A', 'B', cmd(), 4);
      expect(challenge.tokensToWin).toBe(1);
    });
  });
});

/** A 4-player Ludo table: it starts only when four players are ready at the same terms. */
describe('ChallengeService: 4-player table (real Redis Lua)', () => {
  let t: Awaited<ReturnType<typeof createHarness>>;
  afterEach(async () => {
    await t.cleanup();
  });
  const seated = () => [...t.matches.values()].map((m) => m.participants.map((p: any) => p.userId));

  it('waits until every seat can be filled, then seats the longest waiting first', async () => {
    t = await createHarness(4, ['A', 'B', 'C']);
    expect(await t.service.autoPair('C')).toBeNull();
    expect(await t.state('A')).toBe('READY');

    await t.lobby.join('D', MODE);
    await t.lobby.ready('D');
    const result = await t.service.autoPair('D');
    expect(result?.event).toBe('challenge:accepted');
    expect(result?.challenge.playerIds).toEqual(['A', 'B', 'C', 'D']);
    expect(seated()).toEqual([['A', 'B', 'C', 'D']]);
    expect(result?.matchReady.map((m) => m.userId).sort()).toEqual(['A', 'B', 'C', 'D']);
    for (const id of ['A', 'B', 'C', 'D']) expect(await t.state(id)).toBeNull();
  });

  it('players readying at the same moment fill one table, nobody twice', async () => {
    t = await createHarness(4, ['A', 'B', 'C', 'D', 'E']);
    await Promise.all(['A', 'B', 'C', 'D', 'E'].map((id) => t.service.autoPair(id)));
    const everyone = seated().flat();
    expect(seated()).toHaveLength(1);
    expect(new Set(everyone).size).toBe(4);
  });

  it('a table that cannot start returns all four to READY', async () => {
    t = await createHarness(4, ['A', 'B', 'C', 'D']);
    t.matchCreation.createSecuredMatch.mockRejectedValueOnce(new Error('database down'));
    const failed = await t.service.autoPair('D');
    expect(failed?.event).toBe('challenge:cancelled');
    expect(failed?.restoredPlayers.map((p) => p.userId).sort()).toEqual(['A', 'B', 'C', 'D']);
    for (const id of ['A', 'B', 'C', 'D']) expect(await t.state(id)).toBe('READY');
  });

  it('has no 1v1 requests or invites', async () => {
    t = await createHarness(4, ['A', 'B']);
    await expect(t.service.create('A', 'B', cmd())).rejects.toMatchObject({
      response: { code: 'TABLE_AUTO_ONLY' },
    });
    await expect(t.service.createInvite('A', MODE, cmd())).rejects.toMatchObject({
      response: { code: 'TABLE_AUTO_ONLY' },
    });
  });
});
