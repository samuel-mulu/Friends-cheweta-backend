import { RedisService } from '../redis/redis.service';

/** What duplicate detection needs; events are not replayed from here. */
export type StoredCommandRecord = {
  fingerprint: string;
  resultingVersion: number;
};

/**
 * Redis storage of one game's live matches: the authoritative snapshot, the
 * per-command idempotency records and the per-match lock key. Keys are
 * namespaced by game (`runtime:<game>:<matchId>:…`).
 */
export class RuntimeStore<TState, TEvent> {
  constructor(
    protected readonly redis: RedisService,
    private readonly game: string,
    private readonly runtimeTtlSeconds: number,
    private readonly commandTtlSeconds: number,
  ) {}

  snapshotKey(matchId: string): string {
    return this.redis.key('runtime', this.game, matchId, 'snapshot');
  }

  commandKey(matchId: string, commandId: string): string {
    return this.redis.key('runtime', this.game, matchId, 'command', commandId);
  }

  lockKey(matchId: string): string {
    return this.redis.key('lock', `${this.game}-match`, matchId);
  }

  postCommitRetryKey(): string {
    return this.redis.key('runtime', this.game, 'post-commit-retry');
  }

  getSnapshot(matchId: string): Promise<TState | null> {
    return this.redis.getJson<TState>(this.snapshotKey(matchId));
  }

  getCommand(matchId: string, commandId: string): Promise<StoredCommandRecord | null> {
    return this.redis.getJson<StoredCommandRecord>(this.commandKey(matchId, commandId));
  }

  /** Store only if no snapshot exists; returns the snapshot that is now authoritative. */
  async saveSnapshotIfAbsent(matchId: string, state: TState): Promise<TState> {
    const created = await this.redis
      .raw()
      .set(this.snapshotKey(matchId), JSON.stringify(state), { NX: true, EX: this.runtimeTtlSeconds });
    if (created === 'OK') return state;
    return (await this.getSnapshot(matchId)) ?? state;
  }

  async deleteSnapshot(matchId: string): Promise<void> {
    await this.redis.raw().del(this.snapshotKey(matchId));
  }

  async saveSnapshotAndCommand(input: {
    matchId: string;
    commandId: string;
    fingerprint: string;
    state: TState;
    resultingVersion: number;
  }): Promise<void> {
    const record: StoredCommandRecord = { fingerprint: input.fingerprint, resultingVersion: input.resultingVersion };
    const tx = this.redis.raw().multi();
    tx.set(this.snapshotKey(input.matchId), JSON.stringify(input.state), { EX: this.runtimeTtlSeconds });
    tx.set(this.commandKey(input.matchId, input.commandId), JSON.stringify(record), { EX: this.commandTtlSeconds });
    await tx.exec();
  }

  async refreshSnapshotTtl(matchId: string): Promise<void> {
    await this.redis.raw().expire(this.snapshotKey(matchId), this.runtimeTtlSeconds);
  }
}
