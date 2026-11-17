import { Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { MatchJoinTracker } from '../match-join-tracker';
import { RealtimePublisherService } from '../realtime-publisher.service';
import { toErrorPayload } from '../ws-errors';
import { TurnGameCommand, TurnGameEvent, TurnGameState } from './turn-game.definition';
import { TurnGameExecution, TurnGameRuntime } from './turn-game-runtime';

export type TurnTiming = {
  matchId: string;
  version: number;
  playerId: string | null;
  /** Game-specific phase (Ludo: WAITING_FOR_ROLL…), null for games without one. */
  turnPhase: string | null;
  /** Null while waiting for everyone to open the match, or after it ends. */
  turnEndsAt: string | null;
  strikes: Record<string, number>;
  maxStrikes: number;
  /** @deprecated Same as [strikes]; kept for clients that predate the shared timer. */
  consecutiveTimeoutsByPlayer: Record<string, number>;
};

/** Server-played commands never queue behind a player: they retry on the next tick. */
const NO_WAIT = { lockWaitMs: 0 };

function isResourceBusy(error: unknown): boolean {
  return toErrorPayload(error).code === 'RESOURCE_BUSY';
}

/**
 * Per-turn clock for a turn game. On timeout the server plays the game's
 * automatic command for the absent player and adds a strike; at the strike
 * limit the player forfeits. Before play starts (Ludo's starting roll) a
 * timeout simply plays for everyone still pending, without strikes.
 */
export class TurnGameTimer<
  S extends TurnGameState,
  C extends TurnGameCommand,
  E extends TurnGameEvent,
> {
  private readonly logger: Logger;
  private readonly turnSecondsByMatch = new Map<string, number>();

  constructor(
    private readonly runtime: TurnGameRuntime<S, C, E>,
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly publisher: RealtimePublisherService,
    private readonly joins: MatchJoinTracker,
    private readonly maxStrikes: number,
  ) {
    this.logger = new Logger(`${runtime.definition.code}Timer`);
  }

  private get key(): string {
    return this.runtime.definition.key;
  }

  private timingKey(matchId: string): string {
    return this.redis.key('runtime', this.key, matchId, 'timing');
  }

  private queueKey(): string {
    return this.redis.key('runtime', this.key, 'turn-deadlines');
  }

  async onMatchJoined(matchId: string, userId: string, state: S): Promise<TurnTiming> {
    await this.joins.markJoined(matchId, userId);
    return this.getTiming(state);
  }

  async getTiming(state: S): Promise<TurnTiming> {
    const matchId = state.game.matchId;
    const existing = await this.redis.getJson<TurnTiming>(this.timingKey(matchId));
    if (existing && existing.version === state.game.version && existing.turnEndsAt) return existing;
    if (!(await this.allJoined(matchId, state))) {
      return this.save({ ...this.base(state, existing?.strikes ?? {}), turnEndsAt: null });
    }
    return this.schedule(state, existing?.strikes ?? {});
  }

  /** Every participant has opened the match at least once (turn clocks start only then). */
  async allJoined(matchId: string, state?: S | null): Promise<boolean> {
    const [joined, snapshot] = await Promise.all([
      this.joins.joinedCount(matchId),
      state ? Promise.resolve(state) : this.runtime.getStoredSnapshot(matchId),
    ]);
    const players =
      snapshot?.game.players.length ??
      (await this.prisma.matchParticipant.count({ where: { matchId } }));
    return players > 0 && joined >= players;
  }

  async assertAllJoined(matchId: string): Promise<void> {
    if (!(await this.allJoined(matchId))) throw new Error('WAITING_FOR_OPPONENT_JOIN');
  }

  /** After a player's own command: their strikes reset, the next clock starts. */
  async afterCommand(state: S, playerId: string): Promise<TurnTiming> {
    const previous = await this.redis.getJson<TurnTiming>(this.timingKey(state.game.matchId));
    if ((previous?.strikes[playerId] ?? 0) > 0) {
      this.publisher.publishRoom(
        this.publisher.matchRoom(state.game.matchId),
        `${this.key}:strikes`,
        { playerId, strikes: 0, maxStrikes: this.maxStrikes },
        state.game.matchId,
      );
    }
    return this.schedule(state, { ...(previous?.strikes ?? {}), [playerId]: 0 });
  }

  async processDue(): Promise<void> {
    const now = Date.now();
    const matchIds = await this.redis
      .raw()
      .zRangeByScore(this.queueKey(), 0, now, { LIMIT: { offset: 0, count: 25 } });
    for (const matchId of matchIds) {
      try {
        await this.processTimeout(matchId, now);
      } catch (error) {
        // A player's command holds the match right now: the deadline stays
        // queued and the next tick looks again.
        if (isResourceBusy(error)) continue;
        this.logger.warn(
          `${this.key}_timeout_failed match=${matchId} reason=${(error as Error).message}`,
        );
      }
    }
  }

  /** Disconnect grace expired: the absent player resigns. */
  async forfeitAbsent(matchId: string, userId: string): Promise<void> {
    const state = await this.runtime.getStoredSnapshot(matchId);
    const definition = this.runtime.definition;
    if (!state || definition.isFinished(state)) return;
    if (definition.canResign && !definition.canResign(state, userId)) return;
    const result = await this.runtime.execute(
      {
        ...definition.resignCommand(),
        matchId,
        commandId: `disconnect:${matchId}:${userId}:${state.game.version}`,
        playerId: userId,
        expectedVersion: state.game.version,
      } as unknown as C & { matchId: string },
      NO_WAIT,
    );
    this.publisher.publishTurnGame(result, definition);
    const timing = await this.redis.getJson<TurnTiming>(this.timingKey(matchId));
    await this.schedule(result.state, timing?.strikes ?? {});
  }

  /** A match cancelled before it started: drop its live state and clock. */
  async discard(matchId: string): Promise<void> {
    await this.runtime.discardRuntime(matchId);
    await this.redis
      .raw()
      .multi()
      .zRem(this.queueKey(), matchId)
      .del(this.timingKey(matchId))
      .exec();
    this.turnSecondsByMatch.delete(matchId);
  }

  private async processTimeout(matchId: string, now: number): Promise<void> {
    const timing = await this.redis.getJson<TurnTiming>(this.timingKey(matchId));
    if (!timing?.turnEndsAt || Date.parse(timing.turnEndsAt) > now) return;
    const state = await this.runtime.getStoredSnapshot(matchId);
    const definition = this.runtime.definition;
    if (!state || definition.isFinished(state)) {
      await this.redis.raw().zRem(this.queueKey(), matchId);
      return;
    }
    if (timing.version !== state.game.version) {
      await this.schedule(state, timing.strikes);
      return;
    }

    if (definition.isPreGame?.(state)) {
      await this.autoPlayPreGame(matchId, state);
      const latest = await this.runtime.getStoredSnapshot(matchId);
      if (latest) await this.schedule(latest, timing.strikes);
      return;
    }

    const playerId = state.game.currentPlayerId;
    if (!playerId) {
      await this.redis.raw().zRem(this.queueKey(), matchId);
      return;
    }
    const strikes = { ...timing.strikes, [playerId]: (timing.strikes[playerId] ?? 0) + 1 };
    const forfeit = strikes[playerId] >= this.maxStrikes;
    const body = forfeit ? definition.resignCommand() : definition.autoCommand(state, playerId);
    if (!body) {
      this.logger.warn(
        `${this.key}_timeout_without_auto_command match=${matchId} player=${playerId}`,
      );
      await this.redis.raw().zRem(this.queueKey(), matchId);
      return;
    }
    const result: TurnGameExecution<S, E> = await this.runtime.execute(
      {
        ...body,
        matchId,
        playerId,
        expectedVersion: state.game.version,
        commandId: `timeout:${forfeit ? 'forfeit' : 'auto'}:${matchId}:${state.game.version}`,
      } as unknown as C & { matchId: string },
      NO_WAIT,
    );
    this.publisher.publishTurnGame(result, definition);
    // Tell everyone the server played for an absent player, with the strike
    // count, so a forfeit at the limit is never a surprise.
    this.publisher.publishRoom(
      this.publisher.matchRoom(matchId),
      `${this.key}:auto_played`,
      { playerId, strikes: strikes[playerId], maxStrikes: this.maxStrikes, action: body.type },
      matchId,
    );
    await this.schedule(result.state, strikes);
  }

  /** Pre-game timeout (e.g. starting roll): play for every pending player, no strikes. */
  private async autoPlayPreGame(matchId: string, state: S): Promise<void> {
    const definition = this.runtime.definition;
    for (const playerId of this.actingPlayers(state)) {
      const current = await this.runtime.getStoredSnapshot(matchId);
      if (!current || !definition.isPreGame?.(current)) break;
      const body = definition.autoCommand(current, playerId);
      if (!body) continue;
      const result = await this.runtime.execute(
        {
          ...body,
          matchId,
          playerId,
          expectedVersion: current.game.version,
          commandId: `timeout:start:${matchId}:${playerId}:${current.game.version}`,
        } as unknown as C & { matchId: string },
        NO_WAIT,
      );
      this.publisher.publishTurnGame(result, definition);
    }
  }

  private actingPlayers(state: S): string[] {
    const custom = this.runtime.definition.actingPlayers?.(state);
    if (custom) return custom;
    return state.game.currentPlayerId ? [state.game.currentPlayerId] : [];
  }

  private async schedule(state: S, strikes: Record<string, number>): Promise<TurnTiming> {
    const matchId = state.game.matchId;
    if (this.runtime.definition.isFinished(state)) {
      await this.redis.raw().zRem(this.queueKey(), matchId);
      this.turnSecondsByMatch.delete(matchId);
      return this.save({ ...this.base(state, strikes), turnEndsAt: null });
    }
    const endsAtMs = Date.now() + (await this.turnSeconds(matchId)) * 1000;
    const timing: TurnTiming = {
      ...this.base(state, strikes),
      turnEndsAt: new Date(endsAtMs).toISOString(),
    };
    await this.redis
      .raw()
      .multi()
      .set(this.timingKey(matchId), JSON.stringify(timing), { EX: 86400 })
      .zAdd(this.queueKey(), [{ score: endsAtMs, value: matchId }])
      .exec();
    return timing;
  }

  private base(state: S, strikes: Record<string, number>): Omit<TurnTiming, 'turnEndsAt'> {
    return {
      matchId: state.game.matchId,
      version: state.game.version,
      playerId: state.game.currentPlayerId,
      turnPhase: this.runtime.definition.turnPhase?.(state) ?? null,
      strikes,
      maxStrikes: this.maxStrikes,
      consecutiveTimeoutsByPlayer: strikes,
    };
  }

  private async save(timing: TurnTiming): Promise<TurnTiming> {
    await this.redis.setJson(this.timingKey(timing.matchId), timing, 86400);
    return timing;
  }

  /** A match's turn time never changes: look it up once per match. */
  private async turnSeconds(matchId: string): Promise<number> {
    const cached = this.turnSecondsByMatch.get(matchId);
    if (cached !== undefined) return cached;
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: { gameMode: { select: { turnDurationSeconds: true } } },
    });
    const seconds =
      match?.gameMode.turnDurationSeconds ?? this.runtime.definition.defaultTurnSeconds;
    this.turnSecondsByMatch.set(matchId, seconds);
    return seconds;
  }
}
