import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppEnv } from '../../config/env';
import { PREMATCH_ORPHAN_STATUSES } from '../../common/match-status';
import { MatchStatus } from '../../generated/prisma/enums';
import { LudoMatchPhase, LudoTurnPhase } from '../../games/ludo/domain';
import { LudoRuntimeCommand, LudoMatchRuntimeState } from '../../games/ludo/runtime';
import { GameEntryService } from '../../game-entry/game-entry.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { LudoRuntimeService } from '../ludo-runtime.service';
import { PresenceService } from '../presence.service';
import { RealtimePublisherService } from '../realtime-publisher.service';
import { LudoTimingState } from './turn-timeout.types';

@Injectable()
export class TurnTimeoutService {
  private readonly logger = new Logger(TurnTimeoutService.name);
  private readonly maxConsecutiveTimeouts: number;
  private readonly disconnectGraceSeconds: number;
  private readonly readyNoShowSeconds: number;
  private readonly prematchOrphanTimeoutSeconds: number;

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly runtime: LudoRuntimeService,
    private readonly presence: PresenceService,
    private readonly publisher: RealtimePublisherService,
    private readonly gameEntry: GameEntryService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.maxConsecutiveTimeouts = config.get('LUDO_MAX_CONSECUTIVE_TIMEOUTS', { infer: true });
    this.disconnectGraceSeconds = config.get('LUDO_DISCONNECT_GRACE_SECONDS', { infer: true });
    this.readyNoShowSeconds = config.get('LUDO_READY_NO_SHOW_SECONDS', { infer: true });
    this.prematchOrphanTimeoutSeconds = config.get('PREMATCH_ORPHAN_TIMEOUT_SECONDS', { infer: true });
  }

  async onMatchJoined(matchId: string, userId: string, state: LudoMatchRuntimeState): Promise<LudoTimingState> {
    await this.markJoined(matchId, userId);
    return this.getTiming(matchId, state);
  }

  /** Records a participant as present (bots are marked at practice start). */
  async markJoined(matchId: string, userId: string): Promise<void> {
    const joinedKey = this.joinedPlayersKey(matchId);
    await this.redis.raw().multi().sAdd(joinedKey, userId).expire(joinedKey, 86400).exec();
  }

  async getTiming(matchId: string, state: LudoMatchRuntimeState): Promise<LudoTimingState> {
    const existing = await this.redis.getJson<LudoTimingState>(this.timingKey(matchId));
    if (existing && existing.version === state.game.version && existing.turnPhase === state.game.turnPhase && existing.turnEndsAt) {
      return existing;
    }
    if (!(await this.allParticipantsJoined(matchId))) {
      const waiting: LudoTimingState = {
        matchId,
        version: state.game.version,
        playerId: state.game.currentPlayerId,
        turnPhase: state.game.turnPhase,
        turnEndsAt: null,
        consecutiveTimeoutsByPlayer: existing?.consecutiveTimeoutsByPlayer ?? {},
      };
      await this.redis.setJson(this.timingKey(matchId), waiting, 86400);
      return waiting;
    }
    return this.scheduleForState(state, existing?.consecutiveTimeoutsByPlayer ?? {});
  }

  async assertAllParticipantsJoined(matchId: string): Promise<void> {
    if (!(await this.allParticipantsJoined(matchId))) throw new Error('WAITING_FOR_OPPONENT_JOIN');
  }

  async afterManualExecution(state: LudoMatchRuntimeState, playerId: string): Promise<LudoTimingState> {
    const previous = await this.redis.getJson<LudoTimingState>(this.timingKey(state.game.matchId));
    const counts = { ...(previous?.consecutiveTimeoutsByPlayer ?? {}), [playerId]: 0 };
    if ((previous?.consecutiveTimeoutsByPlayer?.[playerId] ?? 0) > 0) {
      // The player is back: clear their away strikes on every client.
      this.publisher.publishRoom(
        this.publisher.matchRoom(state.game.matchId),
        'ludo:strikes',
        { playerId, strikes: 0, maxStrikes: this.maxConsecutiveTimeouts },
        state.game.matchId,
      );
    }
    return this.scheduleForState(state, counts);
  }

  async onConnected(userId: string): Promise<void> {
    const tx = this.redis.raw().multi();
    tx.zRem(this.disconnectQueueKey(), userId);
    tx.del(this.disconnectKey(userId));
    await tx.exec();
  }

  async onDisconnected(userId: string): Promise<void> {
    if (await this.presence.isOnline(userId)) return;
    const endsAtMs = Date.now() + this.disconnectGraceSeconds * 1000;
    const tx = this.redis.raw().multi();
    tx.set(this.disconnectKey(userId), String(endsAtMs), { EX: this.disconnectGraceSeconds + 120 });
    tx.zAdd(this.disconnectQueueKey(), [{ score: endsAtMs, value: userId }]);
    await tx.exec();
  }

  async processDueTurnTimeouts(): Promise<void> {
    const now = Date.now();
    const matchIds = await this.redis.raw().zRangeByScore(this.turnQueueKey(), 0, now, { LIMIT: { offset: 0, count: 25 } });
    for (const matchId of matchIds) {
      try {
        await this.processTurnTimeout(matchId, now);
      } catch (error) {
        this.logger.warn(`Turn timeout processing failed for ${matchId}: ${(error as Error).message}`);
      }
    }
  }

  async processDueDisconnects(): Promise<void> {
    const now = Date.now();
    const userIds = await this.redis.raw().zRangeByScore(this.disconnectQueueKey(), 0, now, { LIMIT: { offset: 0, count: 25 } });
    for (const userId of userIds) {
      try {
        if (await this.presence.isOnline(userId)) {
          await this.clearDisconnect(userId);
          continue;
        }
        const rawDeadline = await this.redis.raw().get(this.disconnectKey(userId));
        if (!rawDeadline || Number(rawDeadline) > now) continue;

        const participant = await this.prisma.matchParticipant.findFirst({
          where: { userId, match: { status: { in: [MatchStatus.READY, MatchStatus.PLAYING] } } },
          include: { match: true },
          orderBy: { joinedAt: 'desc' },
        });
        if (!participant) {
          await this.clearDisconnect(userId);
          continue;
        }

        if (participant.match.status === MatchStatus.READY) {
          await this.cancelBeforeStart(participant.matchId, 'PLAYER_DISCONNECTED_BEFORE_START', 'DISCONNECT_GRACE_EXPIRED');
        } else {
          const state = await this.runtime.getStoredSnapshot(participant.matchId);
          if (state?.game.phase === LudoMatchPhase.PLAYING && !state.resignedPlayerIds.includes(userId)) {
            const result = await this.runtime.execute({
              matchId: participant.matchId,
              type: 'RESIGN',
              commandId: `disconnect:${participant.matchId}:${userId}:${state.game.version}`,
              playerId: userId,
              expectedVersion: state.game.version,
            });
            this.publisher.publishExecution(result);
            await this.scheduleForState(result.state, (await this.currentCounts(participant.matchId)));
          }
        }
        await this.clearDisconnect(userId);
      } catch (error) {
        this.logger.warn(`Disconnect grace processing failed for ${userId}: ${(error as Error).message}`);
      }
    }
  }

  async processReadyNoShows(): Promise<void> {
    const cutoff = new Date(Date.now() - this.readyNoShowSeconds * 1000);
    const matches = await this.prisma.match.findMany({
      where: { status: MatchStatus.READY, entrySecuredAt: { not: null, lt: cutoff } },
      select: { id: true },
      take: 25,
      orderBy: { entrySecuredAt: 'asc' },
    });
    for (const match of matches) {
      try {
        // Do not start paid gameplay until every participant has joined the
        // realtime match room at least once. A partial join times out to a
        // refund instead of letting an absent player lose by automatic play.
        if (await this.allParticipantsJoined(match.id)) continue;
        await this.cancelBeforeStart(match.id, 'MATCH_READY_NO_SHOW', 'READY_NO_SHOW_TIMEOUT');
      } catch (error) {
        this.logger.warn(`Ready no-show cleanup failed for ${match.id}: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Cancel abandoned CREATED/WAITING commitments that never started or secured.
   * Aligns with Quick Match Redis TTL so live open slots are not raced.
   */
  async processPrematchOrphans(): Promise<number> {
    const cutoff = new Date(Date.now() - this.prematchOrphanTimeoutSeconds * 1000);
    const candidates = await this.prisma.match.findMany({
      where: {
        status: { in: PREMATCH_ORPHAN_STATUSES },
        createdAt: { lt: cutoff },
        startedAt: null,
        entrySecuredAt: null,
      },
      select: { id: true },
      take: 25,
      orderBy: { createdAt: 'asc' },
    });

    let cancelled = 0;
    for (const candidate of candidates) {
      try {
        const done = await this.cancelBeforeStart(candidate.id, 'PREMATCH_ORPHAN_TIMEOUT', 'PREMATCH_ORPHAN_TIMEOUT', {
          expectedStatuses: PREMATCH_ORPHAN_STATUSES,
        });
        if (!done) continue;
        cancelled += 1;
        this.logger.log(`prematch_orphan_cancelled match=${candidate.id}`);
      } catch (error) {
        this.logger.warn(`Prematch orphan cleanup failed for ${candidate.id}: ${(error as Error).message}`);
      }
    }
    return cancelled;
  }

  /**
   * Refund a match that never started, discard its live runtime so no further
   * commands or timers act on it, and tell the players.
   */
  private async cancelBeforeStart(
    matchId: string,
    reason: string,
    clientReason: string,
    options?: { expectedStatuses?: MatchStatus[] },
  ): Promise<boolean> {
    const result = await this.gameEntry.cancelAndRefund(matchId, reason, options);
    if (('skipped' in result && result.skipped) || !result.refunded) return false;

    await this.runtime.discardRuntime(matchId);
    const players = await this.prisma.matchParticipant.findMany({ where: { matchId }, select: { userId: true } });
    const cleanup = this.redis.raw().multi().zRem(this.turnQueueKey(), matchId).del(this.timingKey(matchId));
    await cleanup.exec();
    for (const player of players) {
      this.publisher.publishUser(player.userId, 'match:cancelled', { matchId, reason: clientReason }, matchId);
    }
    return true;
  }

  private async processTurnTimeout(matchId: string, now: number): Promise<void> {
    const timing = await this.redis.getJson<LudoTimingState>(this.timingKey(matchId));
    if (!timing?.turnEndsAt || Date.parse(timing.turnEndsAt) > now) return;

    const state = await this.runtime.getStoredSnapshot(matchId);
    if (!state || state.game.phase === LudoMatchPhase.FINISHED) {
      await this.clearTurn(matchId);
      return;
    }
    if (timing.version !== state.game.version || timing.turnPhase !== state.game.turnPhase) {
      await this.scheduleForState(state, timing.consecutiveTimeoutsByPlayer);
      return;
    }

    if (state.game.phase === LudoMatchPhase.PRE_GAME) {
      const pending = state.startingRoll.candidatePlayerIds.filter((id) => state.startingRoll.rolls[id] === undefined);
      for (const playerId of pending) {
        const current = await this.runtime.getStoredSnapshot(matchId);
        if (!current || current.game.phase !== LudoMatchPhase.PRE_GAME) break;
        const command: LudoRuntimeCommand & { matchId: string } = {
          matchId,
          type: 'ROLL_FOR_START',
          commandId: `timeout:start:${matchId}:${current.startingRoll.round}:${playerId}:${current.game.version}`,
          playerId,
          expectedVersion: current.game.version,
        };
        const result = await this.runtime.execute(command);
        this.publisher.publishExecution(result);
      }
      const latest = await this.runtime.getStoredSnapshot(matchId);
      if (latest) await this.scheduleForState(latest, timing.consecutiveTimeoutsByPlayer);
      return;
    }

    const playerId = state.game.currentPlayerId;
    if (!playerId) {
      await this.clearTurn(matchId);
      return;
    }
    const counts = { ...timing.consecutiveTimeoutsByPlayer };
    counts[playerId] = (counts[playerId] ?? 0) + 1;

    let command: LudoRuntimeCommand & { matchId: string };
    if (counts[playerId] >= this.maxConsecutiveTimeouts) {
      command = {
        matchId,
        type: 'RESIGN',
        commandId: `timeout:forfeit:${matchId}:${playerId}:${state.game.version}`,
        playerId,
        expectedVersion: state.game.version,
      };
    } else if (state.game.turnPhase === LudoTurnPhase.WAITING_FOR_ROLL) {
      command = {
        matchId,
        type: 'ROLL_DICE',
        commandId: `timeout:roll:${matchId}:${playerId}:${state.game.version}`,
        playerId,
        expectedVersion: state.game.version,
      };
    } else if (state.game.turnPhase === LudoTurnPhase.WAITING_FOR_MOVE) {
      const tokenId = [...state.game.legalTokenIds].sort()[0];
      if (!tokenId) throw new Error('TIMEOUT_WITHOUT_LEGAL_MOVE');
      command = {
        matchId,
        type: 'MOVE_TOKEN',
        commandId: `timeout:move:${matchId}:${playerId}:${state.game.version}`,
        playerId,
        expectedVersion: state.game.version,
        tokenId,
      };
    } else {
      await this.clearTurn(matchId);
      return;
    }

    const result = await this.runtime.execute(command);
    this.publisher.publishExecution(result);
    // Tell everyone the server played for an absent player, with strike count,
    // so the forfeit after max strikes is never a surprise.
    this.publisher.publishRoom(
      this.publisher.matchRoom(matchId),
      'ludo:auto_played',
      { playerId, strikes: counts[playerId], maxStrikes: this.maxConsecutiveTimeouts, action: command.type },
      matchId,
    );
    await this.scheduleForState(result.state, counts);
  }

  private async scheduleForState(state: LudoMatchRuntimeState, counts: Record<string, number>): Promise<LudoTimingState> {
    const matchId = state.game.matchId;
    if (state.game.phase === LudoMatchPhase.FINISHED || state.game.turnPhase === LudoTurnPhase.COMPLETE) {
      const timing: LudoTimingState = {
        matchId,
        version: state.game.version,
        playerId: null,
        turnPhase: state.game.turnPhase,
        turnEndsAt: null,
        consecutiveTimeoutsByPlayer: counts,
      };
      await this.redis.setJson(this.timingKey(matchId), timing, 86400);
      await this.redis.raw().zRem(this.turnQueueKey(), matchId);
      return timing;
    }

    const durationSeconds = await this.turnDurationSeconds(matchId);
    const endsAtMs = Date.now() + durationSeconds * 1000;
    const timing: LudoTimingState = {
      matchId,
      version: state.game.version,
      playerId: state.game.currentPlayerId,
      turnPhase: state.game.turnPhase,
      turnEndsAt: new Date(endsAtMs).toISOString(),
      consecutiveTimeoutsByPlayer: counts,
    };
    const tx = this.redis.raw().multi();
    tx.set(this.timingKey(matchId), JSON.stringify(timing), { EX: 86400 });
    tx.zAdd(this.turnQueueKey(), [{ score: endsAtMs, value: matchId }]);
    await tx.exec();
    return timing;
  }

  private async turnDurationSeconds(matchId: string): Promise<number> {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: { gameMode: { select: { turnDurationSeconds: true } } },
    });
    return match?.gameMode.turnDurationSeconds ?? 30;
  }

  private async currentCounts(matchId: string): Promise<Record<string, number>> {
    return (await this.redis.getJson<LudoTimingState>(this.timingKey(matchId)))?.consecutiveTimeoutsByPlayer ?? {};
  }

  private async clearTurn(matchId: string): Promise<void> {
    await this.redis.raw().zRem(this.turnQueueKey(), matchId);
  }

  private async clearDisconnect(userId: string): Promise<void> {
    const tx = this.redis.raw().multi();
    tx.zRem(this.disconnectQueueKey(), userId);
    tx.del(this.disconnectKey(userId));
    await tx.exec();
  }

  private async allParticipantsJoined(matchId: string): Promise<boolean> {
    const [joined, participants] = await Promise.all([
      this.redis.raw().sCard(this.joinedPlayersKey(matchId)),
      this.prisma.matchParticipant.count({ where: { matchId } }),
    ]);
    return participants > 0 && joined >= participants;
  }

  private joinedPlayersKey(matchId: string): string {
    return this.redis.key('runtime', 'ludo', matchId, 'joined-players');
  }

  private timingKey(matchId: string): string { return this.redis.key('runtime', 'ludo', matchId, 'timing'); }
  private turnQueueKey(): string { return this.redis.key('runtime', 'ludo', 'turn-deadlines'); }
  private disconnectQueueKey(): string { return this.redis.key('runtime', 'ludo', 'disconnect-deadlines'); }
  private disconnectKey(userId: string): string { return this.redis.key('runtime', 'ludo', 'disconnect', userId); }
}
