import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  DATABASE_URL: z.string().min(1),
  // DB7: explicit connection pool ceiling instead of relying on node-postgres's
  // implicit default (10). 15 is a deliberate, modest starting point - not an
  // automatic jump to 50/100 "just in case".
  DATABASE_POOL_MAX: z.coerce.number().int().min(2).max(30).default(15),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  REDIS_KEY_PREFIX: z.string().min(1).default('friends-game'),
  REDIS_RUNTIME_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
  REDIS_COMMAND_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
  REDIS_PRESENCE_TTL_SECONDS: z.coerce.number().int().positive().default(90),
  REDIS_LOCK_TTL_MS: z.coerce.number().int().min(1000).max(30000).default(5000),

  LUDO_MAX_CONSECUTIVE_TIMEOUTS: z.coerce.number().int().min(1).max(10).default(3),
  LUDO_DISCONNECT_GRACE_SECONDS: z.coerce.number().int().min(15).max(600).default(90),
  LUDO_READY_NO_SHOW_SECONDS: z.coerce.number().int().min(30).max(1800).default(180),
  /** Abandoned CREATED/WAITING matches older than matchmaking queue TTL are cancelled/refunded. */
  PREMATCH_ORPHAN_TIMEOUT_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
});

export type AppEnv = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): AppEnv {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${message}`);
  }
  return parsed.data;
}
