import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  async health(): Promise<{ status: 'ok'; database: 'ok'; redis: 'ok' }> {
    await this.prisma.$queryRaw`SELECT 1`;
    await this.redis.raw().ping();
    return { status: 'ok', database: 'ok', redis: 'ok' };
  }
}
