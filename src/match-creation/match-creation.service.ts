import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { COMMITTED_MATCH_STATUSES } from '../common/match-status';
import { Prisma } from '../generated/prisma/client';
import {
  MatchEntryStatus,
  MatchSource as PrismaMatchSource,
  MatchStatus,
  UserStatus,
  WalletTransactionType,
} from '../generated/prisma/enums';
import { withFinancialTiming } from '../common/utils/financial-instrumentation.util';
import { PrismaService } from '../prisma/prisma.service';

import { WalletService } from '../wallet/wallet.service';
import { isKartaTable, playersPerMatch, supportsPlayerCount } from '../gaming/player-counts';

/** Paid matches come from a challenge, a rematch or an invite (never PRACTICE). */
export type MatchSource = Exclude<PrismaMatchSource, 'PRACTICE'>;

type MatchWithMoney = {
  stakeAmountMinor: bigint;
  gameMode: { stakeAmountMinor: bigint };
  entries?: Array<{ amountMinor: bigint }>;
};

type CreateSecuredMatchInput = {
  gameModeId: string;
  /** Seat order (seat 0 first); as many as the mode plays in one match. */
  playerIds: string[];
  challengeId?: string;
  matchmakingKey?: string;
  source: MatchSource;
  rematchOfMatchId?: string;
  /** "First to N home" (1-4); default 4. */
  tokensToWin?: number;
  /** Karta table rounds only: the table's current (possibly raised) stake. */
  stakeAmountMinor?: bigint;
};

// Prisma's default interactive-transaction timeout is 5s. Match creation makes
// ~15 sequential round trips (mode, eligibility, match, two wallet locks), which
// exceeds 5s when the database is far away (e.g. local dev against Neon).
// Same ceiling as settlement; normal runs finish far below it.
const MATCH_CREATION_TRANSACTION_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  maxWait: 5000,
  timeout: 15000,
} as const;

/** Human-readable match code, e.g. LD-7KQ2MX (unique index on Match.sessionCode). */
export function generateSessionCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'LD-';
  for (let i = 0; i < 6; i += 1) code += alphabet[randomInt(alphabet.length)];
  return code;
}

@Injectable()
export class MatchCreationService {
  private readonly logger = new Logger(MatchCreationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
  ) {}

  async createSecuredMatch(input: CreateSecuredMatchInput) {
    const existing = await this.findExisting(input);
    if (existing) return this.serializeMatch(existing);

    return withFinancialTiming(
      this.logger,
      'MATCH_CREATION',
      { challengeId: input.challengeId, matchmakingKey: input.matchmakingKey },
      () => this.createSecuredMatchAttempts(input),
    );
  }

  private async createSecuredMatchAttempts(input: CreateSecuredMatchInput) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          // Duplicate creates are stopped by the unique challengeId index
          // (P2002 below), so no extra lookup is needed inside the transaction.
          const mode = await tx.gameMode.findUnique({
            where: { id: input.gameModeId },
            include: { game: true },
          });
          if (!mode || !mode.enabled || !mode.game.enabled) {
            throw new NotFoundException({
              code: 'GAME_MODE_NOT_AVAILABLE',
              message: 'Game mode is not available.',
            });
          }
          if (!supportsPlayerCount(mode.game.code, mode.playerCount)) {
            throw new ConflictException({
              code: 'MATCH_CREATION_MODE_NOT_SUPPORTED',
              message: 'This game mode is not supported.',
            });
          }
          const seats = playersPerMatch(mode);
          if (
            input.playerIds.length !== seats ||
            new Set(input.playerIds).size !== input.playerIds.length
          ) {
            throw new ConflictException({
              code: 'INVALID_MATCH_PARTICIPANTS',
              message: `Match requires ${seats} unique players.`,
            });
          }
          if (input.stakeAmountMinor !== undefined && !isKartaTable(mode.rulesVersion)) {
            throw new ConflictException({
              code: 'MATCH_STAKE_OVERRIDE_NOT_ALLOWED',
              message: 'Only table rounds may change the stake.',
            });
          }
          const stake = input.stakeAmountMinor ?? mode.stakeAmountMinor;

          await this.assertPlayersEligible(tx, input.playerIds, stake);
          await this.assertNoActiveMatch(tx, input.playerIds);

          // One statement creates the match READY with participants and entry
          // rows; the wallet locks below join the same transaction, so any
          // failure rolls everything back.
          const match = await tx.match.create({
            data: {
              gameId: mode.gameId,
              gameModeId: mode.id,
              status: MatchStatus.READY,
              entrySecuredAt: new Date(),
              rulesVersion: mode.rulesVersion,
              tokensToWin: input.tokensToWin ?? 4,
              stakeAmountMinor: stake,
              platformFeeBps: mode.platformFeeBps,
              sessionCode: this.sessionCode(),
              challengeId: input.challengeId,
              matchmakingKey: input.matchmakingKey,
              source: input.source,
              rematchOfMatchId: input.rematchOfMatchId,
              participants: {
                create: input.playerIds.map((userId, seat) => ({ userId, seat })),
              },
              entries: {
                create: input.playerIds.map((userId) => ({
                  userId,
                  amountMinor: stake,
                  status: MatchEntryStatus.LOCKED,
                })),
              },
            },
            include: this.matchInclude(),
          });

