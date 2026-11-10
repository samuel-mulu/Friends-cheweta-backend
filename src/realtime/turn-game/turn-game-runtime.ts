import { ForbiddenException, Logger, NotFoundException, OnApplicationShutdown, ServiceUnavailableException } from '@nestjs/common';
import { GameEntryService } from '../../game-entry/game-entry.service';
import { MatchStatus } from '../../generated/prisma/enums';
import { MatchHistoryService } from '../../match-history/match-history.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { SettlementService } from '../../settlement/settlement.service';
import { PerKeyQueue } from '../match-persistence.queue';
import { RuntimeStore } from '../runtime-store';
import { TurnGameCommand, TurnGameDefinition, TurnGameEvent, TurnGameState } from './turn-game.definition';

export type TurnGameExecution<S, E> = {
  commandId: string;
  version: number;
  duplicate: boolean;
  state: S;
  events: E[];
};

export type TurnGameParticipantView = { userId: string; fullName: string; seat: number } & Record<string, unknown>;

const SLOW_COMMAND_MS = 250;
const COMMAND_LOCK_WAIT_MS = 2000;

/**
 * Authoritative runtime for a turn game. A command is validated and committed
 * to Redis under the match lock (that is the result); listeners and sockets
 * are told at once; PostgreSQL (history, status, settlement) follows in order
 * per match, off the hot path, with a retry set for failures.
 */
