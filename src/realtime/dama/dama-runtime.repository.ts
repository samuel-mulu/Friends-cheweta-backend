import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppEnv } from '../../config/env';
import { DamaMatchRuntimeState, DamaRuntimeEvent } from '../../games/dama/runtime';
import { RedisService } from '../../redis/redis.service';
import { RuntimeStore } from '../runtime-store';

/** Live Dama matches in Redis (keys `runtime:dama:*`, lock `lock:dama-match:*`). */
@Injectable()
export class DamaRuntimeRepository extends RuntimeStore<DamaMatchRuntimeState, DamaRuntimeEvent> {
  constructor(redis: RedisService, config: ConfigService<AppEnv, true>) {
    super(
      redis,
      'dama',
      config.get('REDIS_RUNTIME_TTL_SECONDS', { infer: true }),
      config.get('REDIS_COMMAND_TTL_SECONDS', { infer: true }),
    );
  }

  timingKey(matchId: string): string {
    return this.redis.key('runtime', 'dama', matchId, 'timing');
  }

  turnQueueKey(): string {
    return this.redis.key('runtime', 'dama', 'turn-deadlines');
  }
}
