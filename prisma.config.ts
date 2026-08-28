import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Neon (and similar poolers) require a direct connection for migrations.
 * Runtime queries use DATABASE_URL (pooler); migrate deploy prefers DIRECT_DATABASE_URL.
 */
function migrationDatabaseUrl(): string {
  const direct = process.env.DIRECT_DATABASE_URL?.trim();
  const pooled = process.env.DATABASE_URL?.trim();
  const url = direct || pooled;
  if (!url) {
    throw new Error('Set DATABASE_URL (runtime) and preferably DIRECT_DATABASE_URL (migrations).');
  }
  return url;
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: migrationDatabaseUrl(),
  },
});
