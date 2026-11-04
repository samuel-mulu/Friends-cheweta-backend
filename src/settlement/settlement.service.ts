import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { MatchEntryStatus, MatchStatus, WalletTransactionType } from '../generated/prisma/enums';
import { withFinancialTiming } from '../common/utils/financial-instrumentation.util';
import { LudoMatchPhase } from '../games/ludo/domain';
import { LudoMatchRuntimeState } from '../games/ludo/runtime';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RiskService } from '../risk/risk.service';
import { StatsService } from '../stats/stats.service';
import { WalletService } from '../wallet/wallet.service';

// Safety ceiling only - normal settlement should finish far below this.
// `maxWait` bounds how long we wait to acquire a connection/start the
// transaction; `timeout` bounds the transaction body itself. Do not raise
// this further as a substitute for reducing query count (see DB2/DB3).
const SETTLEMENT_TRANSACTION_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  maxWait: 5000,
  timeout: 12000,
} as const;

@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly notifications: NotificationsService,
    private readonly risk: RiskService,
    private readonly stats: StatsService,
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

    // Set inside the transaction: true only on the call that actually settles a
    // non-practice match, so follow-up tasks run exactly once and never for bots.
    let runFollowUp = false;
    const settlement = await withFinancialTiming(this.logger, 'SETTLEMENT', { matchId }, () =>
      this.prisma.$transaction(async (tx) => {
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
        runFollowUp = match.source !== 'PRACTICE';
        return this.serialize(settlement);
      }, SETTLEMENT_TRANSACTION_OPTIONS),
    );

    // The financial COMMIT has already happened above - `settlement` is the
    // durable, authoritative result. Everything below is non-critical
    // follow-up (notifications, risk analysis) and must never block the
    // caller: the realtime gameplay path awaits settleMatchResult() before
    // publishing the MATCH_FINISHED socket event, so the commit -> result ->
    // socket ordering is preserved by returning immediately here, while
    // follow-up work runs in the background and can never turn an
    // already-committed settlement into a reported failure.
    if (runFollowUp) void this.runPostSettlementTasks(matchId, winnerOrder);
    return settlement;
  }

  private async runPostSettlementTasks(matchId: string, winnerOrder: string[]): Promise<void> {
    // Independent steps: one failing never skips the others.
    const step = async (name: string, run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (error) {
        this.logger.warn(`Post-settlement ${name} failed for ${matchId}: ${(error as Error).message}`);
      }
    };
    await step('stats', () => this.stats.recordMatch(matchId));
    await step('notifications', async () => {
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
    });
    await step('risk', () => this.risk.analyzeFinishedMatch(matchId));
  }


  async getByMatchId(matchId: string) {
    const settlement = await this.prisma.matchSettlement.findUnique({ where: { matchId } });
    return settlement ? this.serialize(settlement) : null;
  }

  // DB5: retry-storm protection for reconciliation only. A match stuck
  // FINISHING forever (e.g. a permanently broken settlement) would
  // otherwise be re-attempted - full Serializable transaction and all -
  // every single reconciliation cycle (~5s) indefinitely. This in-memory
  // backoff map spaces out retries per match: 5s, 10s, 20s, then capped at
  // 60s. It is intentionally process-local, not a new table: PostgreSQL
  // remains the durable truth (the match is still correctly FINISHING and
  // will be retried), and a process restart simply resets backoff to
  // "retry immediately once", which is safe. Direct, synchronous
  // settlement attempts (from the gameplay path) are never throttled by
  // this - only the periodic sweep below is.
  private static readonly RETRY_BACKOFF_SCHEDULE_MS = [5_000, 10_000, 20_000, 60_000];
  private static readonly RETRY_STATE_MAX_AGE_MS = 10 * 60 * 1000;
  private readonly retryState = new Map<string, { lastAttemptAt: number; failureCount: number }>();

  async reconcilePending(): Promise<void> {
    const matches = await this.prisma.match.findMany({
      where: { status: MatchStatus.FINISHING, winnerOrder: { not: Prisma.JsonNull } },
      select: { id: true, winnerOrder: true },
      take: 25,
      orderBy: { updatedAt: 'asc' },
    });

    const now = Date.now();
    for (const match of matches) {
      const state = this.retryState.get(match.id);
      if (state && now - state.lastAttemptAt < this.retryBackoffMs(state.failureCount)) {
        continue; // still within this match's backoff window - skip this cycle
      }

      try {
        const winnerOrder = Array.isArray(match.winnerOrder)
          ? match.winnerOrder.filter((value): value is string => typeof value === 'string')
          : [];
        if (winnerOrder.length > 0) await this.settleMatchResult(match.id, winnerOrder);
        this.retryState.delete(match.id);
      } catch (error) {
        this.retryState.set(match.id, { lastAttemptAt: now, failureCount: (state?.failureCount ?? 0) + 1 });
        this.logger.warn(`Settlement retry failed for ${match.id}: ${(error as Error).message}`);
      }
    }

    this.pruneStaleRetryState(now);
  }

  private retryBackoffMs(failureCount: number): number {
    const schedule = SettlementService.RETRY_BACKOFF_SCHEDULE_MS;
    return schedule[Math.min(Math.max(failureCount - 1, 0), schedule.length - 1)];
  }

  private pruneStaleRetryState(now: number): void {
    for (const [matchId, state] of this.retryState) {
      if (now - state.lastAttemptAt > SettlementService.RETRY_STATE_MAX_AGE_MS) {
        this.retryState.delete(matchId);
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
