import { Module } from '@nestjs/common';
import { LobbyModule } from '../lobby/lobby.module';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { ChatService } from './chat.service';
import { DirectChatService } from './direct-chat.service';

@Module({
  imports: [PrismaModule, RedisModule, LobbyModule],
  providers: [ChatService, DirectChatService],
  exports: [ChatService, DirectChatService],
})
export class ChatModule {}
