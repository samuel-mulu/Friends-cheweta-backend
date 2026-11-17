import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppEnv } from '../../config/env';
import { DamaMatchRuntimeState, DamaRuntimeCommand, DamaRuntimeEvent } from '../../games/dama/runtime';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { MatchJoinTracker } from '../match-join-tracker';
import { RealtimePublisherService } from '../realtime-publisher.service';
import { TurnGameTimer } from '../turn-game/turn-game-timer';
import { DamaRuntimeService } from './dama-runtime.service';

/** Dama's per-move clock: auto-move + strikes, forfeit at the limit. */
@Injectable()
export class DamaTurnTimerService extends TurnGameTimer<DamaMatchRuntimeState, DamaRuntimeCommand, DamaRuntimeEvent> {
  constructor(
    runtime: DamaRuntimeService,
    redis: RedisService,
    prisma: PrismaService,
    publisher: RealtimePublisherService,
    joins: MatchJoinTracker,
    config: ConfigService<AppEnv, true>,
  ) {
    super(runtime, redis, prisma, publisher, joins, config.get('GAME_MAX_CONSECUTIVE_TIMEOUTS', { infer: true }));
  }
}
