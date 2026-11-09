import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppEnv } from '../../config/env';
import { DamaPhase } from '../../games/dama/domain';
import { DamaMatchRuntimeState, colorOfPlayer, currentLegalMoves } from '../../games/dama/runtime';
import { MinimaxDamaBot } from '../../games/dama/simulation';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { MatchJoinTracker } from '../match-join-tracker';
import { RealtimePublisherService } from '../realtime-publisher.service';
import { DamaRuntimeRepository } from './dama-runtime.repository';
import { DamaExecution, DamaRuntimeService } from './dama-runtime.service';

export type DamaTiming = {
  matchId: string;
  version: number;
  playerId: string | null;
  /** Null while waiting for both players to open the match, or after it ends. */
  turnEndsAt: string | null;
  strikes: Record<string, number>;
  maxStrikes: number;
};

/**
 * Per-move clock. On timeout the server plays a sensible legal move for the
 * absent player and adds a strike; at the strike limit the player forfeits.
 * Same model as Ludo, so players meet one consistent rule across games.
 */
@Injectable()
export class DamaTurnTimerService {
  private readonly logger = new Logger(DamaTurnTimerService.name);
  private readonly maxStrikes: number;
  private readonly joins: MatchJoinTracker;
  private readonly turnSecondsByMatch = new Map<string, number>();

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly store: DamaRuntimeRepository,
    private readonly runtime: DamaRuntimeService,
    private readonly publisher: RealtimePublisherService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.maxStrikes = config.get('LUDO_MAX_CONSECUTIVE_TIMEOUTS', { infer: true });
    this.joins = new MatchJoinTracker(redis);
  }

  async onMatchJoined(matchId: string, userId: string, state: DamaMatchRuntimeState): Promise<DamaTiming> {
    await this.joins.markJoined(matchId, userId);
    return this.getTiming(state);
  }

  async getTiming(state: DamaMatchRuntimeState): Promise<DamaTiming> {
    const matchId = state.game.matchId;
    const existing = await this.redis.getJson<DamaTiming>(this.store.timingKey(matchId));
    if (existing && existing.version === state.game.version && existing.turnEndsAt) return existing;
    if ((await this.joins.joinedCount(matchId)) < state.game.players.length) {
      return this.save({ ...this.base(state, existing?.strikes ?? {}), turnEndsAt: null });
    }
    return this.schedule(state, existing?.strikes ?? {});
  }

  /** After a move by a person (or a bot): their strikes reset, the next clock starts. */
  async afterMove(state: DamaMatchRuntimeState, playerId: string): Promise<DamaTiming> {
    const previous = await this.redis.getJson<DamaTiming>(this.store.timingKey(state.game.matchId));
    if ((previous?.strikes[playerId] ?? 0) > 0) {
      this.publisher.publishRoom(
        this.publisher.matchRoom(state.game.matchId),
        'dama:strikes',
        { playerId, strikes: 0, maxStrikes: this.maxStrikes },
        state.game.matchId,
      );
    }
    return this.schedule(state, { ...(previous?.strikes ?? {}), [playerId]: 0 });
  }

  async processDue(): Promise<void> {
    const now = Date.now();
    const matchIds = await this.redis.raw().zRangeByScore(this.store.turnQueueKey(), 0, now, { LIMIT: { offset: 0, count: 25 } });
    for (const matchId of matchIds) {
      try {
        await this.processTimeout(matchId, now);
      } catch (error) {
        this.logger.warn(`dama_timeout_failed match=${matchId} reason=${(error as Error).message}`);
      }
    }
  }

  /** Disconnect grace expired: the absent player resigns. */
  async forfeitAbsent(matchId: string, userId: string): Promise<void> {
    const state = await this.runtime.getStoredSnapshot(matchId);
    if (state?.game.phase !== DamaPhase.PLAYING) return;
    const result = await this.runtime.execute({
      matchId,
      type: 'RESIGN',
      commandId: `disconnect:${matchId}:${userId}:${state.game.version}`,
      playerId: userId,
      expectedVersion: state.game.version,
    });
    this.publisher.publishDamaExecution(result);
    const timing = await this.redis.getJson<DamaTiming>(this.store.timingKey(matchId));
    await this.schedule(result.state, timing?.strikes ?? {});
  }

  /** A match cancelled before it started: drop its live state and clock. */
  async discard(matchId: string): Promise<void> {
    await this.runtime.discardRuntime(matchId);
    await this.redis.raw().multi().zRem(this.store.turnQueueKey(), matchId).del(this.store.timingKey(matchId)).exec();
    this.turnSecondsByMatch.delete(matchId);
  }

  private async processTimeout(matchId: string, now: number): Promise<void> {
    const timing = await this.redis.getJson<DamaTiming>(this.store.timingKey(matchId));
    if (!timing?.turnEndsAt || Date.parse(timing.turnEndsAt) > now) return;
    const state = await this.runtime.getStoredSnapshot(matchId);
    if (!state || state.game.phase !== DamaPhase.PLAYING || !state.game.currentPlayerId) {
      await this.redis.raw().zRem(this.store.turnQueueKey(), matchId);
      return;
    }
    if (timing.version !== state.game.version) {
      await this.schedule(state, timing.strikes);
      return;
    }

    const playerId = state.game.currentPlayerId;
    const strikes = { ...timing.strikes, [playerId]: (timing.strikes[playerId] ?? 0) + 1 };
    const base = { matchId, playerId, expectedVersion: state.game.version };
    let result: DamaExecution;
    if (strikes[playerId] >= this.maxStrikes) {
      result = await this.runtime.execute({ ...base, type: 'RESIGN', commandId: `timeout:forfeit:${matchId}:${state.game.version}` });
    } else {
      const move = new MinimaxDamaBot(1, state.game.version + 1).choose(state.game, colorOfPlayer(state.game, playerId), currentLegalMoves(state));
      result = await this.runtime.execute({ ...base, type: 'MOVE', path: move.path, commandId: `timeout:move:${matchId}:${state.game.version}` });
    }
    this.publisher.publishDamaExecution(result);
    this.publisher.publishRoom(
      this.publisher.matchRoom(matchId),
      'dama:auto_played',
      { playerId, strikes: strikes[playerId], maxStrikes: this.maxStrikes },
      matchId,
    );
    await this.schedule(result.state, strikes);
  }

  private async schedule(state: DamaMatchRuntimeState, strikes: Record<string, number>): Promise<DamaTiming> {
    const matchId = state.game.matchId;
    if (state.game.phase !== DamaPhase.PLAYING) {
      await this.redis.raw().zRem(this.store.turnQueueKey(), matchId);
      this.turnSecondsByMatch.delete(matchId);
      return this.save({ ...this.base(state, strikes), turnEndsAt: null });
    }
    const endsAtMs = Date.now() + (await this.turnSeconds(matchId)) * 1000;
    const timing: DamaTiming = { ...this.base(state, strikes), turnEndsAt: new Date(endsAtMs).toISOString() };
    await this.redis
      .raw()
      .multi()
      .set(this.store.timingKey(matchId), JSON.stringify(timing), { EX: 86400 })
      .zAdd(this.store.turnQueueKey(), [{ score: endsAtMs, value: matchId }])
      .exec();
    return timing;
  }

  private base(state: DamaMatchRuntimeState, strikes: Record<string, number>): Omit<DamaTiming, 'turnEndsAt'> {
    return {
      matchId: state.game.matchId,
      version: state.game.version,
      playerId: state.game.currentPlayerId,
      strikes,
      maxStrikes: this.maxStrikes,
    };
  }

  private async save(timing: DamaTiming): Promise<DamaTiming> {
    await this.redis.setJson(this.store.timingKey(timing.matchId), timing, 86400);
    return timing;
  }

  /** A match's move time never changes: look it up once per match. */
  private async turnSeconds(matchId: string): Promise<number> {
    const cached = this.turnSecondsByMatch.get(matchId);
    if (cached !== undefined) return cached;
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: { gameMode: { select: { turnDurationSeconds: true } } },
    });
    const seconds = match?.gameMode.turnDurationSeconds ?? 40;
    this.turnSecondsByMatch.set(matchId, seconds);
    return seconds;
  }
}
