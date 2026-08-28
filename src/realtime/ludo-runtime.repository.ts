import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppEnv } from '../config/env';
import { LudoMatchRuntimeState, LudoRuntimeEvent } from '../games/ludo/runtime';
import { RedisService } from '../redis/redis.service';

export type StoredCommandRecord = {
  fingerprint: string;
  resultingVersion: number;
  events: LudoRuntimeEvent[];
};

@Injectable()
export class LudoRuntimeRepository {
  private readonly runtimeTtlSeconds: number;
  private readonly commandTtlSeconds: number;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.runtimeTtlSeconds = config.get('REDIS_RUNTIME_TTL_SECONDS', { infer: true });
    this.commandTtlSeconds = config.get('REDIS_COMMAND_TTL_SECONDS', { infer: true });
  }

  snapshotKey(matchId: string): string {
    return this.redis.key('runtime', 'ludo', matchId, 'snapshot');
  }

  commandKey(matchId: string, commandId: string): string {
    return this.redis.key('runtime', 'ludo', matchId, 'command', commandId);
  }

  lockKey(matchId: string): string {
    return this.redis.key('lock', 'ludo-match', matchId);
  }

  getSnapshot(matchId: string): Promise<LudoMatchRuntimeState | null> {
    return this.redis.getJson<LudoMatchRuntimeState>(this.snapshotKey(matchId));
  }

  getCommand(matchId: string, commandId: string): Promise<StoredCommandRecord | null> {
    return this.redis.getJson<StoredCommandRecord>(this.commandKey(matchId, commandId));
  }

  async saveSnapshot(matchId: string, state: LudoMatchRuntimeState): Promise<void> {
    await this.redis.setJson(this.snapshotKey(matchId), state, this.runtimeTtlSeconds);
  }

  async saveSnapshotAndCommand(input: {
    matchId: string;
    commandId: string;
    fingerprint: string;
    state: LudoMatchRuntimeState;
    resultingVersion: number;
    events: LudoRuntimeEvent[];
  }): Promise<void> {
    const tx = this.redis.raw().multi();
    tx.set(this.snapshotKey(input.matchId), JSON.stringify(input.state), { EX: this.runtimeTtlSeconds });
    tx.set(
      this.commandKey(input.matchId, input.commandId),
      JSON.stringify({
        fingerprint: input.fingerprint,
        resultingVersion: input.resultingVersion,
        events: input.events,
      } satisfies StoredCommandRecord),
      { EX: this.commandTtlSeconds },
    );
    await tx.exec();
  }

  async refreshSnapshotTtl(matchId: string): Promise<void> {
    await this.redis.raw().expire(this.snapshotKey(matchId), this.runtimeTtlSeconds);
  }
}
