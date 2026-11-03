import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { COMMITTED_MATCH_STATUSES } from '../common/match-status';
import { LobbyService } from '../lobby/lobby.service';
import { LOBBY_TTL_SECONDS } from '../lobby/lobby.types';
import { MatchCreationService } from '../match-creation/match-creation.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import {
  ChallengeAcceptFailedError,
  ChallengeEventName,
  ChallengeRecord,
  ChallengeTransition,
  ChallengeView,
} from './challenge.types';

type MatchSummary = { id: string; participants?: Array<{ userId: string; seat: number }> } & Record<
  string,
  unknown
>;

/** How long an opponent has to answer. */
const CHALLENGE_TTL_MS = 15_000;
/** Redis retention for challenge records/reservations; status transitions, not TTLs, end a challenge. */
const RECORD_TTL_SECONDS = 300;
/** An ACCEPTING challenge older than this is resolved by the sweep (match creation is bounded well below it). */
const STALE_ACCEPTING_MS = 60_000;
const COMMAND_TTL_SECONDS = 300;

@Injectable()
export class ChallengeService {
  private readonly logger = new Logger(ChallengeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly lobby: LobbyService,
    private readonly matchCreation: MatchCreationService,
  ) {}

  async create(
    challengerId: string,
    opponentId: string,
    commandId: string,
  ): Promise<{ challenge: ChallengeView; duplicate: boolean }> {
    const duplicate = await this.commandResult(commandId, challengerId);
    if (duplicate) return { challenge: await this.view(duplicate.challengeId), duplicate: true };
    if (challengerId === opponentId)
      throw new ConflictException({
        code: 'CHALLENGE_SELF_NOT_ALLOWED',
        message: 'You cannot challenge yourself.',
      });

    const [challenger, opponent] = await Promise.all([
      this.lobby.requireContext(challengerId),
      this.lobby.requireContext(opponentId),
    ]);
    if (challenger.gameModeId !== opponent.gameModeId)
      throw new ConflictException({
        code: 'LOBBY_DIFFERENT_MODE',
        message: 'Player is in a different lobby.',
      });
    await this.lobby.assertCanPlay([challengerId, opponentId], challenger.gameModeId);

    const now = Date.now();
    const record: ChallengeRecord = {
      id: randomUUID(),
      gameModeId: challenger.gameModeId,
      challengerId,
      opponentId,
      status: 'PENDING',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + CHALLENGE_TTL_MS).toISOString(),
      expiresAtMs: now + CHALLENGE_TTL_MS,
    };

