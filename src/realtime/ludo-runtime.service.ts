import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { GameEntryService } from '../game-entry/game-entry.service';
import { CryptoDiceProvider } from '../games/ludo/dice';
import { LudoMatchPhase } from '../games/ludo/domain';
import {
  LudoMatchRuntime,
  LudoRuntimeCommand,
  LudoRuntimeEventType,
  LudoMatchRuntimeState,
} from '../games/ludo/runtime';
import { MatchStatus } from '../generated/prisma/enums';
import { MatchHistoryService } from '../match-history/match-history.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { SettlementService } from '../settlement/settlement.service';
import { LudoRuntimeRepository } from './ludo-runtime.repository';
import { RuntimeExecution } from './realtime.types';

function commandFingerprint(command: LudoRuntimeCommand & { matchId: string }): string {
  return JSON.stringify(command);
}

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

  async getSnapshot(matchId: string, userId: string): Promise<LudoMatchRuntimeState> {
    await this.assertParticipant(matchId, userId);
    const state = await this.ensureSnapshot(matchId);
    await this.repository.refreshSnapshotTtl(matchId);
    return state;
  }

  getStoredSnapshot(matchId: string): Promise<LudoMatchRuntimeState | null> {
    return this.repository.getSnapshot(matchId);
  }

  async execute(command: LudoRuntimeCommand & { matchId: string }): Promise<RuntimeExecution> {
    const matchId = command.matchId;
    await this.assertParticipant(matchId, command.playerId);

    const lockedExecution = await this.redis.withLock(this.repository.lockKey(matchId), async () => {
      const fingerprint = commandFingerprint(command);
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
          durableEvents: previous.events ?? [],
        };
      }

      const state = await this.ensureSnapshot(matchId);
      const runtime = LudoMatchRuntime.restore(state, new CryptoDiceProvider());
      const { matchId: _matchId, ...runtimeCommand } = command;
      const result = runtime.execute(runtimeCommand as LudoRuntimeCommand);

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
        durableEvents: result.events,
      };
    });

    // Keep the distributed gameplay lock narrow: runtime mutation and Redis
    // persistence happen under the lock. PostgreSQL history/settlement follows.
    await this.history.persistExecution({
      matchId,
      commandId: command.commandId,
      state: lockedExecution.state,
      events: lockedExecution.durableEvents,
    });
    await this.afterStatePersisted(lockedExecution.state, lockedExecution.events.map((event) => event.type));
    const { durableEvents: _durableEvents, ...execution } = lockedExecution;
    return execution satisfies RuntimeExecution;
  }

  private async ensureSnapshot(matchId: string): Promise<LudoMatchRuntimeState> {
    const existing = await this.repository.getSnapshot(matchId);
    if (existing) {
      await this.gameEntry.assertSecured(matchId);
      return existing;
    }

    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: {
        game: true,
        participants: { orderBy: { seat: 'asc' } },
      },
    });
    if (!match) throw new NotFoundException({ code: 'MATCH_NOT_FOUND', message: 'Match not found.' });
    if (match.game.code !== 'LUDO') {
      throw new NotFoundException({ code: 'NOT_LUDO_MATCH', message: 'This runtime only supports Ludo matches.' });
    }

    if (
      ([MatchStatus.PLAYING, MatchStatus.FINISHING, MatchStatus.FINISHED] as MatchStatus[]).includes(
        match.status,
      )
    ) {
      const durable = await this.history.getCheckpoint(matchId);
      if (durable) {
        await this.repository.saveSnapshot(matchId, durable);
        return durable;
      }
      throw new ServiceUnavailableException({
        code: 'LUDO_RUNTIME_SNAPSHOT_MISSING',
        message: 'The active Ludo snapshot and durable checkpoint are unavailable.',
      });
    }
    if (([MatchStatus.CANCELLED, MatchStatus.ABORTED] as MatchStatus[]).includes(match.status)) {
      throw new ServiceUnavailableException({ code: 'MATCH_NOT_ACTIVE', message: 'This match is no longer active.' });
    }
    if (match.rulesVersion !== 'LUDO_CLASSIC_V1') {
      throw new ServiceUnavailableException({
        code: 'UNSUPPORTED_LUDO_RULES_VERSION',
        message: `Unsupported rules version: ${match.rulesVersion}`,
      });
    }

    // B15 hard boundary: paid/free matched sessions may not instantiate the
    // authoritative game runtime until every participant entry is secured.
    await this.gameEntry.assertSecured(matchId);

    const runtime = new LudoMatchRuntime(
      match.id,
      match.participants.map((participant) => participant.userId),
      new CryptoDiceProvider(),
    );
    const state = runtime.getState();
    await this.repository.saveSnapshot(matchId, state);
    await this.history.saveInitialCheckpoint(matchId, state);

    if (match.status !== MatchStatus.READY) {
      await this.prisma.match.update({ where: { id: match.id }, data: { status: MatchStatus.READY } });
    }
    return state;
  }

  private async assertParticipant(matchId: string, userId: string): Promise<void> {
    const participant = await this.prisma.matchParticipant.findUnique({
      where: { matchId_userId: { matchId, userId } },
      select: { id: true },
    });
    if (!participant) {
      const exists = await this.prisma.match.findUnique({ where: { id: matchId }, select: { id: true } });
      if (!exists) throw new NotFoundException({ code: 'MATCH_NOT_FOUND', message: 'Match not found.' });
      throw new ForbiddenException({ code: 'MATCH_ACCESS_DENIED', message: 'You are not part of this match.' });
    }
  }

  private async afterStatePersisted(
    state: LudoMatchRuntimeState,
    eventTypes: LudoRuntimeEventType[],
  ): Promise<void> {
    if (eventTypes.includes(LudoRuntimeEventType.MATCH_STARTED)) {
      await this.prisma.match.updateMany({
        where: { id: state.game.matchId, status: MatchStatus.READY, entrySecuredAt: { not: null } },
        data: { status: MatchStatus.PLAYING, startedAt: new Date() },
      });
    }

    if (state.game.phase === LudoMatchPhase.FINISHED || eventTypes.includes(LudoRuntimeEventType.MATCH_FINISHED)) {
      await this.prisma.match.updateMany({
        where: {
          id: state.game.matchId,
          status: { notIn: [MatchStatus.FINISHED, MatchStatus.CANCELLED, MatchStatus.ABORTED] },
        },
        data: {
          status: MatchStatus.FINISHING,
          winnerOrder: state.game.winnerOrder,
          resultVersion: state.game.version,
        },
      });

      // The game result is already authoritative in the persisted runtime.
      // Settlement is exactly-once and retryable; a temporary DB failure must
      // not replay or mutate the game command itself.
      try {
        await this.settlement.settleLudoMatch(state);
      } catch (error) {
        this.logger.error(`Settlement pending for ${state.game.matchId}: ${(error as Error).message}`);
      }
    }
  }
}
