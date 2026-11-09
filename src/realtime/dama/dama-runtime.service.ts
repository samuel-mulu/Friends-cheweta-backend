import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationShutdown,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { GameEntryService } from '../../game-entry/game-entry.service';
import { DamaMove, DamaPhase, isDamaRulesVersion } from '../../games/dama/domain';
import {
  DamaMatchRuntimeState,
  DamaRuntimeCommand,
  DamaRuntimeEvent,
  createDamaMatch,
  currentLegalMoves,
  executeDamaCommand,
} from '../../games/dama/runtime';
import { MatchStatus } from '../../generated/prisma/enums';
import { MatchHistoryService } from '../../match-history/match-history.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { SettlementService } from '../../settlement/settlement.service';
import { PerKeyQueue } from '../match-persistence.queue';
import { DamaRuntimeRepository } from './dama-runtime.repository';

export const DAMA_GAME_CODE = 'DAMA';

export type DamaExecution = {
  commandId: string;
  version: number;
  duplicate: boolean;
  state: DamaMatchRuntimeState;
  events: DamaRuntimeEvent[];
};

export type DamaParticipantView = {
  userId: string;
  fullName: string;
  seat: number;
  color: string | null;
};

const SLOW_COMMAND_MS = 250;
const COMMAND_LOCK_WAIT_MS = 2000;

/**
 * Authoritative Dama matches. Same contract as the Ludo runtime: a command is
 * validated and committed to Redis under the match lock (that is the result),
 * listeners and sockets are told at once, and PostgreSQL (history, status,
 * settlement) follows in order per match off the hot path.
 */