    const result = (await this.redis.raw().eval(RESERVE_SCRIPT, {
      keys: [
        this.contextKey(challengerId),
        this.contextKey(opponentId),
        this.reservationKey(challengerId),
        this.reservationKey(opponentId),
        this.challengeKey(record.id),
        this.readyKey(record.gameModeId),
        this.expiresKey(),
      ],
      arguments: [
        JSON.stringify(record),
        record.id,
        String(record.expiresAtMs),
        String(RECORD_TTL_SECONDS),
        String(LOBBY_TTL_SECONDS),
      ],
    })) as string;
    if (result !== 'OK')
      throw new ConflictException({ code: result, message: 'Challenge could not be created.' });
    await this.storeCommand(commandId, challengerId, record.id);
    return { challenge: await this.toView(record), duplicate: false };
  }

  /**
   * Exactly one accept can claim PENDING → ACCEPTING; the database
   * (Match.challengeId UNIQUE) decides whether a match exists. Either a
   * transition is returned, or ChallengeAcceptFailedError carries the cleanup.
   */
  async accept(
    userId: string,
    challengeId: string,
    commandId: string,
  ): Promise<ChallengeTransition & { duplicate: boolean }> {
    const duplicate = await this.commandResult(commandId, userId);
    const existing = await this.findMatch(challengeId);
    if (existing) {
      if (!existing.participants?.some((participant) => participant.userId === userId)) {
        throw new ForbiddenException({
          code: 'CHALLENGE_NOT_OPPONENT',
          message: 'Only opponent can accept.',
        });
      }
      const transition = await this.markAccepted(challengeId, existing);
      await this.storeCommand(commandId, userId, challengeId);
      return { ...transition, duplicate: Boolean(duplicate) };
    }
    if (duplicate)
      throw new ConflictException({
        code: 'CHALLENGE_NOT_PENDING',
        message: 'Challenge is no longer pending.',
      });

    const challenge = await this.requireRecord(challengeId);
    if (challenge.opponentId !== userId)
      throw new ForbiddenException({
        code: 'CHALLENGE_NOT_OPPONENT',
        message: 'Only opponent can accept.',
      });

    const claim = (await this.redis.raw().eval(CLAIM_ACCEPT_SCRIPT, {
      keys: [
        this.challengeKey(challengeId),
        this.reservationKey(challenge.challengerId),
        this.reservationKey(challenge.opponentId),
      ],
      arguments: [challengeId, String(Date.now()), String(RECORD_TTL_SECONDS)],
    })) as string;
    if (claim === 'CHALLENGE_EXPIRED') {
      const expired = await this.finish(challenge, 'EXPIRED', 'challenge:expired');
      throw new ChallengeAcceptFailedError(
        new ConflictException({ code: 'CHALLENGE_EXPIRED', message: 'Challenge has expired.' }),
        expired ?? this.emptyTransition(challenge, 'challenge:expired'),
      );
    }
    if (claim !== 'OK')
      throw new ConflictException({ code: claim, message: 'Challenge is no longer pending.' });

    this.logger.log(`challenge_accept_started challenge=${challengeId} command=${commandId}`);
    let match: MatchSummary;
    try {
      match = (await this.matchCreation.createSecuredMatch({
        gameModeId: challenge.gameModeId,
        playerIds: [challenge.challengerId, challenge.opponentId],
        challengeId,
        source: 'CHALLENGE',
      })) as MatchSummary;
    } catch (error) {
      // The transaction may have committed even though the call failed.
      const committed = await this.findMatch(challengeId).catch(() => null);
      if (!committed) {
        this.logger.warn(
          `challenge_accept_failed challenge=${challengeId} reason=${error instanceof Error ? error.message : 'unknown'}`,
        );
        throw new ChallengeAcceptFailedError(error, await this.releaseFailedAccept(challenge));
      }
      match = committed;
    }

    const transition = await this.markAccepted(challengeId, match);
    await this.storeCommand(commandId, userId, challengeId);
    this.logger.log(`challenge_match_created challenge=${challengeId} match=${match.id}`);
    return { ...transition, duplicate: false };
  }

  async reject(
    userId: string,
    challengeId: string,
    commandId: string,
  ): Promise<ChallengeTransition & { duplicate: boolean }> {
    return this.userTerminal(
      userId,
      challengeId,
      commandId,
      'opponentId',
      'REJECTED',
      'challenge:rejected',
    );
  }

  async cancel(
    userId: string,
    challengeId: string,
    commandId: string,
  ): Promise<ChallengeTransition & { duplicate: boolean }> {
    return this.userTerminal(
      userId,
      challengeId,
      commandId,
      'challengerId',
      'CANCELLED',
      'challenge:cancelled',
    );
  }

  /** Disconnect/leave: cancel a PENDING challenge. An in-flight accept is left to finish. */
  async cancelForUser(userId: string): Promise<ChallengeTransition | null> {
    const challengeId = await this.redis.raw().get(this.reservationKey(userId));
    if (!challengeId) return null;
    const challenge = await this.redis.getJson<ChallengeRecord>(this.challengeKey(challengeId));
    if (!challenge) return null;
    return this.finish(challenge, 'CANCELLED', 'challenge:cancelled', { excludeUserId: userId });
  }

  async activeForUser(userId: string): Promise<ChallengeView | null> {
    const challengeId = await this.redis.raw().get(this.reservationKey(userId));
    if (!challengeId) return null;
    const challenge = await this.redis.getJson<ChallengeRecord>(this.challengeKey(challengeId));
    return challenge && (challenge.status === 'PENDING' || challenge.status === 'ACCEPTING')
      ? this.toView(challenge)
      : null;
  }

  /** Periodic sweep: expire unanswered challenges and resolve stuck accepts. */
  async sweep(nowMs = Date.now()): Promise<ChallengeTransition[]> {
    const ids = await this.redis
      .raw()
      .zRangeByScore(this.expiresKey(), 0, nowMs, { LIMIT: { offset: 0, count: 25 } });
    const transitions: ChallengeTransition[] = [];
    for (const id of ids) {
      try {
        const transition = await this.sweepOne(id, nowMs);
        if (transition) transitions.push(transition);
      } catch (error) {
        this.logger.warn(
          `challenge_sweep_failed challenge=${id} reason=${(error as Error).message}`,
        );
      }
    }
    return transitions;
  }

  private async sweepOne(id: string, nowMs: number): Promise<ChallengeTransition | null> {
    const challenge = await this.redis.getJson<ChallengeRecord>(this.challengeKey(id));
    if (!challenge || (challenge.status !== 'PENDING' && challenge.status !== 'ACCEPTING')) {
      await this.redis.raw().zRem(this.expiresKey(), id);
      return null;
    }
    if (challenge.status === 'PENDING')
      return this.finish(challenge, 'EXPIRED', 'challenge:expired');
    if (nowMs - (challenge.acceptingAtMs ?? 0) < STALE_ACCEPTING_MS) return null;

    // The accepting process died. PostgreSQL decides the outcome.
    const match = await this.findMatch(id);
    if (match) return this.markAccepted(id, match);
    this.logger.warn(`challenge_stale_accept_released challenge=${id}`);
    return this.releaseFailedAccept(challenge);
  }

  private async userTerminal(
    userId: string,
    challengeId: string,
    commandId: string,
    role: 'challengerId' | 'opponentId',
    status: 'REJECTED' | 'CANCELLED',
    event: ChallengeEventName,
  ): Promise<ChallengeTransition & { duplicate: boolean }> {
    const challenge = await this.requireRecord(challengeId);
    const duplicate = await this.commandResult(commandId, userId);
    if (duplicate && challenge.status === status) {
      return { ...this.emptyTransition(await this.toView(challenge), event), duplicate: true };
    }
    if (challenge[role] !== userId) {
      throw new ForbiddenException({
        code: role === 'opponentId' ? 'CHALLENGE_NOT_OPPONENT' : 'CHALLENGE_NOT_CHALLENGER',
        message: 'You cannot change this challenge.',
      });
    }
    const transition = await this.finish(challenge, status, event);
    if (!transition)
      throw new ConflictException({
        code: 'CHALLENGE_NOT_PENDING',
        message: 'Challenge is no longer pending.',
      });
    await this.storeCommand(commandId, userId, challengeId);
    return { ...transition, duplicate: false };
  }

  /**
   * Atomically end a challenge and return CHALLENGED players to READY. Returns
   * null when the challenge already left PENDING (or is ACCEPTING and
   * `allowAccepting` is not set).
   */
  private async finish(
    challenge: ChallengeRecord,
    status: 'REJECTED' | 'CANCELLED' | 'EXPIRED',
    event: ChallengeEventName,
    options: { allowAccepting?: boolean; excludeUserId?: string } = {},
  ): Promise<ChallengeTransition | null> {
    const now = Date.now();
    const result = (await this.redis.raw().eval(TERMINAL_SCRIPT, {
      keys: [
        this.challengeKey(challenge.id),
        this.reservationKey(challenge.challengerId),
        this.reservationKey(challenge.opponentId),
        this.contextKey(challenge.challengerId),
        this.contextKey(challenge.opponentId),
        this.readyKey(challenge.gameModeId),
        this.expiresKey(),
      ],
      arguments: [
        challenge.id,
        status,
        String(RECORD_TTL_SECONDS),
        String(now),
        new Date(now).toISOString(),
        options.allowAccepting ? '1' : '0',
        options.excludeUserId ?? '',
        String(LOBBY_TTL_SECONDS),
      ],
    })) as string | string[];
    if (!Array.isArray(result)) return null;
    const restoredIds = result.slice(1);
    return {
      event,
      challenge: await this.toView({ ...challenge, status }),
      restoredPlayers: await this.lobby.playerViews(restoredIds),
      leftUserIds: [],
      matchReady: [],
    };
  }

  /** Record the durable match on the challenge and take both players out of the lobby. Idempotent. */
  private async markAccepted(
    challengeId: string,
    match: MatchSummary,
  ): Promise<ChallengeTransition> {
    const participants = [...(match.participants ?? [])].sort((a, b) => a.seat - b.seat);
    const stored = await this.redis.getJson<ChallengeRecord>(this.challengeKey(challengeId));
    const record: ChallengeRecord = stored ?? {
      id: challengeId,
      gameModeId: typeof match.gameModeId === 'string' ? match.gameModeId : '',
      challengerId: participants[0]?.userId ?? '',
      opponentId: participants[1]?.userId ?? '',
      status: 'ACCEPTED',
      createdAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
      expiresAtMs: Date.now(),
    };
    if (stored) {
      await this.redis.raw().eval(ACCEPTED_SCRIPT, {
        keys: [
          this.challengeKey(challengeId),
          this.reservationKey(record.challengerId),
          this.reservationKey(record.opponentId),
          this.contextKey(record.challengerId),
          this.contextKey(record.opponentId),
          this.readyKey(record.gameModeId),
          this.expiresKey(),
        ],
        arguments: [challengeId, match.id, String(RECORD_TTL_SECONDS)],
      });
    }
    const playerIds = [record.challengerId, record.opponentId];
    return {
      event: 'challenge:accepted',
      challenge: {
        ...(await this.toView({ ...record, status: 'ACCEPTED', matchId: match.id })),
        match,
      },
      restoredPlayers: [],
      leftUserIds: playerIds,
      matchReady: playerIds.map((userId) => ({ userId, match })),
    };
  }

  /**
   * Match creation failed: cancel (allowed from ACCEPTING), keep eligible
   * players READY, and move players that already hold another match out of
   * the lobby and back to that match.
   */
  private async releaseFailedAccept(challenge: ChallengeRecord): Promise<ChallengeTransition> {
    const transition =
      (await this.finish(challenge, 'CANCELLED', 'challenge:cancelled', {
        allowAccepting: true,
      })) ??
      this.emptyTransition(
        await this.toView({ ...challenge, status: 'CANCELLED' }),
        'challenge:cancelled',
      );

    const committed = await this.prisma.matchParticipant.findMany({
      where: {
        userId: { in: [challenge.challengerId, challenge.opponentId] },
        match: { status: { in: COMMITTED_MATCH_STATUSES } },
      },
      select: { userId: true },
    });
    for (const { userId } of committed) {
      await this.lobby.leave(userId).catch(() => undefined);
      transition.leftUserIds.push(userId);
      const activeMatch = await this.lobby.activeMatchForUser(userId).catch(() => null);
      if (activeMatch) transition.matchReady.push({ userId, match: activeMatch });
    }
    transition.restoredPlayers = transition.restoredPlayers.filter(
      (player) => !transition.leftUserIds.includes(player.userId),
    );
    return transition;
  }

  private async findMatch(challengeId: string): Promise<MatchSummary | null> {
    return (await this.matchCreation.findByChallengeId(challengeId)) as MatchSummary | null;
  }

  private emptyTransition(
    challenge: ChallengeView | ChallengeRecord,
    event: ChallengeEventName,
  ): ChallengeTransition {
    return { event, challenge, restoredPlayers: [], leftUserIds: [], matchReady: [] };
  }

  private async requireRecord(challengeId: string): Promise<ChallengeRecord> {
    const challenge = await this.redis.getJson<ChallengeRecord>(this.challengeKey(challengeId));
    if (!challenge)
      throw new NotFoundException({ code: 'CHALLENGE_NOT_FOUND', message: 'Challenge not found.' });
    return challenge;
  }

  private async view(challengeId: string): Promise<ChallengeView> {
    return this.toView(await this.requireRecord(challengeId));
  }

  private async toView(challenge: ChallengeRecord): Promise<ChallengeView> {
    const users = await this.prisma.user.findMany({
      where: { id: { in: [challenge.challengerId, challenge.opponentId] } },
      select: { id: true, fullName: true },
    });
    const name = (id: string) => users.find((user) => user.id === id)?.fullName;
    return {
      ...challenge,
      challengerName: name(challenge.challengerId),
      opponentName: name(challenge.opponentId),
    };
  }

  private async commandResult(
    commandId: string,
    userId: string,
  ): Promise<{ challengeId: string } | null> {
    return this.redis.getJson<{ challengeId: string }>(this.commandKey(userId, commandId));
  }

  private async storeCommand(
    commandId: string,
    userId: string,
    challengeId: string,
  ): Promise<void> {
    await this.redis.setJson(
      this.commandKey(userId, commandId),
      { challengeId },
      COMMAND_TTL_SECONDS,
    );
  }

  private challengeKey(id: string): string {
    return this.redis.key('challenge', id);
  }
  private reservationKey(userId: string): string {
    return this.redis.key('challenge', 'user', userId);
  }
  private expiresKey(): string {
    return this.redis.key('challenge', 'expires');
  }
  private commandKey(userId: string, commandId: string): string {
    return this.redis.key('challenge', 'cmd', userId, commandId);
  }
  private contextKey(userId: string): string {
    return this.redis.key('lobby', 'user', userId);
  }
  private readyKey(gameModeId: string): string {
    return this.redis.key('lobby', gameModeId, 'ready');
  }
}

