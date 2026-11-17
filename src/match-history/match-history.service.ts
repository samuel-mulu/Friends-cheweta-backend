import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { MatchSource, MatchStatus, UserRole } from '../generated/prisma/enums';
import { LudoMatchRuntimeState } from '../games/ludo/runtime';
import { PrismaService } from '../prisma/prisma.service';

/** Any game's runtime state: history only needs the authoritative version. */
export type VersionedState = { game: { version: number } };
export type RecordedEvent = { type: string; version: number };

/** The money fields of a match row, whatever else was selected with it. */
type MatchRow = {
  stakeAmountMinor: bigint;
  gameMode?: object;
  entries?: Array<{ amountMinor: bigint }>;
  settlement: { potAmountMinor: bigint; platformFeeMinor: bigint; payoutAmountMinor: bigint } | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** Matches that will never receive another event. */
const CLOSED_STATUSES: MatchStatus[] = [MatchStatus.FINISHED, MatchStatus.CANCELLED, MatchStatus.ABORTED];
const PRUNE_BATCH_MATCHES = 200;
const PRUNE_MAX_BATCHES = 10;

@Injectable()
export class MatchHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  async persistExecution(input: {
    matchId: string;
    commandId: string;
    state: VersionedState;
    events: RecordedEvent[];
  }): Promise<void> {
    const stateJson = this.toJson(input.state);
    await this.prisma.$transaction(async (tx) => {
      await this.writeCheckpoint(tx, input.matchId, input.state.game.version, stateJson);

      if (input.events.length === 0) return;
      const existingForCommand = await tx.matchEvent.count({
        where: { matchId: input.matchId, commandId: input.commandId },
      });
      if (existingForCommand > 0) return;

      // Sequence is derived from the authoritative match version instead of
      // reading MAX(sequence). This avoids a race when command N+1 reaches
      // PostgreSQL before command N has finished writing its history. One
      // runtime command emits far fewer than 1,000 domain events.
      const sequenceBase = input.state.game.version * 1_000;
      await tx.matchEvent.createMany({
        skipDuplicates: true,
        data: input.events.map((event, index) => ({
          matchId: input.matchId,
          sequence: sequenceBase + index,
          version: event.version,
          commandId: input.commandId,
          type: event.type,
          payload: this.toJson(event),
        })),
      });
    });
  }

  /** Persist the latest snapshot only (used by post-commit retries). */
  async saveCheckpoint(matchId: string, state: VersionedState): Promise<void> {
    await this.writeCheckpoint(this.prisma, matchId, state.game.version, this.toJson(state));
  }

  /** Monotonic: never replaces a newer checkpoint, even under concurrent writers. */
  private async writeCheckpoint(
    db: Prisma.TransactionClient | PrismaService,
    matchId: string,
    version: number,
    state: Prisma.InputJsonValue,
  ): Promise<void> {
    const updated = await db.matchCheckpoint.updateMany({
      where: { matchId, version: { lt: version } },
      data: { version, state },
    });
    if (updated.count === 0) {
      await db.matchCheckpoint.createMany({ data: [{ matchId, version, state }], skipDuplicates: true });
    }
  }

  async getCheckpoint<TState = LudoMatchRuntimeState>(matchId: string): Promise<TState | null> {
    const row = await this.prisma.matchCheckpoint.findUnique({ where: { matchId } });
    return row ? (row.state as unknown as TState) : null;
  }

  async listMine(userId: string, limit = 20, cursor?: string) {
    const rows = await this.prisma.match.findMany({
      where: { participants: { some: { userId } } },
      include: {
        game: { select: { code: true, name: true } },
        gameMode: { select: { code: true, name: true } },
        participants: {
          orderBy: { seat: 'asc' },
          select: { userId: true, seat: true, resultPosition: true, user: { select: { fullName: true } } },
        },
        settlement: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(limit, 1), 50) + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > Math.min(Math.max(limit, 1), 50);
    if (hasMore) rows.pop();
    return {
      items: rows.map((row) => this.serializeMatch(row)),
      nextCursor: hasMore ? rows.at(-1)?.id ?? null : null,
    };
  }

  async getMatch(matchId: string, requester: { id: string; role: UserRole }) {
    await this.assertCanRead(matchId, requester);
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: {
        game: true,
        gameMode: true,
        participants: { orderBy: { seat: 'asc' }, include: { user: { select: { id: true, fullName: true } } } },
        entries: true,
        settlement: true,
      },
    });
    if (!match) throw new NotFoundException({ code: 'MATCH_NOT_FOUND', message: 'Match not found.' });
    return this.serializeMatch(match);
  }

  async replay(matchId: string, requester: { id: string; role: UserRole }) {
    await this.assertCanRead(matchId, requester);
    const [match, events, checkpoint] = await Promise.all([
      this.prisma.match.findUnique({
        where: { id: matchId },
        include: {
          game: { select: { code: true, name: true } },
          gameMode: { select: { code: true, name: true } },
          participants: { orderBy: { seat: 'asc' }, include: { user: { select: { id: true, fullName: true } } } },
          settlement: true,
        },
      }),
      this.prisma.matchEvent.findMany({ where: { matchId }, orderBy: { sequence: 'asc' } }),
      this.prisma.matchCheckpoint.findUnique({ where: { matchId } }),
    ]);
    if (!match) throw new NotFoundException({ code: 'MATCH_NOT_FOUND', message: 'Match not found.' });
    return {
      match: this.serializeMatch(match),
      events,
      checkpoint: checkpoint ? { version: checkpoint.version, state: checkpoint.state, updatedAt: checkpoint.updatedAt } : null,
    };
  }

  async listAdmin(limit = 50, status?: string) {
    if (status && !(status in MatchStatus)) {
      throw new BadRequestException({ code: 'INVALID_MATCH_STATUS', message: 'Unknown match status.' });
    }
    const rows = await this.prisma.match.findMany({
      where: status ? { status: status as MatchStatus } : undefined,
      include: {
        game: { select: { code: true, name: true } },
        gameMode: { select: { code: true, name: true } },
        participants: { orderBy: { seat: 'asc' }, include: { user: { select: { id: true, fullName: true, phoneNumber: true } } } },
        settlement: true,
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
    });
    return rows.map((row) => this.serializeMatch(row));
  }

  private async assertCanRead(matchId: string, requester: { id: string; role: UserRole }) {
    const match = await this.prisma.match.findUnique({ where: { id: matchId }, select: { id: true } });
    if (!match) throw new NotFoundException({ code: 'MATCH_NOT_FOUND', message: 'Match not found.' });
    if (requester.role === UserRole.ADMIN) return;
    const participant = await this.prisma.matchParticipant.findUnique({
      where: { matchId_userId: { matchId, userId: requester.id } },
      select: { id: true },
    });
    if (!participant) throw new ForbiddenException({ code: 'MATCH_ACCESS_DENIED', message: 'You are not part of this match.' });
  }

  /**
   * Move-by-move events are kept for replay and disputes, then deleted: 30
   * days after a match closes, 1 day for practice. The match row, its result,
   * settlement and final checkpoint stay. Returns the number of rows deleted.
   */
  async pruneEvents(now = Date.now()): Promise<number> {
    const paid = await this.pruneEventsWhere({ updatedAt: { lt: new Date(now - 30 * DAY_MS) } });
    const practice = await this.pruneEventsWhere({ source: MatchSource.PRACTICE, updatedAt: { lt: new Date(now - DAY_MS) } });
    return paid + practice;
  }

  private async pruneEventsWhere(where: Prisma.MatchWhereInput): Promise<number> {
    let deleted = 0;
    for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch += 1) {
      const matches = await this.prisma.match.findMany({
        where: { ...where, status: { in: CLOSED_STATUSES }, events: { some: {} } },
        select: { id: true },
        take: PRUNE_BATCH_MATCHES,
      });
      if (matches.length === 0) break;
      const result = await this.prisma.matchEvent.deleteMany({ where: { matchId: { in: matches.map((match) => match.id) } } });
      deleted += result.count;
      if (matches.length < PRUNE_BATCH_MATCHES) break;
    }
    return deleted;
  }

  private serializeMatch<T extends MatchRow>(row: T) {
    const gameMode = row.gameMode as { stakeAmountMinor?: bigint } | undefined;
    return {
      ...row,
      stakeAmountMinor: row.stakeAmountMinor.toString(),
      gameMode: gameMode ? { ...gameMode, stakeAmountMinor: gameMode.stakeAmountMinor?.toString() } : gameMode,
      entries: row.entries?.map((entry) => ({ ...entry, amountMinor: entry.amountMinor.toString() })),
      settlement: row.settlement
        ? {
            ...row.settlement,
            potAmountMinor: row.settlement.potAmountMinor.toString(),
            platformFeeMinor: row.settlement.platformFeeMinor.toString(),
            payoutAmountMinor: row.settlement.payoutAmountMinor.toString(),
          }
        : null,
    };
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