@Injectable()
export class DamaRuntimeService implements OnApplicationShutdown {
  private readonly logger = new Logger(DamaRuntimeService.name);
  private readonly executedListeners = new Set<(state: DamaMatchRuntimeState) => void>();
  private readonly persistence = new PerKeyQueue();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly store: DamaRuntimeRepository,
    private readonly gameEntry: GameEntryService,
    private readonly settlement: SettlementService,
    private readonly history: MatchHistoryService,
  ) {}

  async getSnapshot(matchId: string, userId: string): Promise<DamaMatchRuntimeState> {
    if (!(await this.store.getSnapshot(matchId))) await this.assertParticipant(matchId, userId);
    const state = await this.ensureSnapshot(matchId);
    this.assertPlayer(state, userId);
    await this.store.refreshSnapshotTtl(matchId);
    return state;
  }

  getStoredSnapshot(matchId: string): Promise<DamaMatchRuntimeState | null> {
    return this.store.getSnapshot(matchId);
  }

  legalMoves(state: DamaMatchRuntimeState): DamaMove[] {
    return currentLegalMoves(state);
  }

  async discardRuntime(matchId: string): Promise<void> {
    await this.store.deleteSnapshot(matchId);
  }

  /** In-process notification after every committed, non-duplicate command (bots). */
  onExecuted(listener: (state: DamaMatchRuntimeState) => void): () => void {
    this.executedListeners.add(listener);
    return () => this.executedListeners.delete(listener);
  }

  async getParticipantViews(matchId: string, state: DamaMatchRuntimeState): Promise<DamaParticipantView[]> {
    const rows = await this.prisma.matchParticipant.findMany({
      where: { matchId },
      orderBy: { seat: 'asc' },
      include: { user: { select: { fullName: true } } },
    });
    return rows.map((row) => ({
      userId: row.userId,
      fullName: row.user.fullName,
      seat: row.seat,
      color: state.game.players.find((player) => player.userId === row.userId)?.color ?? null,
    }));
  }

  async execute(command: DamaRuntimeCommand & { matchId: string }): Promise<DamaExecution> {
    const { matchId, ...runtimeCommand } = command;
    const startedAt = Date.now();

    const execution = await this.redis.withLock(
      this.store.lockKey(matchId),
      async (): Promise<DamaExecution> => {
        const fingerprint = JSON.stringify(command);
        const previous = await this.store.getCommand(matchId, command.commandId);
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new Error('COMMAND_ID_REUSE');
          const current = await this.ensureSnapshot(matchId);
          return { commandId: command.commandId, version: current.game.version, duplicate: true, state: current, events: [] };
        }

        const state = await this.ensureSnapshot(matchId);
        this.assertPlayer(state, command.playerId);
        const result = executeDamaCommand(state, runtimeCommand);
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
    if (elapsed > SLOW_COMMAND_MS) this.logger.warn(`dama_command_slow match=${matchId} type=${command.type} ms=${elapsed}`);
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
        this.logger.warn(`dama_post_commit_retry_failed match=${matchId} reason=${(error as Error).message}`);
      }
    }
  }

  private async persistAfterCommit(matchId: string, commandId: string, execution: DamaExecution): Promise<void> {
    try {
      await this.history.persistExecution({ matchId, commandId, state: execution.state, events: execution.events });
      await this.syncMatchStatus(execution.state);
    } catch (error) {
      this.logger.error(`dama_post_commit_failed match=${matchId} command=${commandId} reason=${(error as Error).message}`);
      await this.redis.raw().sAdd(this.store.postCommitRetryKey(), matchId).catch(() => undefined);
    }
  }

  private async ensureSnapshot(matchId: string): Promise<DamaMatchRuntimeState> {
    const existing = await this.store.getSnapshot(matchId);
    if (existing) {
      // Only a match nobody has moved in yet can still be cancelled (refund).
      if (existing.game.version === 0) await this.gameEntry.assertPlayable(matchId);
      return existing;
    }

    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: { game: true, participants: { orderBy: { seat: 'asc' } } },
    });
    if (!match) throw new NotFoundException({ code: 'MATCH_NOT_FOUND', message: 'Match not found.' });
    if (match.game.code !== DAMA_GAME_CODE) {
      throw new NotFoundException({ code: 'NOT_DAMA_MATCH', message: 'This is not a Dama match.' });
    }
    if (([MatchStatus.CANCELLED, MatchStatus.ABORTED] as MatchStatus[]).includes(match.status)) {
      throw new ServiceUnavailableException({ code: 'MATCH_NOT_ACTIVE', message: 'This match is no longer active.' });
    }
    if (([MatchStatus.PLAYING, MatchStatus.FINISHING, MatchStatus.FINISHED] as MatchStatus[]).includes(match.status)) {
      const durable = await this.history.getCheckpoint<DamaMatchRuntimeState>(matchId);
      if (!durable) {
        throw new ServiceUnavailableException({
          code: 'DAMA_RUNTIME_SNAPSHOT_MISSING',
          message: 'The live Dama state and its checkpoint are unavailable.',
        });
      }
      return this.store.saveSnapshotIfAbsent(matchId, durable);
    }
    if (!isDamaRulesVersion(match.rulesVersion)) {
      throw new ServiceUnavailableException({
        code: 'UNSUPPORTED_DAMA_RULES_VERSION',
        message: `Unsupported rules version: ${match.rulesVersion}`,
      });
    }
    await this.gameEntry.assertPlayable(matchId);

    // Colours are drawn fairly: whoever gets Light moves first.
    const ids = match.participants.map((participant) => participant.userId);
    if (ids.length !== 2) throw new ServiceUnavailableException({ code: 'DAMA_NEEDS_TWO_PLAYERS', message: 'Dama needs two players.' });
    const light = randomInt(2);
    const initial = createDamaMatch(match.id, ids[light], ids[1 - light]);
    const state = await this.store.saveSnapshotIfAbsent(matchId, initial);
    await this.history.saveCheckpoint(matchId, state);
    return state;
  }

  private assertPlayer(state: DamaMatchRuntimeState, userId: string): void {
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
  private async syncMatchStatus(state: DamaMatchRuntimeState): Promise<void> {
    const { game } = state;
    if (game.phase === DamaPhase.PLAYING && game.plyCount === 0) return; // nobody has moved yet

    await this.prisma.match.updateMany({
      where: { id: game.matchId, status: MatchStatus.READY, entrySecuredAt: { not: null } },
      data: { status: MatchStatus.PLAYING, startedAt: new Date() },
    });
    if (game.phase !== DamaPhase.FINISHED) return;

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
