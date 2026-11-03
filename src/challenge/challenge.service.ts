import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { COMMITTED_MATCH_STATUSES, isRecoverableMatchStatus } from '../common/match-status';
import { UserStatus } from '../generated/prisma/enums';
import { LobbyService } from '../lobby/lobby.service';
import { LobbyPlayerView } from '../lobby/lobby.types';
import { MatchCreationService } from '../match-creation/match-creation.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ChallengeRecord, ChallengeStatus, ChallengeView } from './challenge.types';

export type AcceptFailureRecovery = {
  gameModeId: string;
  challenge: ChallengeView;
  available: LobbyPlayerView[];
  leftUserIds: string[];
};

@Injectable()
export class ChallengeService {
  private readonly logger = new Logger(ChallengeService.name);
  private readonly ttlSeconds = 15;
  private readonly commandTtlSeconds = 300;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly lobby: LobbyService,
    private readonly matchCreation: MatchCreationService,
  ) {}

  async create(challengerId: string, opponentId: string, commandId: string): Promise<{ challenge: ChallengeView; duplicate: boolean }> {
    const duplicate = await this.commandResult(commandId, challengerId);
    if (duplicate) return { challenge: await this.view(duplicate.challengeId), duplicate: true };
    if (challengerId === opponentId) throw new ConflictException({ code: 'CHALLENGE_SELF_NOT_ALLOWED', message: 'You cannot challenge yourself.' });
    await this.assertActive(challengerId);
    await this.assertActive(opponentId);
    const challenger = await this.lobby.requireContext(challengerId);
    const opponent = await this.lobby.requireContext(opponentId);
    if (challenger.gameModeId !== opponent.gameModeId) throw new ConflictException({ code: 'LOBBY_DIFFERENT_MODE', message: 'Player is in a different lobby.' });
    await this.assertModeEnabled(challenger.gameModeId);
    await this.assertNoCommittedMatch([challengerId, opponentId]);

    const id = randomUUID();
    const createdAtMs = Date.now();
    const expiresAtMs = createdAtMs + this.ttlSeconds * 1000;
    const record: ChallengeRecord = {
      id,
      gameModeId: challenger.gameModeId,
      challengerId,
      opponentId,
      status: 'PENDING',
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
    };

    const result = await this.redis.raw().eval(this.reserveScript(), {
      keys: [
        this.userKey(challengerId),
        this.userKey(opponentId),
        this.challengeUserKey(challengerId),
        this.challengeUserKey(opponentId),
        this.challengeKey(id),
        this.readyKey(challenger.gameModeId),
        this.expiresKey(),
      ],
      arguments: [JSON.stringify(record), id, String(expiresAtMs)],
    }) as string;
    if (result !== 'OK') throw new ConflictException({ code: result, message: 'Challenge could not be created.' });
    await this.storeCommand(commandId, challengerId, { challengeId: id });
    return { challenge: await this.view(id), duplicate: false };
  }

  async accept(userId: string, challengeId: string, commandId: string): Promise<{ challenge: ChallengeView; duplicate: boolean }> {
    const duplicate = await this.commandResult(commandId, userId);
    if (duplicate) return { challenge: await this.viewWithDurableMatch(duplicate.challengeId), duplicate: true };
    const existingMatch = await this.matchCreation.findByChallengeId(challengeId);
    if (existingMatch) {
      const cleaned = await this.acceptedCleanup(challengeId, existingMatch).catch(() => null);
      await this.storeCommand(commandId, userId, { challengeId });
      this.logger.log(`challenge_accept_existing_match_recovered challenge=${challengeId} command=${commandId} match=${existingMatch.id}`);
      return { challenge: cleaned?.challenge ?? { ...(await this.view(challengeId)), status: 'ACCEPTED', match: existingMatch }, duplicate: false };
    }

    const challenge = await this.requirePending(challengeId);
    if (challenge.opponentId !== userId) throw new ForbiddenException({ code: 'CHALLENGE_NOT_OPPONENT', message: 'Only opponent can accept.' });
    if (Date.parse(challenge.expiresAt) <= Date.now()) return this.expire(challengeId, commandId, userId);
    await this.assertReservations(challenge);

    const claimed = await this.claimAccept(challenge);
    if (!claimed) throw new ConflictException({ code: 'CHALLENGE_NOT_PENDING', message: 'Challenge is no longer pending.' });

    this.logger.log(`challenge_accept_started challenge=${challenge.id} command=${commandId} challenger=${challenge.challengerId} opponent=${challenge.opponentId} mode=${challenge.gameModeId}`);
    try {
      const match = await this.matchCreation.createSecuredMatch({
        gameModeId: challenge.gameModeId,
        playerIds: [challenge.challengerId, challenge.opponentId],
        challengeId: challenge.id,
        source: 'CHALLENGE',
      });
      const accepted = await this.acceptedCleanup(challenge.id, match);
      this.logger.log(`challenge_match_created challenge=${challenge.id} command=${commandId} match=${match.id} session=${match.sessionCode}`);
      await this.storeCommand(commandId, userId, { challengeId });
      return { challenge: accepted.challenge, duplicate: false };
    } catch (error) {
      this.logger.warn(`challenge_accept_failed challenge=${challenge.id} command=${commandId} reason=${error instanceof Error ? error.message : 'unknown'}`);
      const recovery = await this.acceptFailed(challenge).catch(() => null);
      if (recovery) {
        Object.assign(error instanceof Error ? error : Object.create(null), { lobbyRecovery: recovery });
      }
      if (error instanceof BadRequestException) throw error;
      throw error;
    }
  }

  async reject(userId: string, challengeId: string, commandId: string): Promise<{ challenge: ChallengeView; duplicate: boolean }> {
    const duplicate = await this.commandResult(commandId, userId);
    if (duplicate) return { challenge: await this.view(duplicate.challengeId), duplicate: true };
    const challenge = await this.requirePending(challengeId);
    if (challenge.opponentId !== userId) throw new ForbiddenException({ code: 'CHALLENGE_NOT_OPPONENT', message: 'Only opponent can reject.' });
    const rejected = await this.terminal(challenge, 'REJECTED');
    await this.storeCommand(commandId, userId, { challengeId });
    return { challenge: rejected.challenge, duplicate: false };
  }

  async cancel(userId: string, challengeId: string, commandId: string = randomUUID()): Promise<{ challenge: ChallengeView; duplicate: boolean }> {
    const duplicate = await this.commandResult(commandId, userId);
    if (duplicate) return { challenge: await this.view(duplicate.challengeId), duplicate: true };
    const challenge = await this.requirePending(challengeId);
    if (challenge.challengerId !== userId) throw new ForbiddenException({ code: 'CHALLENGE_NOT_CHALLENGER', message: 'Only challenger can cancel.' });
    const cancelled = await this.terminal(challenge, 'CANCELLED');
    await this.storeCommand(commandId, userId, { challengeId });
    return { challenge: cancelled.challenge, duplicate: false };
  }

  async expireDue(nowMs = Date.now()): Promise<ChallengeView[]> {
    const ids = await this.redis.raw().zRangeByScore(this.expiresKey(), 0, nowMs, { LIMIT: { offset: 0, count: 25 } });
    const expired: ChallengeView[] = [];
    for (const id of ids) {
      try {
        const result = await this.expire(id);
        expired.push(result.challenge);
      } catch {
        await this.redis.raw().zRem(this.expiresKey(), id);
      }
    }
    return expired;
  }

  async cancelForUser(userId: string): Promise<ChallengeView | null> {
    const challengeId = await this.redis.raw().get(this.challengeUserKey(userId));
    if (!challengeId) return null;
    const challenge = await this.redis.getJson<ChallengeRecord>(this.challengeKey(challengeId));
    if (!challenge || challenge.status !== 'PENDING') return null;
    return (await this.terminal(challenge, 'CANCELLED')).challenge;
  }

  async activeForUser(userId: string): Promise<ChallengeView | null> {
    const challengeId = await this.redis.raw().get(this.challengeUserKey(userId));
    if (!challengeId) return null;
    const challenge = await this.redis.getJson<ChallengeRecord>(this.challengeKey(challengeId));
    return challenge ? this.toView(challenge) : null;
  }

  private async expire(challengeId: string, commandId?: string, userId?: string): Promise<{ challenge: ChallengeView; duplicate: boolean }> {
    const challenge = await this.requirePending(challengeId);
    const expired = await this.terminal(challenge, 'EXPIRED');
    if (commandId && userId) await this.storeCommand(commandId, userId, { challengeId });
    return { challenge: expired.challenge, duplicate: false };
  }

  private async terminal(challenge: ChallengeRecord, status: Exclude<ChallengeStatus, 'PENDING'>): Promise<{ challenge: ChallengeView }> {
    const updated: ChallengeRecord = { ...challenge, status };
    const readyScore = Date.now();
    const result = await this.redis.raw().eval(this.terminalScript(), {
      keys: [
        this.challengeKey(challenge.id),
        this.challengeUserKey(challenge.challengerId),
        this.challengeUserKey(challenge.opponentId),
        this.userKey(challenge.challengerId),
        this.userKey(challenge.opponentId),
        this.readyKey(challenge.gameModeId),
        this.expiresKey(),
      ],
      arguments: [challenge.id, status, JSON.stringify(updated), String(readyScore), new Date(readyScore).toISOString()],
    }) as string;
    if (result !== 'OK' && result !== 'ALREADY_TERMINAL') throw new ConflictException({ code: result, message: 'Challenge state changed.' });
    return { challenge: await this.view(challenge.id) };
  }

  private async requirePending(challengeId: string): Promise<ChallengeRecord> {
    const challenge = await this.redis.getJson<ChallengeRecord>(this.challengeKey(challengeId));
    if (!challenge) throw new NotFoundException({ code: 'CHALLENGE_NOT_FOUND', message: 'Challenge not found.' });
    if (challenge.status !== 'PENDING') throw new ConflictException({ code: 'CHALLENGE_NOT_PENDING', message: 'Challenge is no longer pending.' });
    return challenge;
  }

  private async claimAccept(challenge: ChallengeRecord): Promise<boolean> {
    const accepting: ChallengeRecord = { ...challenge, status: 'ACCEPTING' };
    const result = await this.redis.raw().eval(this.claimAcceptScript(), {
      keys: [
        this.challengeKey(challenge.id),
        this.challengeUserKey(challenge.challengerId),
        this.challengeUserKey(challenge.opponentId),
      ],
      arguments: [challenge.id, JSON.stringify(accepting), String(Date.now()), String(Date.parse(challenge.expiresAt))],
    }) as string;
    return result === 'OK';
  }

  private async acceptedCleanup(challengeId: string, match: unknown): Promise<{ challenge: ChallengeView }> {
    const challenge = await this.redis.getJson<ChallengeRecord>(this.challengeKey(challengeId));
    if (!challenge) {
      return { challenge: { id: challengeId, gameModeId: '', challengerId: '', opponentId: '', status: 'ACCEPTED', createdAt: new Date().toISOString(), expiresAt: new Date().toISOString(), match } };
    }
    const accepted: ChallengeRecord = { ...challenge, status: 'ACCEPTED', match };
    const result = await this.redis.raw().eval(this.acceptedCleanupScript(), {
      keys: [
        this.challengeKey(challenge.id),
        this.challengeUserKey(challenge.challengerId),
        this.challengeUserKey(challenge.opponentId),
        this.userKey(challenge.challengerId),
        this.userKey(challenge.opponentId),
        this.readyKey(challenge.gameModeId),
        this.expiresKey(),
      ],
      arguments: [challenge.id, JSON.stringify(accepted)],
    }) as string;
    if (result !== 'OK' && result !== 'ALREADY_ACCEPTED') throw new ConflictException({ code: result, message: 'Challenge cleanup failed.' });
    this.logger.log(`challenge_cleanup_completed challenge=${challenge.id} match=${(match as any)?.id ?? '-'}`);
    return { challenge: await this.viewWithDurableMatch(challenge.id) };
  }

  private async acceptFailed(challenge: ChallengeRecord): Promise<AcceptFailureRecovery> {
    await this.terminal({ ...challenge, status: 'PENDING' }, 'CANCELLED');
    const available: LobbyPlayerView[] = [];
    const leftUserIds: string[] = [];
    const playerIds = [challenge.challengerId, challenge.opponentId];
    const committedRows = await this.prisma.matchParticipant.findMany({
      where: { userId: { in: playerIds }, match: { status: { in: COMMITTED_MATCH_STATUSES } } },
      select: { userId: true, matchId: true, match: { select: { status: true } } },
    });
    const committedByUser = new Map(committedRows.map((row) => [row.userId, row]));

    for (const userId of playerIds) {
      if (committedByUser.has(userId)) {
        await this.lobby.leave(userId).catch(() => undefined);
        leftUserIds.push(userId);
        continue;
      }
      const restored = await this.lobby.restoreReady([userId], challenge.gameModeId);
      available.push(...restored);
    }

    const view = await this.view(challenge.id).catch(() => ({
      ...challenge,
      status: 'CANCELLED' as const,
    }));
    return {
      gameModeId: challenge.gameModeId,
      challenge: view,
      available,
      leftUserIds,
    };
  }

  private async assertReservations(challenge: ChallengeRecord): Promise<void> {
    const [a, b] = await Promise.all([
      this.redis.raw().get(this.challengeUserKey(challenge.challengerId)),
      this.redis.raw().get(this.challengeUserKey(challenge.opponentId)),
    ]);
    if (a !== challenge.id || b !== challenge.id) {
      throw new ConflictException({ code: 'CHALLENGE_NOT_PENDING', message: 'Challenge reservation is missing.' });
    }
  }

  private async view(challengeId: string): Promise<ChallengeView> {
    const challenge = await this.redis.getJson<ChallengeRecord>(this.challengeKey(challengeId));
    if (!challenge) throw new NotFoundException({ code: 'CHALLENGE_NOT_FOUND', message: 'Challenge not found.' });
    return this.toView(challenge);
  }

  private async viewWithDurableMatch(challengeId: string): Promise<ChallengeView> {
    const view = await this.view(challengeId);
    if (view.status === 'ACCEPTED' && !view.match) {
      const match = await this.matchCreation.findByChallengeId(challengeId);
      if (match) return { ...view, match };
    }
    return view;
  }

  private async toView(challenge: ChallengeRecord): Promise<ChallengeView> {
    const [challenger, opponent] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: challenge.challengerId }, select: { fullName: true } }),
      this.prisma.user.findUnique({ where: { id: challenge.opponentId }, select: { fullName: true } }),
    ]);
    return { ...challenge, challengerName: challenger?.fullName, opponentName: opponent?.fullName };
  }

  private async assertActive(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
    if (!user || user.status !== UserStatus.ACTIVE) throw new ConflictException({ code: 'CHALLENGE_NOT_ALLOWED', message: 'Player is not active.' });
  }

  private async assertNoCommittedMatch(playerIds: string[]): Promise<void> {
    const active = await this.prisma.matchParticipant.findFirst({
      where: { userId: { in: playerIds }, match: { status: { in: COMMITTED_MATCH_STATUSES } } },
      select: { userId: true, matchId: true, match: { select: { status: true } } },
    });
    if (active) {
      this.logger.warn(
        `operation=CHALLENGE_CREATE reason=LOBBY_ACTIVE_MATCH blockedUserId=${active.userId} blockingMatchId=${active.matchId} blockingStatus=${active.match.status}`,
      );
      throw new ConflictException({
        code: 'LOBBY_ACTIVE_MATCH',
        message: isRecoverableMatchStatus(active.match.status)
          ? 'Player is already in a match.'
          : 'Player already has an open match entry.',
      });
    }
  }

  private async assertModeEnabled(gameModeId: string): Promise<void> {
    const mode = await this.prisma.gameMode.findUnique({ where: { id: gameModeId }, include: { game: true } });
    if (!mode || !mode.enabled || !mode.game.enabled) throw new ConflictException({ code: 'LOBBY_MODE_DISABLED', message: 'Mode is disabled.' });
  }

  private async commandResult(commandId: string, userId: string): Promise<{ challengeId: string } | null> {
    return this.redis.getJson<{ challengeId: string }>(this.commandKey(userId, commandId));
  }

  private async storeCommand(commandId: string, userId: string, value: { challengeId: string }): Promise<void> {
    await this.redis.setJson(this.commandKey(userId, commandId), value, this.commandTtlSeconds);
  }

  private reserveScript(): string {
    return `
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
a.state = 'CHALLENGED'
b.state = 'CHALLENGED'
redis.call('set', KEYS[3], ARGV[2], 'EX', 15)
redis.call('set', KEYS[4], ARGV[2], 'EX', 15)
redis.call('set', KEYS[5], ARGV[1], 'EX', 20)
redis.call('zrem', KEYS[6], record.challengerId)
redis.call('zrem', KEYS[6], record.opponentId)
redis.call('set', KEYS[1], cjson.encode(a), 'EX', 180)
redis.call('set', KEYS[2], cjson.encode(b), 'EX', 180)
redis.call('zadd', KEYS[7], ARGV[3], ARGV[2])
return 'OK'`;
  }

  private terminalScript(): string {
    return `
local raw = redis.call('get', KEYS[1])
if not raw then return 'CHALLENGE_NOT_FOUND' end
local record = cjson.decode(raw)
if record.status ~= 'PENDING' and not (record.status == 'ACCEPTING' and ARGV[2] == 'CANCELLED') then return 'ALREADY_TERMINAL' end
record.status = ARGV[2]
redis.call('set', KEYS[1], ARGV[3], 'EX', 300)
redis.call('del', KEYS[2])
redis.call('del', KEYS[3])
redis.call('zrem', KEYS[7], ARGV[1])
local aCtx = redis.call('get', KEYS[4])
local bCtx = redis.call('get', KEYS[5])
if ARGV[2] == 'REJECTED' or ARGV[2] == 'CANCELLED' or ARGV[2] == 'EXPIRED' then
  if aCtx then local a = cjson.decode(aCtx); a.state = 'READY'; a.readyAt = ARGV[5]; redis.call('set', KEYS[4], cjson.encode(a), 'EX', 180); redis.call('zadd', KEYS[6], ARGV[4], record.challengerId) end
  if bCtx then local b = cjson.decode(bCtx); b.state = 'READY'; b.readyAt = ARGV[5]; redis.call('set', KEYS[5], cjson.encode(b), 'EX', 180); redis.call('zadd', KEYS[6], ARGV[4], record.opponentId) end
end
return 'OK'`;
  }

  private claimAcceptScript(): string {
    return `
local raw = redis.call('get', KEYS[1])
if not raw then return 'CHALLENGE_NOT_FOUND' end
local record = cjson.decode(raw)
if record.status ~= 'PENDING' then return 'CHALLENGE_NOT_PENDING' end
if tonumber(ARGV[4]) <= tonumber(ARGV[3]) then return 'CHALLENGE_EXPIRED' end
if redis.call('get', KEYS[2]) ~= ARGV[1] or redis.call('get', KEYS[3]) ~= ARGV[1] then return 'CHALLENGE_NOT_PENDING' end
redis.call('set', KEYS[1], ARGV[2], 'EX', 60)
return 'OK'`;
  }

  private acceptedCleanupScript(): string {
    return `
local raw = redis.call('get', KEYS[1])
if not raw then return 'CHALLENGE_NOT_FOUND' end
local record = cjson.decode(raw)
if record.status == 'ACCEPTED' then return 'ALREADY_ACCEPTED' end
if record.status ~= 'ACCEPTING' and record.status ~= 'PENDING' then return 'ALREADY_TERMINAL' end
redis.call('set', KEYS[1], ARGV[2], 'EX', 300)
redis.call('del', KEYS[2])
redis.call('del', KEYS[3])
redis.call('del', KEYS[4])
redis.call('del', KEYS[5])
redis.call('zrem', KEYS[6], record.challengerId)
redis.call('zrem', KEYS[6], record.opponentId)
redis.call('zrem', KEYS[7], ARGV[1])
return 'OK'`;
  }

  private challengeKey(id: string): string { return this.redis.key('challenge', id); }
  private challengeUserKey(userId: string): string { return this.redis.key('challenge', 'user', userId); }
  private expiresKey(): string { return this.redis.key('challenge', 'expires'); }
  private commandKey(userId: string, commandId: string): string { return this.redis.key('challenge', 'cmd', userId, commandId); }
  private userKey(userId: string): string { return this.redis.key('lobby', 'user', userId); }
  private readyKey(gameModeId: string): string { return this.redis.key('lobby', gameModeId, 'ready'); }
}
