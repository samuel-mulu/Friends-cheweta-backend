import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { COMMITTED_MATCH_STATUSES } from '../common/match-status';
import { AppEnv } from '../config/env';
import { MatchEntryStatus, MatchStatus, UserStatus } from '../generated/prisma/enums';
import { GameEntryService } from '../game-entry/game-entry.service';
import { GamingService } from '../gaming/gaming.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { JoinMatchmakingDto } from './dto/join-matchmaking.dto';
import {
  MatchmakingJoinResult,
  MatchmakingMatchedResult,
  ReadyEntry,
  ReadyPlayerView,
} from './matchmaking.types';

@Injectable()
export class MatchmakingService {
  private readonly logger = new Logger(MatchmakingService.name);
  private readonly readyLobbyLimit = 100;
  private readonly queueTtlSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly gaming: GamingService,
    private readonly gameEntry: GameEntryService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.queueTtlSeconds = config.get('REDIS_MATCHMAKING_TTL_SECONDS', { infer: true });
  }

  async join(userId: string, dto: JoinMatchmakingDto): Promise<MatchmakingJoinResult> {
    const assignment = await this.redis.getJson<MatchmakingMatchedResult>(this.assignmentKey(userId));
    if (assignment) return assignment;

    if (dto.ticketId) {
      return this.challenge(userId, dto.ticketId);
    }
    return this.goReady(userId, dto.gameModeId);
  }

  async list(gameModeId: string, viewerUserId?: string): Promise<{ players: ReadyPlayerView[] }> {
    await this.assertModeAvailable(gameModeId);
    const players = await this.loadReadyPlayers(gameModeId, viewerUserId);
    return { players };
  }

  async cancel(userId: string): Promise<{ success: true }> {
    const ticketId = await this.redis.raw().get(this.userQueueKey(userId));
    if (!ticketId) return { success: true };

    const entry = await this.redis.getJson<ReadyEntry>(this.entryKey(ticketId));
    if (!entry) {
      await this.redis.raw().del(this.userQueueKey(userId));
      return { success: true };
    }

    return this.redis.withLock(this.queueLockKey(entry.gameModeId), async () => {
      await this.removeReadyEntry(entry, userId);
      await this.gameEntry.cancelAndRefund(entry.matchId, 'READY_CANCELLED_BY_PLAYER').catch(() => undefined);
      this.logger.log(`lobby:cancel user=${userId} mode=${entry.gameModeId} ticket=${entry.ticketId} match=${entry.matchId}`);
      return { success: true };
    }, 10000, 2500);
  }

  async status(userId: string): Promise<any> {
    const assignment = await this.redis.getJson<MatchmakingMatchedResult>(this.assignmentKey(userId));
    if (assignment) return assignment;

    const ticketId = await this.redis.raw().get(this.userQueueKey(userId));
    if (!ticketId) return { status: 'IDLE' };

    const entry = await this.redis.getJson<ReadyEntry>(this.entryKey(ticketId));
    if (!entry) {
      await this.redis.raw().del(this.userQueueKey(userId));
      return { status: 'IDLE' };
    }

    const players = await this.loadReadyPlayers(entry.gameModeId, userId);
    return {
      status: 'QUEUED',
      ticketId: entry.ticketId,
      gameModeId: entry.gameModeId,
      matchId: entry.matchId,
      players,
    };
  }

  async buildLobbyPayload(gameModeId: string, viewerUserId?: string) {
    const players = await this.loadReadyPlayers(gameModeId, viewerUserId);
    return { gameModeId, players };
  }

  private async goReady(userId: string, gameModeId: string): Promise<MatchmakingJoinResult> {
    const mode = await this.assertEligible(userId, gameModeId);

    return this.redis.withLock(this.queueLockKey(mode.id), async () => {
      const existingTicketId = await this.redis.raw().get(this.userQueueKey(userId));
      if (existingTicketId) {
        const existingEntry = await this.redis.getJson<ReadyEntry>(this.entryKey(existingTicketId));
        if (existingEntry) {
          if (existingEntry.gameModeId !== mode.id) {
            throw new ConflictException({
              code: 'ALREADY_IN_MATCHMAKING',
              message: 'You are already ready in another room.',
            });
          }
          const players = await this.loadReadyPlayers(mode.id, userId);
          return {
            status: 'QUEUED',
            ticketId: existingEntry.ticketId,
            gameModeId: mode.id,
            matchId: existingEntry.matchId,
            players,
          };
        }
        await this.redis.raw().del(this.userQueueKey(userId));
      }

      const user = await this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { fullName: true },
      });

      const match = await this.gaming.createOpenMatch(mode.id, userId);
      try {
        await this.gameEntry.secureParticipantEntry(match.id, userId);
      } catch (error) {
        await this.gameEntry.cancelAndRefund(match.id, 'READY_ENTRY_RESERVATION_FAILED').catch(() => undefined);
        throw error;
      }

      const entry: ReadyEntry = {
        ticketId: randomUUID(),
        userId,
        gameModeId: mode.id,
        matchId: match.id,
        displayName: user.fullName,
        readyAtMs: Date.now(),
      };

      const tx = this.redis.raw().multi();
      tx.set(this.entryKey(entry.ticketId), JSON.stringify(entry), { EX: this.queueTtlSeconds });
      tx.set(this.userQueueKey(userId), entry.ticketId, { EX: this.queueTtlSeconds });
      tx.zAdd(this.queueKey(mode.id), [{ score: entry.readyAtMs, value: entry.ticketId }]);
      tx.expire(this.queueKey(mode.id), this.queueTtlSeconds * 2);
      await tx.exec();
      this.logger.log(`lobby:ready user=${userId} mode=${mode.id} ticket=${entry.ticketId} match=${entry.matchId}`);

      const players = await this.loadReadyPlayers(mode.id, userId);
      return {
        status: 'QUEUED',
        ticketId: entry.ticketId,
        gameModeId: mode.id,
        matchId: entry.matchId,
        players,
      };
    }, 10000, 2500);
  }

  private async challenge(userId: string, ticketId: string): Promise<MatchmakingJoinResult> {
    const readyEntry = await this.redis.getJson<ReadyEntry>(this.entryKey(ticketId));
    if (!readyEntry) {
      throw new NotFoundException({ code: 'READY_PLAYER_NOT_FOUND', message: 'That player is no longer ready.' });
    }
    if (readyEntry.userId === userId) {
      throw new ConflictException({ code: 'CANNOT_CHALLENGE_SELF', message: 'You cannot join your own ready slot.' });
    }

    this.logger.log(`lobby:challenge challenger=${userId} host=${readyEntry.userId} mode=${readyEntry.gameModeId} ticket=${ticketId}`);
    await this.assertEligible(userId, readyEntry.gameModeId);

    const existingTicketId = await this.redis.raw().get(this.userQueueKey(userId));
    if (existingTicketId) {
      throw new ConflictException({
        code: 'ALREADY_IN_MATCHMAKING',
        message: 'Leave your current ready slot before joining another player.',
      });
    }

    return this.redis.withLock(this.queueLockKey(readyEntry.gameModeId), async () => {
      const currentEntry = await this.redis.getJson<ReadyEntry>(this.entryKey(ticketId));
      if (!currentEntry || currentEntry.matchId !== readyEntry.matchId) {
        throw new NotFoundException({ code: 'READY_PLAYER_NOT_FOUND', message: 'That player is no longer ready.' });
      }

      const openMatch = await this.prisma.match.findUnique({
        where: { id: currentEntry.matchId },
        include: { participants: true },
      });
      if (!openMatch || !this.isOpenReadySlot(openMatch)) {
        await this.removeReadyEntry(currentEntry, currentEntry.userId).catch(() => undefined);
        throw new NotFoundException({ code: 'READY_PLAYER_NOT_FOUND', message: 'That player is no longer ready.' });
      }

      return this.finalizePair(currentEntry, userId);
    }, 10000, 2500);
  }

  private async finalizePair(
    hostEntry: ReadyEntry,
    guestUserId: string,
    guestMatchId?: string,
  ): Promise<MatchmakingMatchedResult> {
    const match = await this.gaming.joinOpenMatch(hostEntry.matchId, guestUserId);
    try {
      await this.gameEntry.secureParticipantEntry(match.id, guestUserId);
    } catch (error) {
      await this.prisma.matchParticipant.deleteMany({
        where: { matchId: match.id, userId: guestUserId },
      });
      throw error;
    }

    if (guestMatchId && guestMatchId !== hostEntry.matchId) {
      await this.gameEntry.cancelAndRefund(guestMatchId, 'READY_AUTO_PAIR_MERGED').catch(() => undefined);
    }

    const securedMatch = await this.gaming.getMatchForUser(match.id, guestUserId);
    const matchedResult: MatchmakingMatchedResult = {
      status: 'MATCHED',
      gameModeId: hostEntry.gameModeId,
      match: securedMatch,
      userIds: [hostEntry.userId, guestUserId],
    };

    const cleanup = this.redis.raw().multi();
    cleanup.zRem(this.queueKey(hostEntry.gameModeId), hostEntry.ticketId);
    cleanup.del(this.entryKey(hostEntry.ticketId));
    cleanup.del(this.userQueueKey(hostEntry.userId));

    const guestTicketId = await this.redis.raw().get(this.userQueueKey(guestUserId));
    if (guestTicketId) {
      cleanup.zRem(this.queueKey(hostEntry.gameModeId), guestTicketId);
      cleanup.del(this.entryKey(guestTicketId));
      cleanup.del(this.userQueueKey(guestUserId));
    }

    for (const matchedUserId of matchedResult.userIds) {
      cleanup.set(this.assignmentKey(matchedUserId), JSON.stringify(matchedResult), { EX: this.queueTtlSeconds });
    }
    await cleanup.exec();
    this.logger.log(`lobby:matched host=${hostEntry.userId} guest=${guestUserId} mode=${hostEntry.gameModeId} match=${match.id}`);

    return matchedResult;
  }

  private isValidReadyEntry(
    entry: ReadyEntry,
    match: { status: MatchStatus; participants: Array<{ userId: string }>; entries: Array<{ userId: string; status: MatchEntryStatus }> } | undefined,
    user: { status: UserStatus } | undefined,
  ): boolean {
    if (!user || user.status !== UserStatus.ACTIVE) return false;
    if (!match || !this.isOpenReadySlot(match)) return false;
    return match.entries.some((item) => item.userId === entry.userId && item.status === MatchEntryStatus.LOCKED);
  }

  private isOpenReadySlot(match: {
    status: MatchStatus;
    participants: Array<{ userId: string }>;
  }): boolean {
    return (
      match.participants.length === 1 &&
      (match.status === MatchStatus.WAITING || match.status === MatchStatus.CREATED)
    );
  }

  // DB4: this used to do, per ticket: 1 Redis read + 1 Prisma match read +
  // (inside isValidReadyEntry) a *second*, duplicate Prisma match read + 1
  // Prisma user read - up to ~4 sequential round trips per ready ticket,
  // i.e. hundreds of round trips for a full (up to 100-entry) ready lobby.
  // Now: fetch all ticket metadata in parallel, collect the distinct
  // matchIds/userIds referenced, batch-fetch each with a single `findMany`,
  // then validate every ticket in memory against the two lookup maps - a
  // fixed 2 Prisma queries total regardless of how many tickets are ready.
  private async loadReadyPlayers(gameModeId: string, viewerUserId?: string): Promise<ReadyPlayerView[]> {
    const mode = await this.assertModeAvailable(gameModeId);
    const queueKey = this.queueKey(gameModeId);
    const ticketIds = await this.redis.raw().zRange(queueKey, 0, this.readyLobbyLimit - 1);
    if (ticketIds.length === 0) return [];

    const entries = await Promise.all(
      ticketIds.map((ticketId) => this.redis.getJson<ReadyEntry>(this.entryKey(ticketId))),
    );

    const staleTicketIds: string[] = [];
    const candidates: ReadyEntry[] = [];
    for (let index = 0; index < ticketIds.length; index += 1) {
      const entry = entries[index];
      if (!entry || entry.gameModeId !== gameModeId) {
        staleTicketIds.push(ticketIds[index]);
        continue;
      }
      candidates.push(entry);
    }
    if (staleTicketIds.length > 0) {
      await Promise.all(staleTicketIds.map((ticketId) => this.redis.raw().zRem(queueKey, ticketId)));
    }
    if (candidates.length === 0) return [];

    const matchIds = [...new Set(candidates.map((entry) => entry.matchId))];
    const userIds = [...new Set(candidates.map((entry) => entry.userId))];

    const [matches, users] = await Promise.all([
      this.prisma.match.findMany({
        where: { id: { in: matchIds } },
        include: { participants: true, entries: true },
      }),
      this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, status: true },
      }),
    ]);
    const matchById = new Map(matches.map((match) => [match.id, match]));
    const userById = new Map(users.map((user) => [user.id, user]));

    const players: ReadyPlayerView[] = [];
    const invalidEntries: ReadyEntry[] = [];
    const staleCancelledMatchIds = new Set<string>();

    for (const entry of candidates) {
      const match = matchById.get(entry.matchId);
      const user = userById.get(entry.userId);
      if (!this.isValidReadyEntry(entry, match, user)) {
        invalidEntries.push(entry);
        if (match && match.status === MatchStatus.CANCELLED) staleCancelledMatchIds.add(match.id);
        continue;
      }

      players.push({
        ticketId: entry.ticketId,
        userId: entry.userId,
        displayName: entry.displayName,
        readyAtMs: entry.readyAtMs,
        stakeAmountMinor: mode.stakeAmountMinor.toString(),
        ...(viewerUserId && entry.userId === viewerUserId ? { isSelf: true } : {}),
      });
    }

    if (invalidEntries.length > 0) {
      await Promise.all(invalidEntries.map((entry) => this.removeReadyEntry(entry, entry.userId).catch(() => undefined)));
    }
    if (staleCancelledMatchIds.size > 0) {
      await Promise.all(
        [...staleCancelledMatchIds].map((matchId) => this.gameEntry.cancelAndRefund(matchId, 'READY_SLOT_STALE').catch(() => undefined)),
      );
    }

    return players;
  }

  private async removeReadyEntry(entry: ReadyEntry, userId: string): Promise<void> {
    const tx = this.redis.raw().multi();
    tx.zRem(this.queueKey(entry.gameModeId), entry.ticketId);
    tx.del(this.entryKey(entry.ticketId));
    tx.del(this.userQueueKey(userId));
    await tx.exec();
  }

  private async assertModeAvailable(gameModeId: string) {
    const mode = await this.prisma.gameMode.findUnique({
      where: { id: gameModeId },
      include: { game: true },
    });
    if (!mode || !mode.enabled || !mode.game.enabled) {
      throw new NotFoundException({ code: 'GAME_MODE_NOT_AVAILABLE', message: 'Game mode is not available.' });
    }
    if (mode.game.code !== 'LUDO' || mode.playerCount !== 2) {
      throw new BadRequestException({
        code: 'MATCHMAKING_MODE_NOT_SUPPORTED',
        message: 'Ready lobby supports Ludo 1v1 only.',
      });
    }
    return mode;
  }

  private async assertEligible(userId: string, gameModeId: string) {
    const mode = await this.assertModeAvailable(gameModeId);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        status: true,
        wallet: { select: { availableBalance: true } },
      },
    });
    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new BadRequestException({ code: 'PLAYER_NOT_ELIGIBLE', message: 'Player is not eligible for matchmaking.' });
    }
    if (!user.wallet || user.wallet.availableBalance < mode.stakeAmountMinor) {
      throw new BadRequestException({
        code: 'INSUFFICIENT_BALANCE_FOR_MATCH',
        message: 'Available wallet balance is below the game stake.',
      });
    }
    const committed = await this.prisma.matchParticipant.findFirst({
      where: { userId, match: { status: { in: COMMITTED_MATCH_STATUSES } } },
      select: { matchId: true, match: { select: { status: true } } },
    });
    if (committed) {
      this.logger.warn(
        `operation=QUICK_MATCH reason=LOBBY_ACTIVE_MATCH blockedUserId=${userId} blockingMatchId=${committed.matchId} blockingStatus=${committed.match.status}`,
      );
      throw new ConflictException({
        code: 'LOBBY_ACTIVE_MATCH',
        message: 'You already have an open match entry.',
      });
    }
    return mode;
  }

  private queueKey(gameModeId: string): string {
    return this.redis.key('matchmaking', 'queue', gameModeId);
  }

  private queueLockKey(gameModeId: string): string {
    return this.redis.key('lock', 'matchmaking', gameModeId);
  }

  private entryKey(ticketId: string): string {
    return this.redis.key('matchmaking', 'ticket', ticketId);
  }

  private userQueueKey(userId: string): string {
    return this.redis.key('matchmaking', 'user', userId);
  }

  private assignmentKey(userId: string): string {
    return this.redis.key('matchmaking', 'assignment', userId);
  }
}
