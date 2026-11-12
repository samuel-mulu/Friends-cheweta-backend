import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { seedCatalog } from './catalog-seed';

/**
 * Production catalog seed. Creates practice bots and game modes only.
 * Run after `prisma migrate deploy`: node dist/seed/production-seed.js
 */
async function main(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') {
    throw new Error('production-seed must run with NODE_ENV=production.');
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for seed.');
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  try {
    const { bots } = await seedCatalog(prisma);
    console.log(`Seeded ${bots} practice bots and the Ludo, Dama, and Karta catalog. No admin accounts were created.`);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
