import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { LobbyRooms } from './lobby-rooms';
import { LobbyService } from './lobby.service';

@Module({
  imports: [PrismaModule, RedisModule],
  providers: [LobbyService, LobbyRooms],
  exports: [LobbyService, LobbyRooms],
})
export class LobbyModule {}
