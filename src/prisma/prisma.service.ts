import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { AppEnv } from '../config/env';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private static readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService<AppEnv, true>) {
    // DB7: pool size is explicit (DATABASE_POOL_MAX, default 15) rather than
    // relying on node-postgres's implicit default of 10. DATABASE_URL stays
    // the pooled Neon connection used for all runtime traffic; migrations
    // use DIRECT_DATABASE_URL separately via prisma.config.ts, never this
    // pool.
    const adapter = new PrismaPg(
      {
        connectionString: config.get('DATABASE_URL', { infer: true }),
        max: config.get('DATABASE_POOL_MAX', { infer: true }),
      },
      {
        // Cheap, adapter-provided hooks - not a new monitoring system. Pool
        // exhaustion/connection errors are rare and worth a log line; this
        // does not add any polling or dashboard.
        onPoolError: (error) => PrismaService.logger.warn(`Postgres pool error: ${error.message}`),
        onConnectionError: (error) => PrismaService.logger.warn(`Postgres connection error: ${error.message}`),
      },
    );
    super({ adapter });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
