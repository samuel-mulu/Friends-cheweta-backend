import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppEnv } from '../../config/env';
import { GameEntryService } from '../../game-entry/game-entry.service';
import { LudoMatchRuntimeState, LudoRuntimeCommand, LudoRuntimeEvent } from '../../games/ludo/runtime';
import { MatchHistoryService } from '../../match-history/match-history.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { SettlementService } from '../../settlement/settlement.service';
import { MatchJoinTracker } from '../match-join-tracker';
import { RealtimePublisherService } from '../realtime-publisher.service';
import { RuntimeStore } from '../runtime-store';
import { TurnGameExecution, TurnGameRuntime } from '../turn-game/turn-game-runtime';
import { TurnGameTimer } from '../turn-game/turn-game-timer';
import { LUDO_GAME } from './ludo.definition';

export type LudoExecution = TurnGameExecution<LudoMatchRuntimeState, LudoRuntimeEvent>;

/** Live Ludo matches in Redis (keys `runtime:ludo:*`, lock `lock:ludo-match:*`). */
@Injectable()
export class LudoRuntimeRepository extends RuntimeStore<LudoMatchRuntimeState, LudoRuntimeEvent> {
  constructor(redis: RedisService, config: ConfigService<AppEnv, true>) {
    super(
      redis,
      'ludo',
      config.get('REDIS_RUNTIME_TTL_SECONDS', { infer: true }),
      config.get('REDIS_COMMAND_TTL_SECONDS', { infer: true }),
    );
  }
}

/** Authoritative Ludo matches (shared turn-game runtime). */
@Injectable()
export class LudoRuntimeService extends TurnGameRuntime<LudoMatchRuntimeState, LudoRuntimeCommand, LudoRuntimeEvent> {
  constructor(
    prisma: PrismaService,
    redis: RedisService,
    store: LudoRuntimeRepository,
    gameEntry: GameEntryService,
    settlement: SettlementService,
    history: MatchHistoryService,
  ) {
    super(LUDO_GAME, prisma, redis, store, gameEntry, settlement, history);
  }
}

/** Ludo's per-turn clock: auto-roll / auto-move + strikes, forfeit at the limit. */
@Injectable()
export class LudoTurnTimerService extends TurnGameTimer<LudoMatchRuntimeState, LudoRuntimeCommand, LudoRuntimeEvent> {
  constructor(
    runtime: LudoRuntimeService,
    redis: RedisService,
    prisma: PrismaService,
    publisher: RealtimePublisherService,
    joins: MatchJoinTracker,
    config: ConfigService<AppEnv, true>,
  ) {
    super(runtime, redis, prisma, publisher, joins, config.get('GAME_MAX_CONSECUTIVE_TIMEOUTS', { infer: true }));
  }
}