export class TurnGameRuntime<S extends TurnGameState, C extends TurnGameCommand, E extends TurnGameEvent>
  implements OnApplicationShutdown
{
  protected readonly logger: Logger;
  private readonly executedListeners = new Set<(state: S) => void>();
  private readonly persistence = new PerKeyQueue();

  constructor(
    readonly definition: TurnGameDefinition<S, C, E>,
    protected readonly prisma: PrismaService,
    protected readonly redis: RedisService,
    readonly store: RuntimeStore<S, E>,
    private readonly gameEntry: GameEntryService,
    private readonly settlement: SettlementService,
    private readonly history: MatchHistoryService,
  ) {
    this.logger = new Logger(`${definition.code}Runtime`);
  }

  async getSnapshot(matchId: string, userId: string): Promise<S> {
    if (!(await this.store.getSnapshot(matchId))) await this.assertParticipant(matchId, userId);
    const state = await this.ensureSnapshot(matchId);
    this.assertPlayer(state, userId);
    await this.store.refreshSnapshotTtl(matchId);
    return state;
  }

  getStoredSnapshot(matchId: string): Promise<S | null> {
    return this.store.getSnapshot(matchId);
  }

  async discardRuntime(matchId: string): Promise<void> {
    await this.store.deleteSnapshot(matchId);
  }

  /** In-process notification after every committed, non-duplicate command (bots). */
  onExecuted(listener: (state: S) => void): () => void {
    this.executedListeners.add(listener);
    return () => this.executedListeners.delete(listener);
  }

  async getParticipantViews(matchId: string, state: S): Promise<TurnGameParticipantView[]> {
    const rows = await this.prisma.matchParticipant.findMany({
      where: { matchId },
      orderBy: { seat: 'asc' },
      include: { user: { select: { fullName: true } } },
    });
    return rows.map((row) => ({
      userId: row.userId,
      fullName: row.user.fullName,
      seat: row.seat,
      ...(this.definition.playerInfo?.(state, row.userId) ?? {}),
    }));
  }

  async execute(command: C & { matchId: string }): Promise<TurnGameExecution<S, E>> {
    const { matchId, ...runtimeCommand } = command;
    const startedAt = Date.now();

    const execution = await this.redis.withLock(
      this.store.lockKey(matchId),
      async (): Promise<TurnGameExecution<S, E>> => {
        const fingerprint = JSON.stringify(command);
        const previous = await this.store.getCommand(matchId, command.commandId);
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new Error('COMMAND_ID_REUSE');
          const current = await this.ensureSnapshot(matchId);
          return { commandId: command.commandId, version: current.game.version, duplicate: true, state: current, events: [] };
        }

        const state = await this.ensureSnapshot(matchId);
        this.assertPlayer(state, command.playerId);
        const result = this.definition.execute(state, runtimeCommand as unknown as C);
        await this.store.saveSnapshotAndCommand({
          matchId,
          commandId: command.commandId,
          fingerprint,
          state: result.state,
          resultingVersion: result.state.game.version,
          events: result.events,
        });
        return {
          commandId: command.commandId,
          version: result.state.game.version,
          duplicate: false,
          state: result.state,
          events: result.events,
        };
      },
      undefined,
      COMMAND_LOCK_WAIT_MS,
    );

    if (!execution.duplicate) {
      for (const listener of this.executedListeners) {
        try {
          listener(execution.state);
        } catch (error) {
          this.logger.warn(`executed_listener_failed match=${matchId} reason=${(error as Error).message}`);
        }
      }
      void this.persistence.enqueue(matchId, () => this.persistAfterCommit(matchId, command.commandId, execution));
    }
    const elapsed = Date.now() - startedAt;
    if (elapsed > SLOW_COMMAND_MS) this.logger.warn(`${this.definition.key}_command_slow match=${matchId} type=${command.type} ms=${elapsed}`);
    return execution;
  }

  flushPersistence(matchId?: string): Promise<void> {
    return this.persistence.flush(matchId);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.persistence.flush();
  }

  /** Maintenance: re-apply checkpoint + status/settlement for matches whose post-commit step failed. */
  async retryPostCommit(): Promise<void> {
    const matchIds = await this.redis.raw().sMembers(this.store.postCommitRetryKey());
    for (const matchId of matchIds.slice(0, 25)) {
      try {
        const state = await this.store.getSnapshot(matchId);
        if (state) {
          await this.history.saveCheckpoint(matchId, state);
          await this.syncMatchStatus(state);
        }
        await this.redis.raw().sRem(this.store.postCommitRetryKey(), matchId);
      } catch (error) {
        this.logger.warn(`${this.definition.key}_post_commit_retry_failed match=${matchId} reason=${(error as Error).message}`);
      }
    }
  }

  private async persistAfterCommit(matchId: string, commandId: string, execution: TurnGameExecution<S, E>): Promise<void> {
    try {
      await this.history.persistExecution({ matchId, commandId, state: execution.state, events: execution.events });
      await this.syncMatchStatus(execution.state);
    } catch (error) {
      this.logger.error(`${this.definition.key}_post_commit_failed match=${matchId} command=${commandId} reason=${(error as Error).message}`);
      await this.redis.raw().sAdd(this.store.postCommitRetryKey(), matchId).catch(() => undefined);
    }
  }

  private async ensureSnapshot(matchId: string): Promise<S> {
    const existing = await this.store.getSnapshot(matchId);
    if (existing) {
      // Only a match nobody has acted in yet can still be cancelled (refund).
      if (existing.game.version === 0) await this.gameEntry.assertPlayable(matchId);
      return existing;
    }

    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: { game: true, participants: { orderBy: { seat: 'asc' } } },
    });
    if (!match) throw new NotFoundException({ code: 'MATCH_NOT_FOUND', message: 'Match not found.' });
    if (match.game.code !== this.definition.code) {
      throw new NotFoundException({ code: 'WRONG_GAME', message: `This is not a ${this.definition.code} match.` });
    }
    if (([MatchStatus.CANCELLED, MatchStatus.ABORTED] as MatchStatus[]).includes(match.status)) {
      throw new ServiceUnavailableException({ code: 'MATCH_NOT_ACTIVE', message: 'This match is no longer active.' });
    }
    if (([MatchStatus.PLAYING, MatchStatus.FINISHING, MatchStatus.FINISHED] as MatchStatus[]).includes(match.status)) {
      const durable = await this.history.getCheckpoint<S>(matchId);
      if (!durable) {
        throw new ServiceUnavailableException({
          code: 'RUNTIME_SNAPSHOT_MISSING',
          message: 'The live match state and its checkpoint are unavailable.',
        });
      }
      return this.store.saveSnapshotIfAbsent(matchId, durable);
    }
    if (!this.definition.isRulesVersion(match.rulesVersion)) {
      throw new ServiceUnavailableException({
        code: 'UNSUPPORTED_RULES_VERSION',
        message: `Unsupported rules version: ${match.rulesVersion}`,
      });
    }
    await this.gameEntry.assertPlayable(matchId);

    const ids = match.participants.map((participant) => participant.userId);
    if (ids.length !== 2) throw new ServiceUnavailableException({ code: 'NEEDS_TWO_PLAYERS', message: 'This game needs two players.' });
    const initial = this.definition.create(match.id, ids, match.rulesVersion);
    const state = await this.store.saveSnapshotIfAbsent(matchId, initial);
    await this.history.saveCheckpoint(matchId, state);
    return state;
  }

  private assertPlayer(state: S, userId: string): void {
    if (!state.game.players.some((player) => player.userId === userId)) {
      throw new ForbiddenException({ code: 'MATCH_ACCESS_DENIED', message: 'You are not part of this match.' });
    }
  }

  private async assertParticipant(matchId: string, userId: string): Promise<void> {
    const participant = await this.prisma.matchParticipant.findUnique({
      where: { matchId_userId: { matchId, userId } },
      select: { id: true },
    });
    if (participant) return;
    const exists = await this.prisma.match.findUnique({ where: { id: matchId }, select: { id: true } });
    if (!exists) throw new NotFoundException({ code: 'MATCH_NOT_FOUND', message: 'Match not found.' });
    throw new ForbiddenException({ code: 'MATCH_ACCESS_DENIED', message: 'You are not part of this match.' });
  }

  /** Durable status from the authoritative state. Idempotent (live path and retries). */
  private async syncMatchStatus(state: S): Promise<void> {
    const { game } = state;
    const finished = this.definition.isFinished(state);
    if (!finished && game.version === 0) return; // nobody has acted yet

    await this.prisma.match.updateMany({
      where: { id: game.matchId, status: MatchStatus.READY, entrySecuredAt: { not: null } },
      data: { status: MatchStatus.PLAYING, startedAt: new Date() },
    });
    if (!finished) return;

    const draw = game.result === 'DRAW';
    await this.prisma.match.updateMany({
      where: { id: game.matchId, status: { in: [MatchStatus.READY, MatchStatus.PLAYING] } },
      data: { status: MatchStatus.FINISHING, winnerOrder: game.winnerOrder, resultVersion: game.version, isDraw: draw },
    });
    try {
      if (draw) await this.settlement.settleDraw(game.matchId);
      else await this.settlement.settleMatchResult(game.matchId, game.winnerOrder);
    } catch (error) {
      // The FINISHING reconciler retries settlement.
      this.logger.error(`Settlement pending for ${game.matchId}: ${(error as Error).message}`);
    }
  }
}
