import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PREMATCH_ORPHAN_STATUSES } from '../../common/match-status';
import { AppEnv } from '../../config/env';
import { GameEntryService } from '../../game-entry/game-entry.service';
import { MatchStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimePublisherService } from '../realtime-publisher.service';
import { GameRegistry } from '../turn-game/game-registry';

/**
 * Matches that never really started: READY games nobody opened in time and
 * CREATED/WAITING commitments that were abandoned. Both are cancelled and
 * refunded, their live state discarded, and the players told. Any game.
 */
@Injectable()
export class PrematchCleanupService {
  private readonly logger = new Logger(PrematchCleanupService.name);
  private readonly readyNoShowSeconds: number;
  private readonly prematchOrphanTimeoutSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gameEntry: GameEntryService,
    private readonly publisher: RealtimePublisherService,
    private readonly games: GameRegistry,
    config: ConfigService<AppEnv, true>,
  ) {
    this.readyNoShowSeconds = config.get('GAME_READY_NO_SHOW_SECONDS', { infer: true });
    this.prematchOrphanTimeoutSeconds = config.get('PREMATCH_ORPHAN_TIMEOUT_SECONDS', { infer: true });
  }

  async processReadyNoShows(): Promise<void> {
    const cutoff = new Date(Date.now() - this.readyNoShowSeconds * 1000);
    const matches = await this.prisma.match.findMany({
      where: { status: MatchStatus.READY, entrySecuredAt: { not: null, lt: cutoff } },
      select: { id: true, game: { select: { code: true } } },
      take: 25,
      orderBy: { entrySecuredAt: 'asc' },
    });
    for (const match of matches) {
      try {
        // Do not start paid gameplay until every participant has joined the
        // realtime match room at least once. A partial join times out to a
        // refund instead of letting an absent player lose by automatic play.
        const game = this.games.get(match.game.code);
        if (!game || (await game.timer.allJoined(match.id))) continue;
        await this.cancelBeforeStart(match.id, 'MATCH_READY_NO_SHOW', 'READY_NO_SHOW_TIMEOUT');
      } catch (error) {
        this.logger.warn(`Ready no-show cleanup failed for ${match.id}: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Cancel abandoned CREATED/WAITING commitments that never started or secured.
   * Aligns with Quick Match Redis TTL so live open slots are not raced.
   */
  async processPrematchOrphans(): Promise<number> {
    const cutoff = new Date(Date.now() - this.prematchOrphanTimeoutSeconds * 1000);
    const candidates = await this.prisma.match.findMany({
      where: {
        status: { in: PREMATCH_ORPHAN_STATUSES },
        createdAt: { lt: cutoff },
        startedAt: null,
        entrySecuredAt: null,
      },
      select: { id: true },
      take: 25,
      orderBy: { createdAt: 'asc' },
    });

    let cancelled = 0;
    for (const candidate of candidates) {
      try {
        const done = await this.cancelBeforeStart(candidate.id, 'PREMATCH_ORPHAN_TIMEOUT', 'PREMATCH_ORPHAN_TIMEOUT', {
          expectedStatuses: PREMATCH_ORPHAN_STATUSES,
        });
        if (!done) continue;
        cancelled += 1;
        this.logger.log(`prematch_orphan_cancelled match=${candidate.id}`);
      } catch (error) {
        this.logger.warn(`Prematch orphan cleanup failed for ${candidate.id}: ${(error as Error).message}`);
      }
    }
    return cancelled;
  }

  /**
   * Refund a match that never started, discard its live runtime so no further
   * commands or timers act on it, and tell the players.
   */
  async cancelBeforeStart(
    matchId: string,
    reason: string,
    clientReason: string,
    options?: { expectedStatuses?: MatchStatus[] },
  ): Promise<boolean> {
    const result = await this.gameEntry.cancelAndRefund(matchId, reason, options);
    if (('skipped' in result && result.skipped) || !result.refunded) return false;

    // Whichever game it was; discarding a missing key is a no-op.
    for (const game of this.games.all()) await game.timer.discard(matchId);
    const players = await this.prisma.matchParticipant.findMany({ where: { matchId }, select: { userId: true } });
    for (const player of players) {
      this.publisher.publishUser(player.userId, 'match:cancelled', { matchId, reason: clientReason }, matchId);
    }
    return true;
  }
}
