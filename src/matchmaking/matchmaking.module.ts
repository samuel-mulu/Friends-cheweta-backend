import { Module } from '@nestjs/common';
import { GameEntryModule } from '../game-entry/game-entry.module';
import { GamingModule } from '../gaming/gaming.module';
import { MatchmakingService } from './matchmaking.service';

@Module({
  imports: [GamingModule, GameEntryModule],
  providers: [MatchmakingService],
  exports: [MatchmakingService],
})
export class MatchmakingModule {}
