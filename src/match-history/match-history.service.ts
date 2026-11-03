import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { UserRole } from '../generated/prisma/enums';
import { LudoMatchRuntimeState, LudoRuntimeEvent } from '../games/ludo/runtime';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MatchHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  async persistExecution(input: {
    matchId: string;
    commandId: string;
    state: LudoMatchRuntimeState;
    events: LudoRuntimeEvent[];
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
  async saveCheckpoint(matchId: string, state: LudoMatchRuntimeState): Promise<void> {
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

  async getCheckpoint(matchId: string): Promise<LudoMatchRuntimeState | null> {
    const row = await this.prisma.matchCheckpoint.findUnique({ where: { matchId } });
    return row ? (row.state as unknown as LudoMatchRuntimeState) : null;
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
    const rows = await this.prisma.match.findMany({
      where: status ? { status: status as any } : undefined,
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

  private serializeMatch(row: any) {
    return {
      ...row,
      stakeAmountMinor: row.stakeAmountMinor?.toString?.() ?? row.stakeAmountMinor,
      gameMode: row.gameMode
        ? {
            ...row.gameMode,
            stakeAmountMinor: row.gameMode.stakeAmountMinor?.toString?.() ?? row.gameMode.stakeAmountMinor,
          }
        : row.gameMode,
      entries: row.entries?.map((entry: any) => ({ ...entry, amountMinor: entry.amountMinor.toString() })),
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
