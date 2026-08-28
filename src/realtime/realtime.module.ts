import { Module } from '@nestjs/common';
import { GameEntryModule } from '../game-entry/game-entry.module';
import { MatchmakingModule } from '../matchmaking/matchmaking.module';
import { MatchHistoryModule } from '../match-history/match-history.module';
import { SettlementModule } from '../settlement/settlement.module';
import { LudoRuntimeRepository } from './ludo-runtime.repository';
import { LudoRuntimeService } from './ludo-runtime.service';
import { PresenceService } from './presence.service';
import { RealtimePublisherService } from './realtime-publisher.service';
import { RealtimeAuthService } from './realtime-auth.service';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeMaintenanceService } from './timeout/realtime-maintenance.service';
import { TurnTimeoutService } from './timeout/turn-timeout.service';

@Module({
  imports: [MatchmakingModule, GameEntryModule, SettlementModule, MatchHistoryModule],
  providers: [
    RealtimeGateway,
    RealtimeAuthService,
    PresenceService,
    RealtimePublisherService,
    LudoRuntimeRepository,
    LudoRuntimeService,
    TurnTimeoutService,
    RealtimeMaintenanceService,
  ],
  exports: [LudoRuntimeService, TurnTimeoutService],
})
export class RealtimeModule {}
