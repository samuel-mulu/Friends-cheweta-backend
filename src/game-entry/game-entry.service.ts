import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import {
  MatchEntryStatus,
  MatchStatus,
  WalletTransactionType,
} from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';

@Injectable()
export class GameEntryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
  ) {}

  async secureMatchEntry(matchId: string) {
    return this.prisma.$transaction(async (tx) => {
      const match = await tx.match.findUnique({
        where: { id: matchId },
        include: { participants: { orderBy: { seat: 'asc' } }, entries: true },
      });
      if (!match) {
        throw new NotFoundException({ code: 'MATCH_NOT_FOUND', message: 'Match not found.' });
      }
      if (
        ([MatchStatus.PLAYING, MatchStatus.FINISHING, MatchStatus.FINISHED] as MatchStatus[]).includes(
          match.status,
        )
      ) {
        throw new ConflictException({
          code: 'MATCH_ENTRY_ALREADY_CLOSED',
          message: 'Entry cannot be reserved after gameplay has started.',
        });
      }
      if (([MatchStatus.CANCELLED, MatchStatus.ABORTED] as MatchStatus[]).includes(match.status)) {
        throw new ConflictException({ code: 'MATCH_NOT_JOINABLE', message: 'Match is not joinable.' });
      }

      if (match.entrySecuredAt) {
        return this.serialize(matchId, match.entries, match.entrySecuredAt);
      }

      // Claim the entry reservation inside the same DB transaction. Concurrent
      // callers serialize on this row and only one of them may reserve funds.
      const claimed = await tx.match.updateMany({
        where: {
          id: matchId,
          entrySecuredAt: null,
          status: { in: [MatchStatus.CREATED, MatchStatus.WAITING, MatchStatus.READY] },
        },
        data: { entrySecuredAt: new Date() },
      });

      if (claimed.count !== 1) {
        const current = await tx.match.findUnique({
          where: { id: matchId },
          include: { entries: true },
        });
        if (current?.entrySecuredAt) {
          return this.serialize(matchId, current.entries, current.entrySecuredAt);
        }
        throw new ConflictException({
          code: 'MATCH_ENTRY_RESERVATION_CONFLICT',
          message: 'Match entry could not be reserved.',
        });
      }

      const entries = [];
      for (const participant of match.participants) {
        if (match.stakeAmountMinor > 0n) {
          await this.wallet.lockFundsInTransaction(tx, {
            userId: participant.userId,
            amountMinor: match.stakeAmountMinor,
            type: WalletTransactionType.GAME_ENTRY_LOCK,
            idempotencyKey: `game-entry:${match.id}:${participant.userId}`,
            referenceType: 'MATCH',
            referenceId: match.id,
            metadata: { gameModeId: match.gameModeId },
          });
        }

        const entry = await tx.matchEntry.create({
          data: {
            matchId: match.id,
            userId: participant.userId,
            amountMinor: match.stakeAmountMinor,
            status: MatchEntryStatus.LOCKED,
          },
        });
        entries.push(entry);
      }

      await tx.match.update({ where: { id: matchId }, data: { status: MatchStatus.READY } });
      const secured = await tx.match.findUniqueOrThrow({ where: { id: matchId }, select: { entrySecuredAt: true } });
      return this.serialize(matchId, entries, secured.entrySecuredAt!);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async assertSecured(matchId: string): Promise<void> {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: { entrySecuredAt: true, status: true },
    });
    if (!match) throw new NotFoundException({ code: 'MATCH_NOT_FOUND', message: 'Match not found.' });
    if (!match.entrySecuredAt) {
      throw new ConflictException({
        code: 'MATCH_ENTRY_NOT_SECURED',
        message: 'All player stakes must be secured before the match can start.',
      });
    }
  }

  async cancelAndRefund(matchId: string, reason: string) {
    if (!reason.trim()) {
      throw new BadRequestException({ code: 'CANCELLATION_REASON_REQUIRED', message: 'Cancellation reason is required.' });
    }

    return this.prisma.$transaction(async (tx) => {
      const match = await tx.match.findUnique({
        where: { id: matchId },
        include: { entries: true },
      });
      if (!match) throw new NotFoundException({ code: 'MATCH_NOT_FOUND', message: 'Match not found.' });
      if (match.status === MatchStatus.CANCELLED) return { matchId, status: MatchStatus.CANCELLED, refunded: true };
      if (
        ([MatchStatus.PLAYING, MatchStatus.FINISHING, MatchStatus.FINISHED] as MatchStatus[]).includes(
          match.status,
        )
      ) {
        throw new ConflictException({
          code: 'MATCH_CANNOT_BE_CANCELLED',
          message: 'A started or finished match cannot use pre-game cancellation.',
        });
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
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private serialize(matchId: string, entries: Array<{ userId: string; amountMinor: bigint; status: MatchEntryStatus }>, securedAt: Date) {
    return {
      matchId,
      securedAt,
      entries: entries.map((entry) => ({
        userId: entry.userId,
        amountMinor: entry.amountMinor.toString(),
        status: entry.status,
      })),
    };
  }
}
