import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { LobbyModule } from '../lobby/lobby.module';
import { MatchCreationModule } from '../match-creation/match-creation.module';
import { ChallengeService } from './challenge.service';

@Module({
  imports: [PrismaModule, RedisModule, LobbyModule, MatchCreationModule],
  providers: [ChallengeService],
  exports: [ChallengeService],
})
export class ChallengeModule {}
