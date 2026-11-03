import { randomUUID } from 'node:crypto';
import { RedisService } from '../redis/redis.service';

/**
 * Real-Redis harness for tests that exercise Lua scripts. Each harness uses a
 * unique key prefix and deletes its keys on cleanup, so it is safe against a
 * shared local Redis. Set REDIS_TEST_URL to point elsewhere.
 */
export async function createTestRedis(): Promise<{
  redis: RedisService;
  cleanup: () => Promise<void>;
}> {
  const prefix = `test-${randomUUID()}`;
  const values: Record<string, unknown> = {
    REDIS_KEY_PREFIX: prefix,
    REDIS_LOCK_TTL_MS: 5000,
    NODE_ENV: 'test',
    REDIS_URL: process.env.REDIS_TEST_URL ?? 'redis://127.0.0.1:6379',
  };
  const config = { get: (key: string) => values[key] };
  const redis = new RedisService(config as never);
  await redis.connect();

  const cleanup = async () => {
    for await (const keys of redis.raw().scanIterator({ MATCH: `${prefix}:*`, COUNT: 200 })) {
      const batch = Array.isArray(keys) ? keys : [keys];
      if (batch.length > 0) await redis.raw().del(batch);
    }
    await redis.onApplicationShutdown();
  };
  return { redis, cleanup };
}
