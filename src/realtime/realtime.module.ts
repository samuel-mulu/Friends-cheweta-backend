import { Module } from '@nestjs/common';
import { GameEntryModule } from '../game-entry/game-entry.module';
import { ChallengeModule } from '../challenge/challenge.module';
import { ChatModule } from '../chat/chat.module';
import { LobbyModule } from '../lobby/lobby.module';
import { MatchHistoryModule } from '../match-history/match-history.module';
import { SettlementModule } from '../settlement/settlement.module';
import { BotDriverService } from '../practice/bot-driver.service';
import { DamaBotDriverService } from '../practice/dama-bot-driver.service';
import { DamaRuntimeRepository } from './dama/dama-runtime.repository';
import { DamaRuntimeService } from './dama/dama-runtime.service';
import { DamaTurnTimerService } from './dama/dama-turn-timer.service';
import { DamaGateway } from './dama/dama.gateway';
import { KartaRuntimeRepository, KartaRuntimeService, KartaTurnTimerService } from './karta/karta.game';
import { KartaGateway } from './karta/karta.gateway';
import { PracticeService } from '../practice/practice.service';
import { LudoRuntimeRepository } from './ludo-runtime.repository';
import { LudoRuntimeService } from './ludo-runtime.service';
import { PresenceService } from './presence.service';
import { RealtimePublisherService } from './realtime-publisher.service';
import { RealtimeAuthService } from './realtime-auth.service';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeMaintenanceService } from './timeout/realtime-maintenance.service';
import { TurnTimeoutService } from './timeout/turn-timeout.service';

@Module({
  imports: [LobbyModule, ChallengeModule, ChatModule, GameEntryModule, SettlementModule, MatchHistoryModule],
  providers: [
    RealtimeGateway,
    RealtimeAuthService,
    PresenceService,
    RealtimePublisherService,
    LudoRuntimeRepository,
    LudoRuntimeService,
    TurnTimeoutService,
    RealtimeMaintenanceService,
    PracticeService,
    BotDriverService,
    DamaRuntimeRepository,
    DamaRuntimeService,
    DamaTurnTimerService,
    DamaBotDriverService,
    DamaGateway,
    KartaRuntimeRepository,
    KartaRuntimeService,
    KartaTurnTimerService,
    KartaGateway,
  ],
  exports: [LudoRuntimeService, TurnTimeoutService],
})
export class RealtimeModule {}
