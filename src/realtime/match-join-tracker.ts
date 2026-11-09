import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

/**
 * Which participants have opened a match at least once (any game). Turn
 * clocks start only when everyone has joined; a no-show is refunded instead.
 */
@Injectable()
export class MatchJoinTracker {
  constructor(private readonly redis: RedisService) {}

  async markJoined(matchId: string, userId: string): Promise<void> {
    const key = this.key(matchId);
    await this.redis.raw().multi().sAdd(key, userId).expire(key, 86400).exec();
  }

  joinedCount(matchId: string): Promise<number> {
    return this.redis.raw().sCard(this.key(matchId));
  }

  /** Historic key name (shared by every game; the match id is unique). */
  private key(matchId: string): string {
    return this.redis.key('runtime', 'ludo', matchId, 'joined-players');
  }
}
