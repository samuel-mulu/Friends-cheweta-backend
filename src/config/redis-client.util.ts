import type { RedisClientOptions } from 'redis';

const LOCAL_REDIS_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function assertProductionRedisUrl(redisUrl: string, nodeEnv: string): void {
  if (nodeEnv !== 'production') return;

  let hostname: string;
  try {
    hostname = new URL(redisUrl).hostname.toLowerCase();
  } catch {
    throw new Error('REDIS_URL is not a valid URL. On Render, use the Key Value internal connection string.');
  }

  if (LOCAL_REDIS_HOSTS.has(hostname)) {
    throw new Error(
      'REDIS_URL points to localhost in production. Remove any manual REDIS_URL=redis://127.0.0.1:6379 from Render env vars and link Render Key Value instead (redis://red-xxxxx:6379).',
    );
  }
}

export function redisHostForLogs(redisUrl: string): string {
  try {
    return new URL(redisUrl).hostname;
  } catch {
    return '(invalid REDIS_URL)';
  }
}

export function buildRedisClientOptions(redisUrl: string): RedisClientOptions {
  const options: RedisClientOptions = { url: redisUrl };

  if (redisUrl.startsWith('rediss://')) {
    options.socket = {
      tls: true,
    };
  }

  return options;
}
