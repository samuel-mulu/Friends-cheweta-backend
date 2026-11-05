import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { GameEntryService } from '../game-entry/game-entry.service';
import { CryptoDiceProvider } from '../games/ludo/dice';
import { LudoMatchPhase, LudoTurnPhase, isLudoRulesVersion } from '../games/ludo/domain';
import { LudoEngine, LudoMovePreview } from '../games/ludo/engine';
import { LudoMatchRuntime, LudoMatchRuntimeState, LudoRuntimeCommand } from '../games/ludo/runtime';
import { MatchStatus } from '../generated/prisma/enums';
import { MatchHistoryService } from '../match-history/match-history.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { SettlementService } from '../settlement/settlement.service';
import { LudoRuntimeRepository } from './ludo-runtime.repository';
import { PerKeyQueue } from './match-persistence.queue';
import { LudoMatchParticipantView, RuntimeExecution } from './realtime.types';

/** Commands slower than this are logged (the hot path is Redis only). */
const SLOW_COMMAND_MS = 250;

/** Player commands wait this long for a concurrent command (e.g. a turn timeout) to finish. */
const COMMAND_LOCK_WAIT_MS = 2000;

@Injectable()
export class LudoRuntimeService {
  private readonly logger = new Logger(LudoRuntimeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly repository: LudoRuntimeRepository,
    private readonly gameEntry: GameEntryService,
    private readonly settlement: SettlementService,
    private readonly history: MatchHistoryService,
  ) {}

  private readonly executedListeners = new Set<(state: LudoMatchRuntimeState) => void>();
  private readonly persistence = new PerKeyQueue();

  async getSnapshot(matchId: string, userId: string): Promise<LudoMatchRuntimeState> {
    if (!(await this.repository.getSnapshot(matchId))) await this.assertParticipant(matchId, userId);
    const state = await this.ensureSnapshot(matchId);
    this.assertPlayer(state, userId);
    await this.repository.refreshSnapshotTtl(matchId);
    return state;
  }

  async getParticipantViews(
    matchId: string,
    state: LudoMatchRuntimeState,
  ): Promise<LudoMatchParticipantView[]> {
    const rows = await this.prisma.matchParticipant.findMany({
      where: { matchId },
      orderBy: { seat: 'asc' },
      include: { user: { select: { id: true, fullName: true } } },
    });
    return rows.map((participant) => ({
      userId: participant.userId,
      fullName: participant.user.fullName,
      seat: participant.seat,
      color:
        state.game.players.find((player) => player.userId === participant.userId)?.color ?? null,
    }));
  }

  /** Landing preview for whoever must move now (derived from state, so never stale). */
  previewMoves(state: LudoMatchRuntimeState): LudoMovePreview[] {
    const game = state.game;
    if (game.turnPhase !== LudoTurnPhase.WAITING_FOR_MOVE || !game.currentPlayerId || game.diceValue === null) return [];
    return new LudoEngine().previewMoves(game, game.currentPlayerId, game.diceValue);
  }

  /**
   * In-process notification after every committed, non-duplicate command
   * (player, timeout or bot). Used by the practice bot driver.
   */
  onExecuted(listener: (state: LudoMatchRuntimeState) => void): () => void {
    this.executedListeners.add(listener);
    return () => this.executedListeners.delete(listener);
  }

  getStoredSnapshot(matchId: string): Promise<LudoMatchRuntimeState | null> {
    return this.repository.getSnapshot(matchId);
  }

  /** Drop live runtime state for a match that was cancelled before it could finish. */
  async discardRuntime(matchId: string): Promise<void> {
    await this.repository.deleteSnapshot(matchId);
  }

