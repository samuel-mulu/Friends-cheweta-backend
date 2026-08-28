import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppEnv } from '../config/env';
import { RedisService } from '../redis/redis.service';

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
    const socketsKey = this.redis.key('presence', 'user', userId, 'sockets');
    const metaKey = this.redis.key('presence', 'user', userId, 'meta');
    const tx = this.redis.raw().multi();
    tx.sAdd(socketsKey, socketId);
    tx.expire(socketsKey, this.ttlSeconds);
    tx.set(
      metaKey,
      JSON.stringify({ status: 'ONLINE', lastSeenAt: new Date().toISOString() }),
      { EX: this.ttlSeconds },
    );
    await tx.exec();
  }

  async heartbeat(userId: string, socketId: string): Promise<void> {
    await this.connected(userId, socketId);
  }

  async disconnected(userId: string, socketId: string): Promise<boolean> {
    const socketsKey = this.redis.key('presence', 'user', userId, 'sockets');
    const metaKey = this.redis.key('presence', 'user', userId, 'meta');
    await this.redis.raw().sRem(socketsKey, socketId);
    const count = await this.redis.raw().sCard(socketsKey);
    if (count > 0) {
      await this.redis.raw().expire(socketsKey, this.ttlSeconds);
      return false;
    }

    await this.redis.raw().set(
      metaKey,
      JSON.stringify({ status: 'OFFLINE', lastSeenAt: new Date().toISOString() }),
      { EX: Math.max(this.ttlSeconds, 300) },
    );
    return true;
  }

  async isOnline(userId: string): Promise<boolean> {
    return (await this.redis.raw().sCard(this.redis.key('presence', 'user', userId, 'sockets'))) > 0;
  }
}
