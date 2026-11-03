import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import {
  assertProductionRedisUrl,
  buildRedisClientOptions,
  redisHostForLogs,
} from '../config/redis-client.util';
import { AppEnv } from '../config/env';

type RedisClient = ReturnType<typeof createClient>;

@Injectable()
export class RedisService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: RedisClient;
  private readonly prefix: string;
  private readonly lockTtlMs: number;

  constructor(private readonly config: ConfigService<AppEnv, true>) {
    this.prefix = config.get('REDIS_KEY_PREFIX', { infer: true });
    this.lockTtlMs = config.get('REDIS_LOCK_TTL_MS', { infer: true });

    const nodeEnv = config.get('NODE_ENV', { infer: true });
    const redisUrl = config.get('REDIS_URL', { infer: true });
    assertProductionRedisUrl(redisUrl, nodeEnv);
    this.logger.log(`Connecting to Redis host ${redisHostForLogs(redisUrl)} (${nodeEnv})`);

    this.client = createClient(buildRedisClientOptions(redisUrl));
    this.client.on('error', (error) => this.logger.error(`Redis error: ${error.message}`));
  }

  async onModuleInit(): Promise<void> {
    await this.connect();
  }

  async connect(): Promise<void> {
    if (!this.client.isOpen) await this.client.connect();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.client.isOpen) await this.client.quit();
  }

  raw(): RedisClient {
    return this.client;
  }

  key(...parts: Array<string | number>): string {
    return [this.prefix, ...parts.map(String)].join(':');
  }

  async createConnectedDuplicate(): Promise<RedisClient> {
    const duplicate = this.client.duplicate();
    duplicate.on('error', (error) => this.logger.error(`Redis duplicate error: ${error.message}`));
    await duplicate.connect();
    return duplicate;
  }

  async getJson<T>(key: string): Promise<T | null> {
    const value = await this.client.get(key);
    return value === null ? null : (JSON.parse(value) as T);
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.client.set(key, JSON.stringify(value), { EX: ttlSeconds });
  }

  async withLock<T>(
    key: string,
    action: () => Promise<T>,
    ttlMs = this.lockTtlMs,
    waitMs = 0,
  ): Promise<T> {
    const token = randomUUID();
    const deadline = Date.now() + waitMs;
    let acquired = await this.client.set(key, token, { NX: true, PX: ttlMs });

    while (acquired !== 'OK' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 75));
      acquired = await this.client.set(key, token, { NX: true, PX: ttlMs });
    }

    if (acquired !== 'OK') {
      throw new ServiceUnavailableException({
        code: 'RESOURCE_BUSY',
        message: 'The resource is being updated. Retry the command.',
      });
    }

    try {
      return await action();
    } finally {
      await this.client
        .eval(
          `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`,
          { keys: [key], arguments: [token] },
        )
        .catch((error: Error) => this.logger.warn(`Could not release lock ${key}: ${error.message}`));
    }
  }
}
