import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { MatchEntryStatus, MatchStatus, WalletTransactionType } from '../generated/prisma/enums';
import { LudoMatchPhase } from '../games/ludo/domain';
import { LudoMatchRuntimeState } from '../games/ludo/runtime';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RiskService } from '../risk/risk.service';
import { WalletService } from '../wallet/wallet.service';

@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly notifications: NotificationsService,
    private readonly risk: RiskService,
  ) {}

  settleLudoMatch(state: LudoMatchRuntimeState) {
    if (state.game.phase !== LudoMatchPhase.FINISHED || state.game.winnerOrder.length === 0) {
      throw new ConflictException({ code: 'MATCH_RESULT_NOT_FINAL', message: 'Match result is not final.' });
    }
    return this.settleMatchResult(state.game.matchId, state.game.winnerOrder);
  }

  async settleMatchResult(matchId: string, winnerOrder: string[]) {
    if (winnerOrder.length === 0 || new Set(winnerOrder).size !== winnerOrder.length) {
      throw new ConflictException({ code: 'INVALID_WINNER_ORDER', message: 'Winner order is invalid.' });
    }
    const winnerId = winnerOrder[0];

    const settlement = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.matchSettlement.findUnique({ where: { matchId } });
      if (existing) return this.serialize(existing);

      const match = await tx.match.findUnique({
        where: { id: matchId },
        include: { entries: true, participants: true },
      });
      if (!match) throw new NotFoundException({ code: 'MATCH_NOT_FOUND', message: 'Match not found.' });
      if (!match.entrySecuredAt) {
        throw new ConflictException({ code: 'MATCH_ENTRY_NOT_SECURED', message: 'Cannot settle unsecured match entry.' });
      }
      const participantIds = new Set(match.participants.map((p) => p.userId));
      if (winnerOrder.length !== participantIds.size || winnerOrder.some((id) => !participantIds.has(id))) {
        throw new ConflictException({ code: 'INVALID_MATCH_WINNER', message: 'Winner order must contain every participant exactly once.' });
      }
      if (match.entries.length !== match.participants.length || match.entries.some((e) => e.status !== MatchEntryStatus.LOCKED)) {
        throw new ConflictException({ code: 'MATCH_ENTRY_STATE_INVALID', message: 'Match entry funds are not in a settleable state.' });
      }
      if (match.platformFeeBps < 0 || match.platformFeeBps > 10_000) {
        throw new ConflictException({ code: 'INVALID_PLATFORM_FEE', message: 'Platform fee basis points are invalid.' });
      }

      const claimed = await tx.match.updateMany({
        where: { id: match.id, status: { in: [MatchStatus.PLAYING, MatchStatus.FINISHING] } },
        data: { status: MatchStatus.FINISHING },
      });
      if (claimed.count !== 1) {
        const duplicate = await tx.matchSettlement.findUnique({ where: { matchId } });
        if (duplicate) return this.serialize(duplicate);
        throw new ConflictException({ code: 'MATCH_NOT_SETTLEABLE', message: 'Match is not in a settleable state.' });
      }

      let pot = 0n;
      for (const entry of match.entries) {
        pot += entry.amountMinor;
        if (entry.amountMinor > 0n) {
          await this.wallet.debitLockedInTransaction(tx, {
            userId: entry.userId,
            amountMinor: entry.amountMinor,
            type: WalletTransactionType.GAME_ENTRY_SPEND,
            idempotencyKey: `match-settlement:${match.id}:stake:${entry.userId}`,
            referenceType: 'MATCH',
            referenceId: match.id,
            metadata: { winnerUserId: winnerId },
          });
        }
      }

      const fee = (pot * BigInt(match.platformFeeBps)) / 10_000n;
      const payout = pot - fee;
      if (payout < 0n) throw new ConflictException({ code: 'INVALID_SETTLEMENT_AMOUNT', message: 'Calculated payout is invalid.' });

      if (payout > 0n) {
        await this.wallet.creditAvailableInTransaction(tx, {
          userId: winnerId,
          amountMinor: payout,
          type: WalletTransactionType.GAME_WIN,
          idempotencyKey: `match-settlement:${match.id}:winner:${winnerId}`,
          referenceType: 'MATCH',
          referenceId: match.id,
          metadata: { potAmountMinor: pot.toString(), platformFeeMinor: fee.toString() },
        });
      }

      for (const [index, playerId] of winnerOrder.entries()) {
        await tx.matchParticipant.updateMany({
          where: { matchId, userId: playerId },
          data: { resultPosition: index + 1, finishedAt: new Date() },
        });
      }
      await tx.matchEntry.updateMany({
        where: { matchId, status: MatchEntryStatus.LOCKED },
        data: { status: MatchEntryStatus.SETTLED, settledAt: new Date() },
      });

      const settlement = await tx.matchSettlement.create({
        data: {
          matchId,
          winnerUserId: winnerId,
          potAmountMinor: pot,
          platformFeeMinor: fee,
          payoutAmountMinor: payout,
          winnerOrder,
        },
      });

      await tx.match.update({
        where: { id: matchId },
        data: { status: MatchStatus.FINISHED, finishedAt: new Date(), winnerOrder },
      });
      return this.serialize(settlement);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    try {
      for (const [index, userId] of winnerOrder.entries()) {
        await this.notifications.create({
          userId,
          type: 'MATCH_RESULT',
          title: index === 0 ? 'You won the match' : 'Match finished',
          message: index === 0 ? 'Your Ludo match was settled successfully.' : `You finished position ${index + 1}.`,
          data: { matchId, position: index + 1 },
          dedupeKey: `match-result:${matchId}:${userId}`,
        });
      }
      await this.risk.analyzeFinishedMatch(matchId);
    } catch (error) {
      this.logger.warn(`Post-settlement follow-up failed for ${matchId}: ${(error as Error).message}`);
    }
    return settlement;
  }

  async getByMatchId(matchId: string) {
    const settlement = await this.prisma.matchSettlement.findUnique({ where: { matchId } });
    return settlement ? this.serialize(settlement) : null;
  }

  async reconcilePending(): Promise<void> {
    const matches = await this.prisma.match.findMany({
      where: { status: MatchStatus.FINISHING, winnerOrder: { not: Prisma.JsonNull } },
      select: { id: true, winnerOrder: true },
      take: 25,
      orderBy: { updatedAt: 'asc' },
    });
    for (const match of matches) {
      try {
        const winnerOrder = Array.isArray(match.winnerOrder)
          ? match.winnerOrder.filter((value): value is string => typeof value === 'string')
          : [];
        if (winnerOrder.length > 0) await this.settleMatchResult(match.id, winnerOrder);
      } catch (error) {
        this.logger.warn(`Settlement retry failed for ${match.id}: ${(error as Error).message}`);
      }
    }
  }

  private serialize(row: {
    id: string;
    matchId: string;
    winnerUserId: string;
    potAmountMinor: bigint;
    platformFeeMinor: bigint;
    payoutAmountMinor: bigint;
    winnerOrder: unknown;
    settledAt: Date;
  }) {
    return {
      ...row,
      potAmountMinor: row.potAmountMinor.toString(),
      platformFeeMinor: row.platformFeeMinor.toString(),
      payoutAmountMinor: row.payoutAmountMinor.toString(),
    };
  }
}
