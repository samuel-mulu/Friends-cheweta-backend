import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { MatchEntryStatus, MatchStatus, WalletTransactionType } from '../generated/prisma/enums';
import { withFinancialTiming } from '../common/utils/financial-instrumentation.util';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';

@Injectable()
export class GameEntryService {
  private readonly logger = new Logger(GameEntryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
  ) {}

  /** Gameplay guard: stakes secured and the match not cancelled/aborted. */
  async assertPlayable(matchId: string): Promise<void> {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: { entrySecuredAt: true, status: true },
    });
    if (!match)
      throw new NotFoundException({ code: 'MATCH_NOT_FOUND', message: 'Match not found.' });
    if (([MatchStatus.CANCELLED, MatchStatus.ABORTED] as MatchStatus[]).includes(match.status)) {
      throw new ConflictException({
        code: 'MATCH_NOT_ACTIVE',
        message: 'This match is no longer active.',
      });
    }
    if (!match.entrySecuredAt) {
      throw new ConflictException({
        code: 'MATCH_ENTRY_NOT_SECURED',
        message: 'All player stakes must be secured before the match can start.',
      });
    }
  }

  async cancelAndRefund(
    matchId: string,
    reason: string,
    options?: { expectedStatuses?: MatchStatus[] },
  ) {
    if (!reason.trim()) {
      throw new BadRequestException({
        code: 'CANCELLATION_REASON_REQUIRED',
        message: 'Cancellation reason is required.',
      });
    }

    return withFinancialTiming(this.logger, 'GAME_ENTRY_REFUND', { matchId }, () =>
      this.prisma.$transaction(
        async (tx) => {
          const match = await tx.match.findUnique({
            where: { id: matchId },
            include: { entries: true },
          });
          if (!match)
            throw new NotFoundException({ code: 'MATCH_NOT_FOUND', message: 'Match not found.' });
          if (match.status === MatchStatus.CANCELLED)
            return { matchId, status: MatchStatus.CANCELLED, refunded: true };
          if (
            (
              [MatchStatus.PLAYING, MatchStatus.FINISHING, MatchStatus.FINISHED] as MatchStatus[]
            ).includes(match.status)
          ) {
            throw new ConflictException({
              code: 'MATCH_CANNOT_BE_CANCELLED',
              message: 'A started or finished match cannot use pre-game cancellation.',
            });
          }
          if (options?.expectedStatuses && !options.expectedStatuses.includes(match.status)) {
            return { matchId, status: match.status, refunded: false, skipped: true as const };
          }

          for (const entry of match.entries) {
            if (entry.status !== MatchEntryStatus.LOCKED) continue;
            if (entry.amountMinor > 0n) {
              await this.wallet.releaseFundsInTransaction(tx, {
                userId: entry.userId,
                amountMinor: entry.amountMinor,
                type: WalletTransactionType.GAME_ENTRY_RELEASE,
                idempotencyKey: `game-entry-refund:${match.id}:${entry.userId}`,
                referenceType: 'MATCH',
                referenceId: match.id,
                metadata: { reason: reason.trim() },
              });
            }
            await tx.matchEntry.update({
              where: { id: entry.id },
              data: { status: MatchEntryStatus.REFUNDED, refundedAt: new Date() },
            });
          }

          await tx.match.update({
            where: { id: match.id },
            data: {
              status: MatchStatus.CANCELLED,
              cancelledAt: new Date(),
              cancellationReason: reason.trim(),
            },
          });
          return { matchId, status: MatchStatus.CANCELLED, refunded: true };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }
}
