import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppEnv } from '../config/env';
import { RedisService } from '../redis/redis.service';

/**
 * Presence is a sorted set of socketId -> last heartbeat (ms). Only sockets
 * seen within the TTL count, so ids orphaned by a server restart (which never
 * get a disconnect event) age out instead of keeping a user "online" forever.
 */
@Injectable()
export class PresenceService {
  private readonly ttlSeconds: number;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.ttlSeconds = config.get('REDIS_PRESENCE_TTL_SECONDS', { infer: true });
  }

  async connected(userId: string, socketId: string): Promise<void> {
    const now = Date.now();
    await this.redis
      .raw()
      .multi()
      .zAdd(this.socketsKey(userId), [{ score: now, value: socketId }])
      .zRemRangeByScore(this.socketsKey(userId), '-inf', this.staleBefore(now))
      .expire(this.socketsKey(userId), this.ttlSeconds)
      .set(
        this.metaKey(userId),
        JSON.stringify({ status: 'ONLINE', lastSeenAt: new Date(now).toISOString() }),
        { EX: this.ttlSeconds },
      )
      .exec();
  }

  async heartbeat(userId: string, socketId: string): Promise<void> {
    await this.connected(userId, socketId);
  }

  /** Returns true when this was the user's last live socket. */
  async disconnected(userId: string, socketId: string): Promise<boolean> {
    const now = Date.now();
    const [, , remaining] = await this.redis
      .raw()
      .multi()
      .zRem(this.socketsKey(userId), socketId)
      .zRemRangeByScore(this.socketsKey(userId), '-inf', this.staleBefore(now))
      .zCard(this.socketsKey(userId))
      .exec();
    if (Number(remaining) > 0) return false;

    await this.redis
      .raw()
      .set(
        this.metaKey(userId),
        JSON.stringify({ status: 'OFFLINE', lastSeenAt: new Date(now).toISOString() }),
        {
          EX: Math.max(this.ttlSeconds, 300),
        },
      );
    return true;
  }

  async isOnline(userId: string): Promise<boolean> {
    const live = await this.redis
      .raw()
      .zCount(this.socketsKey(userId), this.staleBefore(Date.now()) + 1, '+inf');
    return live > 0;
  }

  private staleBefore(now: number): number {
    return now - this.ttlSeconds * 1000;
  }

  private socketsKey(userId: string): string {
    return this.redis.key('presence', 'user', userId, 'socket-seen');
  }

  private metaKey(userId: string): string {
    return this.redis.key('presence', 'user', userId, 'meta');
  }
}
