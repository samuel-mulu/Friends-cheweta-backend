import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppEnv } from '../../config/env';
import { MatchStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { PresenceService } from '../presence.service';
import { GameRegistry } from '../turn-game/game-registry';
import { PrematchCleanupService } from './prematch-cleanup.service';

/**
 * A player whose last socket dropped gets a grace period to come back. After
 * it, a match that has not started is cancelled and refunded; a match in play
 * is resigned for them (any game). Coming back cancels the deadline.
 */
@Injectable()
export class DisconnectGraceService {
  private readonly logger = new Logger(DisconnectGraceService.name);
  private readonly graceSeconds: number;

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly presence: PresenceService,
    private readonly games: GameRegistry,
    private readonly prematch: PrematchCleanupService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.graceSeconds = config.get('GAME_DISCONNECT_GRACE_SECONDS', { infer: true });
  }

  async onConnected(userId: string): Promise<void> {
    await this.clear(userId);
  }

  async onDisconnected(userId: string): Promise<void> {
    if (await this.presence.isOnline(userId)) return;
    const endsAtMs = Date.now() + this.graceSeconds * 1000;
    await this.redis
      .raw()
      .multi()
      .set(this.deadlineKey(userId), String(endsAtMs), { EX: this.graceSeconds + 120 })
      .zAdd(this.queueKey(), [{ score: endsAtMs, value: userId }])
      .exec();
  }

  async processDue(): Promise<void> {
    const now = Date.now();
    const userIds = await this.redis
      .raw()
      .zRangeByScore(this.queueKey(), 0, now, { LIMIT: { offset: 0, count: 25 } });
    for (const userId of userIds) {
      try {
        await this.processOne(userId, now);
      } catch (error) {
        this.logger.warn(
          `Disconnect grace processing failed for ${userId}: ${(error as Error).message}`,
        );
      }
    }
  }

  private async processOne(userId: string, now: number): Promise<void> {
    if (await this.presence.isOnline(userId)) {
      await this.clear(userId);
      return;
    }
    const rawDeadline = await this.redis.raw().get(this.deadlineKey(userId));
    if (!rawDeadline || Number(rawDeadline) > now) return;

    const participant = await this.prisma.matchParticipant.findFirst({
      where: { userId, match: { status: { in: [MatchStatus.READY, MatchStatus.PLAYING] } } },
      select: {
        matchId: true,
        match: { select: { status: true, game: { select: { code: true } } } },
      },
      orderBy: { joinedAt: 'desc' },
    });
    if (!participant) {
      await this.clear(userId);
      return;
    }

    if (participant.match.status === MatchStatus.READY) {
      await this.prematch.cancelBeforeStart(
        participant.matchId,
        'PLAYER_DISCONNECTED_BEFORE_START',
        'DISCONNECT_GRACE_EXPIRED',
      );
    } else {
      const game = this.games.get(participant.match.game.code);
      if (game) await game.timer.forfeitAbsent(participant.matchId, userId);
    }
    await this.clear(userId);
  }

  private async clear(userId: string): Promise<void> {
    await this.redis
      .raw()
      .multi()
      .zRem(this.queueKey(), userId)
      .del(this.deadlineKey(userId))
      .exec();
  }

  private queueKey(): string {
    return this.redis.key('runtime', 'disconnect-deadlines');
  }

  private deadlineKey(userId: string): string {
    return this.redis.key('runtime', 'disconnect', userId);
  }
}