  /**
   * The Redis snapshot is committed under the match lock and is the result.
   * PostgreSQL follow-up (history, status, settlement) runs afterwards; if it
   * fails the match is queued for retry rather than failing a move that has
   * already happened.
   */
  async execute(command: LudoRuntimeCommand & { matchId: string }): Promise<RuntimeExecution> {
    const { matchId, ...runtimeCommand } = command;
    const startedAt = Date.now();

    const execution = await this.redis.withLock(
      this.repository.lockKey(matchId),
      async () => {
        const fingerprint = JSON.stringify(command);
        const previous = await this.repository.getCommand(matchId, command.commandId);
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new Error('COMMAND_ID_REUSE');
          const currentState = await this.ensureSnapshot(matchId);
          return {
            commandId: command.commandId,
            version: currentState.game.version,
            duplicate: true,
            state: currentState,
            events: [],
          };
        }

        const state = await this.ensureSnapshot(matchId);
        this.assertPlayer(state, command.playerId);
        const result = LudoMatchRuntime.restore(state, new CryptoDiceProvider()).execute(
          runtimeCommand,
        );
        await this.repository.saveSnapshotAndCommand({
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
      // Redis already holds the authoritative result: notify now, persist later.
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
    if (elapsed > SLOW_COMMAND_MS) this.logger.warn(`ludo_command_slow match=${matchId} type=${command.type} ms=${elapsed}`);
    return execution;
  }

  /** History + match status + settlement. Ordered per match; failures go to the retry set. */
  private async persistAfterCommit(matchId: string, commandId: string, execution: RuntimeExecution): Promise<void> {
    try {
      await this.history.persistExecution({ matchId, commandId, state: execution.state, events: execution.events });
      await this.syncMatchStatus(execution.state);
    } catch (error) {
      this.logger.error(`ludo_post_commit_failed match=${matchId} command=${commandId} reason=${(error as Error).message}`);
      await this.redis
        .raw()
        .sAdd(this.repository.postCommitRetryKey(), matchId)
        .catch(() => undefined);
    }
  }

  /** Wait for queued persistence (tests, graceful shutdown). */
  flushPersistence(matchId?: string): Promise<void> {
    return this.persistence.flush(matchId);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.persistence.flush();
  }

  /** Maintenance: re-apply checkpoint + status/settlement for matches whose post-commit step failed. */
  async retryPostCommit(): Promise<void> {
    const matchIds = await this.redis.raw().sMembers(this.repository.postCommitRetryKey());
    for (const matchId of matchIds.slice(0, 25)) {
      try {
        const state = await this.repository.getSnapshot(matchId);
        if (state) {
          await this.history.saveCheckpoint(matchId, state);
          await this.syncMatchStatus(state);
        }
        await this.redis.raw().sRem(this.repository.postCommitRetryKey(), matchId);
      } catch (error) {
        this.logger.warn(
          `ludo_post_commit_retry_failed match=${matchId} reason=${(error as Error).message}`,
        );
      }
    }
  }

  private async ensureSnapshot(matchId: string): Promise<LudoMatchRuntimeState> {
    const existing = await this.repository.getSnapshot(matchId);
    if (existing) {
      // Only a not-yet-started match can be cancelled (refund), so the DB
      // check is needed only before the first move.
      if (existing.game.phase === LudoMatchPhase.PRE_GAME) await this.gameEntry.assertPlayable(matchId);
      return existing;
    }

    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: { game: true, participants: { orderBy: { seat: 'asc' } } },
    });
    if (!match)
      throw new NotFoundException({ code: 'MATCH_NOT_FOUND', message: 'Match not found.' });
    if (match.game.code !== 'LUDO')
      throw new NotFoundException({
        code: 'NOT_LUDO_MATCH',
        message: 'This runtime only supports Ludo matches.',
      });
    if (([MatchStatus.CANCELLED, MatchStatus.ABORTED] as MatchStatus[]).includes(match.status)) {
      throw new ServiceUnavailableException({
        code: 'MATCH_NOT_ACTIVE',
        message: 'This match is no longer active.',
      });
    }

    if (
      (
        [MatchStatus.PLAYING, MatchStatus.FINISHING, MatchStatus.FINISHED] as MatchStatus[]
      ).includes(match.status)
    ) {
      const durable = await this.history.getCheckpoint(matchId);
      if (!durable) {
        throw new ServiceUnavailableException({
          code: 'LUDO_RUNTIME_SNAPSHOT_MISSING',
          message: 'The active Ludo snapshot and durable checkpoint are unavailable.',
        });
      }
      // NX: never overwrite a newer snapshot written concurrently by a command.
      return this.repository.saveSnapshotIfAbsent(matchId, durable);
    }

    if (!isLudoRulesVersion(match.rulesVersion)) {
      throw new ServiceUnavailableException({
        code: 'UNSUPPORTED_LUDO_RULES_VERSION',
        message: `Unsupported rules version: ${match.rulesVersion}`,
      });
    }
    // Paid gameplay may not start until every participant's stake is secured.
    await this.gameEntry.assertPlayable(matchId);

    const initial = new LudoMatchRuntime(
      match.id,
      match.participants.map((participant) => participant.userId),
      new CryptoDiceProvider(),
      undefined,
      match.rulesVersion,
      { tokensToWin: match.tokensToWin },
    ).getState();
    // Two players joining at once both reach here; exactly one snapshot wins.
    const state = await this.repository.saveSnapshotIfAbsent(matchId, initial);
    await this.history.saveCheckpoint(matchId, state);
    return state;
  }

  private assertPlayer(state: LudoMatchRuntimeState, userId: string): void {
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
    const exists = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: { id: true },
    });
    if (!exists)
      throw new NotFoundException({ code: 'MATCH_NOT_FOUND', message: 'Match not found.' });
    throw new ForbiddenException({
      code: 'MATCH_ACCESS_DENIED',
      message: 'You are not part of this match.',
    });
  }

  /**
   * Derive the durable match status from the authoritative game state.
   * Idempotent, so it is safe for both the live path and retries.
   */
  private async syncMatchStatus(state: LudoMatchRuntimeState): Promise<void> {
    const matchId = state.game.matchId;
    if (state.game.phase === LudoMatchPhase.PRE_GAME) return;

    await this.prisma.match.updateMany({
      where: { id: matchId, status: MatchStatus.READY, entrySecuredAt: { not: null } },
      data: { status: MatchStatus.PLAYING, startedAt: new Date() },
    });
    if (state.game.phase !== LudoMatchPhase.FINISHED) return;

    await this.prisma.match.updateMany({
      where: { id: matchId, status: { in: [MatchStatus.READY, MatchStatus.PLAYING] } },
      data: {
        status: MatchStatus.FINISHING,
        winnerOrder: state.game.winnerOrder,
        resultVersion: state.game.version,
      },
    });
    // Settlement is exactly-once; if it fails here the FINISHING reconciler retries it.
    try {
      await this.settlement.settleLudoMatch(state);
    } catch (error) {
      this.logger.error(`Settlement pending for ${matchId}: ${(error as Error).message}`);
    }
  }
}
