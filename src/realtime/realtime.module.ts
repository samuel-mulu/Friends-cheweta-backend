import { Module } from '@nestjs/common';
import { GameEntryModule } from '../game-entry/game-entry.module';
import { ChallengeModule } from '../challenge/challenge.module';
import { ChatModule } from '../chat/chat.module';
import { LobbyModule } from '../lobby/lobby.module';
import { MatchCreationModule } from '../match-creation/match-creation.module';
import { MatchHistoryModule } from '../match-history/match-history.module';
import { SettlementModule } from '../settlement/settlement.module';
import { BotDriverService } from '../practice/bot-driver.service';
import { DamaBotDriverService } from '../practice/dama-bot-driver.service';
import { PracticeService } from '../practice/practice.service';
import { DamaRuntimeRepository } from './dama/dama-runtime.repository';
import { DamaRuntimeService } from './dama/dama-runtime.service';
import { DamaTurnTimerService } from './dama/dama-turn-timer.service';
import { DamaGateway } from './dama/dama.gateway';
import { AdminGateway } from './gateways/admin.gateway';
import { ChatGateway } from './gateways/chat.gateway';
import { ConnectionGateway } from './gateways/connection.gateway';
import { LobbyGateway } from './gateways/lobby.gateway';
import { PracticeGateway } from './gateways/practice.gateway';
import {
  KartaRuntimeRepository,
  KartaRuntimeService,
  KartaTurnTimerService,
} from './karta/karta.game';
import { KartaGateway } from './karta/karta.gateway';
import { KartaTableService } from './karta/karta-table.service';
import {
  LudoRuntimeRepository,
  LudoRuntimeService,
  LudoTurnTimerService,
} from './ludo/ludo-runtime.service';
import { LudoGateway } from './ludo/ludo.gateway';
import { LobbyMatchmakingService } from './lobby-matchmaking.service';
import { MatchJoinTracker } from './match-join-tracker';
import { PresenceService } from './presence.service';
import { RealtimePublisherService } from './realtime-publisher.service';
import { RealtimeAuthService } from './realtime-auth.service';
import { DisconnectGraceService } from './timeout/disconnect-grace.service';
import { PrematchCleanupService } from './timeout/prematch-cleanup.service';
import { RealtimeMaintenanceService } from './timeout/realtime-maintenance.service';
import { GameRegistry } from './turn-game/game-registry';

@Module({
  imports: [
    LobbyModule,
    ChallengeModule,
    ChatModule,
    GameEntryModule,
    SettlementModule,
    MatchHistoryModule,
    MatchCreationModule,
  ],
  providers: [
    ConnectionGateway,
    LobbyGateway,
    ChatGateway,
    PracticeGateway,
    AdminGateway,
    RealtimeAuthService,
    PresenceService,
    RealtimePublisherService,
    LobbyMatchmakingService,
    MatchJoinTracker,
    // Ludo
    LudoRuntimeRepository,
    LudoRuntimeService,
    LudoTurnTimerService,
    LudoGateway,
    BotDriverService,
    PracticeService,
    // Dama
    DamaRuntimeRepository,
    DamaRuntimeService,
    DamaTurnTimerService,
    DamaBotDriverService,
    DamaGateway,
    // Karta
    KartaRuntimeRepository,
    KartaRuntimeService,
    KartaTurnTimerService,
    KartaGateway,
    KartaTableService,
    // Cross-game
    {
      provide: GameRegistry,
      inject: [
        LudoRuntimeService,
        LudoTurnTimerService,
        DamaRuntimeService,
        DamaTurnTimerService,
        KartaRuntimeService,
        KartaTurnTimerService,
      ],
      useFactory: (
        ludo: LudoRuntimeService,
        ludoTimer: LudoTurnTimerService,
        dama: DamaRuntimeService,
        damaTimer: DamaTurnTimerService,
        karta: KartaRuntimeService,
        kartaTimer: KartaTurnTimerService,
      ) =>
        new GameRegistry([
          { definition: ludo.definition, runtime: ludo, timer: ludoTimer },
          { definition: dama.definition, runtime: dama, timer: damaTimer },
          { definition: karta.definition, runtime: karta, timer: kartaTimer },
        ]),
    },
    PrematchCleanupService,
    DisconnectGraceService,
    RealtimeMaintenanceService,
  ],
  exports: [LudoRuntimeService, GameRegistry, RealtimePublisherService],
})
export class RealtimeModule {}
