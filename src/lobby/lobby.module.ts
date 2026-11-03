import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { LobbyService } from './lobby.service';

@Module({
  imports: [PrismaModule, RedisModule],
  providers: [LobbyService],
  exports: [LobbyService],
})
export class LobbyModule {}
