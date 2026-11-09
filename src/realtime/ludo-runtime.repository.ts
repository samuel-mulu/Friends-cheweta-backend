import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppEnv } from '../config/env';
import { LudoMatchRuntimeState, LudoRuntimeEvent } from '../games/ludo/runtime';
import { RedisService } from '../redis/redis.service';
import { RuntimeStore, StoredCommandRecord as GenericCommandRecord } from './runtime-store';

export type StoredCommandRecord = GenericCommandRecord<LudoRuntimeEvent>;

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