// KEYS: ctxA ctxB resA resB challenge ready expires
// ARGV: recordJson id expiresAtMs recordTtl ctxTtl
const RESERVE_SCRIPT = `
local aCtx = redis.call('get', KEYS[1])
local bCtx = redis.call('get', KEYS[2])
if not aCtx or not bCtx then return 'LOBBY_NOT_JOINED' end
local a = cjson.decode(aCtx)
local b = cjson.decode(bCtx)
if a.gameModeId ~= b.gameModeId then return 'LOBBY_DIFFERENT_MODE' end
if a.state ~= 'READY' then return 'LOBBY_NOT_READY' end
if b.state ~= 'READY' then return 'CHALLENGE_TARGET_NOT_READY' end
if redis.call('exists', KEYS[3]) == 1 or redis.call('exists', KEYS[4]) == 1 then return 'LOBBY_USER_BUSY' end
local record = cjson.decode(ARGV[1])
local ttl = tonumber(ARGV[4])
a.state = 'CHALLENGED'
b.state = 'CHALLENGED'
redis.call('set', KEYS[3], ARGV[2], 'EX', ttl)
redis.call('set', KEYS[4], ARGV[2], 'EX', ttl)
redis.call('set', KEYS[5], ARGV[1], 'EX', ttl)
redis.call('zrem', KEYS[6], record.challengerId, record.opponentId)
redis.call('set', KEYS[1], cjson.encode(a), 'EX', tonumber(ARGV[5]))
redis.call('set', KEYS[2], cjson.encode(b), 'EX', tonumber(ARGV[5]))
redis.call('zadd', KEYS[7], ARGV[3], ARGV[2])
return 'OK'`;

