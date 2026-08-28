import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { sha256 } from '../common/utils/hash.util';
import { AppEnv } from '../config/env';
import { UserStatus } from '../generated/prisma/enums';
import { GameEntryService } from '../game-entry/game-entry.service';
import { GamingService } from '../gaming/gaming.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { JoinMatchmakingDto } from './dto/join-matchmaking.dto';
import { MatchmakingJoinResult, QueueEntry } from './matchmaking.types';

@Injectable()
export class MatchmakingService {
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
    const assignment = await this.redis.getJson<any>(this.assignmentKey(userId));
    if (assignment) return assignment as MatchmakingJoinResult;

    const mode = await this.assertEligible(userId, dto.gameModeId);
    const queueKey = this.queueKey(mode.id);

    return this.redis.withLock(this.queueLockKey(mode.id), async () => {
      const existingTicketId = await this.redis.raw().get(this.userQueueKey(userId));
      if (existingTicketId) {
        const existingEntry = await this.redis.getJson<QueueEntry>(this.entryKey(existingTicketId));
        if (existingEntry) {
          if (existingEntry.gameModeId !== mode.id) {
            throw new ConflictException({
              code: 'ALREADY_IN_MATCHMAKING',
              message: 'You are already waiting in another matchmaking queue.',
            });
          }
          return { status: 'QUEUED', ticketId: existingEntry.ticketId, gameModeId: mode.id };
        }
        await this.redis.raw().del(this.userQueueKey(userId));
      }

      const entry: QueueEntry = {
        ticketId: randomUUID(),
        userId,
        gameModeId: mode.id,
        joinedAtMs: Date.now(),
      };

      const tx = this.redis.raw().multi();
      tx.set(this.entryKey(entry.ticketId), JSON.stringify(entry), { EX: this.queueTtlSeconds });
      tx.set(this.userQueueKey(userId), entry.ticketId, { EX: this.queueTtlSeconds });
      tx.zAdd(queueKey, [{ score: entry.joinedAtMs, value: entry.ticketId }]);
      tx.expire(queueKey, this.queueTtlSeconds * 2);
      await tx.exec();

      const pair = await this.findEligiblePair(mode.id);
      if (!pair) {
        return { status: 'QUEUED', ticketId: entry.ticketId, gameModeId: mode.id };
      }

      const matchmakingKey = sha256(
        `LUDO|${mode.id}|${[pair[0].ticketId, pair[1].ticketId].sort().join('|')}`,
      );
      const match = await this.gaming.createMatchedMatch(
        mode.id,
        pair.map((item) => item.userId),
        matchmakingKey,
      );

      try {
        await this.gameEntry.secureMatchEntry(match.id);
      } catch (error) {
        // Pairing is not successful until both stakes are locked atomically.
        // Remove the stale tickets so a later join creates a new matchmaking
        // identity instead of reusing a cancelled/failed financial attempt.
        const failed = this.redis.raw().multi();
        for (const item of pair) {
          failed.zRem(queueKey, item.ticketId);
          failed.del(this.entryKey(item.ticketId));
          failed.del(this.userQueueKey(item.userId));
        }
        await failed.exec();
        await this.gameEntry.cancelAndRefund(match.id, 'MATCH_ENTRY_RESERVATION_FAILED').catch(() => undefined);
        throw error;
      }

      const securedMatch = await this.gaming.getMatchForUser(match.id, pair[0].userId);
      const matchedResult = {
        status: 'MATCHED' as const,
        gameModeId: mode.id,
        match: securedMatch,
        userIds: pair.map((item) => item.userId),
      };

      const cleanup = this.redis.raw().multi();
      for (const item of pair) {
        cleanup.zRem(queueKey, item.ticketId);
        cleanup.del(this.entryKey(item.ticketId));
        cleanup.del(this.userQueueKey(item.userId));
        cleanup.set(this.assignmentKey(item.userId), JSON.stringify(matchedResult), { EX: this.queueTtlSeconds });
      }
      await cleanup.exec();

      return matchedResult;
    }, 10000);
  }

  async cancel(userId: string): Promise<{ success: true }> {
    const ticketId = await this.redis.raw().get(this.userQueueKey(userId));
    if (!ticketId) return { success: true };

    const entry = await this.redis.getJson<QueueEntry>(this.entryKey(ticketId));
    if (!entry) {
      await this.redis.raw().del(this.userQueueKey(userId));
      return { success: true };
    }

    return this.redis.withLock(this.queueLockKey(entry.gameModeId), async () => {
      const tx = this.redis.raw().multi();
      tx.zRem(this.queueKey(entry.gameModeId), ticketId);
      tx.del(this.entryKey(ticketId));
      tx.del(this.userQueueKey(userId));
      await tx.exec();
      return { success: true };
    });
  }

  async status(userId: string): Promise<any> {
    const assignment = await this.redis.getJson<any>(this.assignmentKey(userId));
    if (assignment) return assignment;

    const ticketId = await this.redis.raw().get(this.userQueueKey(userId));
    if (!ticketId) return { status: 'IDLE' };
    const entry = await this.redis.getJson<QueueEntry>(this.entryKey(ticketId));
    if (!entry) {
      await this.redis.raw().del(this.userQueueKey(userId));
      return { status: 'IDLE' };
    }
    return { status: 'QUEUED', entry };
  }

  private async findEligiblePair(gameModeId: string): Promise<[QueueEntry, QueueEntry] | null> {
    const queueKey = this.queueKey(gameModeId);
    const ticketIds = await this.redis.raw().zRange(queueKey, 0, 9);
    const eligible: QueueEntry[] = [];

    for (const ticketId of ticketIds) {
      const entry = await this.redis.getJson<QueueEntry>(this.entryKey(ticketId));
      if (!entry) {
        await this.redis.raw().zRem(queueKey, ticketId);
        continue;
      }
      try {
        await this.assertEligible(entry.userId, entry.gameModeId);
        eligible.push(entry);
      } catch {
        const tx = this.redis.raw().multi();
        tx.zRem(queueKey, ticketId);
        tx.del(this.entryKey(ticketId));
        tx.del(this.userQueueKey(entry.userId));
        await tx.exec();
      }
      if (eligible.length === 2) return [eligible[0], eligible[1]];
    }

    return null;
  }

  private async assertEligible(userId: string, gameModeId: string) {
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
        message: 'B13 supports Ludo 1v1 matchmaking only.',
      });
    }

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