          if (stake > 0n) {
            for (const userId of input.playerIds) {
              await this.wallet.lockFundsInTransaction(tx, {
                userId,
                amountMinor: stake,
                type: WalletTransactionType.GAME_ENTRY_LOCK,
                idempotencyKey: `game-entry:${match.id}:${userId}`,
                referenceType: 'MATCH',
                referenceId: match.id,
                metadata: {
                  gameModeId: mode.id,
                  source: input.source,
                  challengeId: input.challengeId,
                },
              });
            }
          }
          const ready = match;
          this.logger.log(
            `match_creation_success source=${input.source} match=${ready.id} session=${ready.sessionCode} challenge=${input.challengeId ?? '-'} mode=${mode.id}`,
          );
          return this.serializeMatch(ready);
        }, MATCH_CREATION_TRANSACTION_OPTIONS);
      } catch (error) {
        // Serializable transactions can abort on benign contention (e.g. a
        // concurrent wallet update); the whole attempt is safe to retry.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2034' &&
          attempt < 4
        )
          continue;
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          const rawTarget = error.meta?.target;
          const target = Array.isArray(rawTarget)
            ? rawTarget.join(',')
            : typeof rawTarget === 'string'
              ? rawTarget
              : '';
          if (
            (input.challengeId && target.includes('challengeId')) ||
            (input.matchmakingKey && target.includes('matchmakingKey'))
          ) {
            const duplicate = await this.findExisting(input);
            if (duplicate) return this.serializeMatch(duplicate);
          }
          if (target.includes('sessionCode') && attempt < 4) continue;
        }
        throw error;
      }
    }
    throw new ConflictException({
      code: 'MATCH_CREATION_RETRIES_EXHAUSTED',
      message: 'Could not create the match. Please try again.',
    });
  }

  async findByChallengeId(challengeId: string) {
    const match = await this.prisma.match.findUnique({
      where: { challengeId },
      include: this.matchInclude(),
    });
    return match ? this.serializeMatch(match) : null;
  }

  private async assertPlayersEligible(
    tx: Prisma.TransactionClient,
    playerIds: string[],
    stakeAmountMinor: bigint,
  ): Promise<void> {
    const users = await tx.user.findMany({
      where: { id: { in: playerIds } },
      select: { id: true, status: true, wallet: { select: { availableBalance: true } } },
    });
    if (
      users.length !== playerIds.length ||
      users.some((user) => user.status !== UserStatus.ACTIVE)
    ) {
      throw new BadRequestException({
        code: 'PLAYER_NOT_ELIGIBLE',
        message: 'One player is not eligible.',
      });
    }
    if (users.some((user) => !user.wallet || user.wallet.availableBalance < stakeAmountMinor)) {
      throw new BadRequestException({
        code: 'MATCH_ENTRY_INSUFFICIENT_BALANCE',
        message: 'One player no longer has enough available balance.',
      });
    }
  }

  private async assertNoActiveMatch(
    tx: Prisma.TransactionClient,
    playerIds: string[],
  ): Promise<void> {
    const active = await tx.matchParticipant.findFirst({
      where: {
        userId: { in: playerIds },
        match: { status: { in: COMMITTED_MATCH_STATUSES } },
      },
      select: {
        userId: true,
        matchId: true,
        match: { select: { id: true, status: true } },
      },
    });
    if (active) {
      this.logger.warn(
        `operation=MATCH_CREATION reason=LOBBY_ACTIVE_MATCH blockedUserId=${active.userId} blockingMatchId=${active.matchId} blockingStatus=${active.match.status}`,
      );
      throw new ConflictException({
        code: 'LOBBY_ACTIVE_MATCH',
        message: 'One player is already in a match.',
      });
    }
  }

  private async findExisting(
    input: CreateSecuredMatchInput,
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    if (input.challengeId) {
      const match = await tx.match.findUnique({
        where: { challengeId: input.challengeId },
        include: this.matchInclude(),
      });
      if (match) return match;
    }
    if (input.matchmakingKey) {
      const match = await tx.match.findUnique({
        where: { matchmakingKey: input.matchmakingKey },
        include: this.matchInclude(),
      });
      if (match) return match;
    }
    return null;
  }

  private sessionCode(): string {
    return generateSessionCode();
  }

  private matchInclude() {
    return {
      game: true,
      gameMode: true,
      participants: {
        include: { user: { select: { id: true, fullName: true } } },
        orderBy: { seat: 'asc' as const },
      },
      entries: true,
    };
  }

  private serializeMatch<T extends MatchWithMoney>(match: T) {
    return {
      ...match,
      stakeAmountMinor: match.stakeAmountMinor.toString(),
      gameMode: { ...match.gameMode, stakeAmountMinor: match.gameMode.stakeAmountMinor.toString() },
      entries:
        match.entries?.map((entry) => ({ ...entry, amountMinor: entry.amountMinor.toString() })) ??
        [],
    };
  }
}