// KEYS: challenge resA resB
// ARGV: id nowMs recordTtl
const CLAIM_ACCEPT_SCRIPT = `
local raw = redis.call('get', KEYS[1])
if not raw then return 'CHALLENGE_NOT_FOUND' end
local record = cjson.decode(raw)
if record.status ~= 'PENDING' then return 'CHALLENGE_NOT_PENDING' end
if tonumber(record.expiresAtMs) <= tonumber(ARGV[2]) then return 'CHALLENGE_EXPIRED' end
if redis.call('get', KEYS[2]) ~= ARGV[1] or redis.call('get', KEYS[3]) ~= ARGV[1] then return 'CHALLENGE_NOT_PENDING' end
record.status = 'ACCEPTING'
record.acceptingAtMs = tonumber(ARGV[2])
redis.call('set', KEYS[1], cjson.encode(record), 'EX', tonumber(ARGV[3]))
return 'OK'`;

// KEYS: challenge resA resB ctxA ctxB ready expires
// ARGV: id status recordTtl readyScore readyIso allowAccepting excludeUserId ctxTtl
// Returns {'OK', restoredUserId...} or an error code string.
const TERMINAL_SCRIPT = `
local raw = redis.call('get', KEYS[1])
if not raw then return 'CHALLENGE_NOT_FOUND' end
local record = cjson.decode(raw)
if record.status == 'ACCEPTING' and ARGV[6] ~= '1' then return 'CHALLENGE_ACCEPTING' end
if record.status ~= 'PENDING' and record.status ~= 'ACCEPTING' then return 'ALREADY_TERMINAL' end
record.status = ARGV[2]
redis.call('set', KEYS[1], cjson.encode(record), 'EX', tonumber(ARGV[3]))
for i = 2, 3 do
  if redis.call('get', KEYS[i]) == ARGV[1] then redis.call('del', KEYS[i]) end
end
redis.call('zrem', KEYS[7], ARGV[1])
local restored = {'OK'}
local function restore(ctxKey, userId)
  if userId == ARGV[7] then return end
  local ctxRaw = redis.call('get', ctxKey)
  if not ctxRaw then return end
  local ctx = cjson.decode(ctxRaw)
  if ctx.state ~= 'CHALLENGED' or ctx.gameModeId ~= record.gameModeId then return end
  ctx.state = 'READY'
  ctx.readyAt = ARGV[5]
  redis.call('set', ctxKey, cjson.encode(ctx), 'EX', tonumber(ARGV[8]))
  redis.call('zadd', KEYS[6], ARGV[4], userId)
  table.insert(restored, userId)
end
restore(KEYS[4], record.challengerId)
restore(KEYS[5], record.opponentId)
return restored`;

// KEYS: challenge resA resB ctxA ctxB ready expires
// ARGV: id matchId recordTtl
// A durable match exists, so this applies from any status.
const ACCEPTED_SCRIPT = `
local raw = redis.call('get', KEYS[1])
if not raw then return 'CHALLENGE_NOT_FOUND' end
local record = cjson.decode(raw)
if record.status == 'ACCEPTED' then return 'ALREADY_ACCEPTED' end
record.status = 'ACCEPTED'
record.matchId = ARGV[2]
redis.call('set', KEYS[1], cjson.encode(record), 'EX', tonumber(ARGV[3]))
for i = 2, 3 do
  if redis.call('get', KEYS[i]) == ARGV[1] then redis.call('del', KEYS[i]) end
end
redis.call('del', KEYS[4], KEYS[5])
redis.call('zrem', KEYS[6], record.challengerId, record.opponentId)
redis.call('zrem', KEYS[7], ARGV[1])
return 'OK'`;
