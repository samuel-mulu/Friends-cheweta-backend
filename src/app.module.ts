import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdminModule } from './admin/admin.module';
import { RiskModule } from './risk/risk.module';
import { NotificationsModule } from './notifications/notifications.module';
import { MatchHistoryModule } from './match-history/match-history.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { ChallengeModule } from './challenge/challenge.module';
import { ChatModule } from './chat/chat.module';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';
import { validateEnv } from './config/env';
import { GamingModule } from './gaming/gaming.module';
import { HealthModule } from './health/health.module';
import { GameEntryModule } from './game-entry/game-entry.module';
import { LobbyModule } from './lobby/lobby.module';
import { MatchCreationModule } from './match-creation/match-creation.module';
import { SettlementModule } from './settlement/settlement.module';
import { PaymentsModule } from './payments/payments.module';
import { RealtimeModule } from './realtime/realtime.module';
import { RedisModule } from './redis/redis.module';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';
import { WalletModule } from './wallet/wallet.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    PrismaModule,
    RedisModule,
    HealthModule,
    UsersModule,
    AuthModule,
    WalletModule,
    NotificationsModule,
    MatchHistoryModule,
    RiskModule,
    AuditModule,
    PaymentsModule,
    GamingModule,
    LobbyModule,
    MatchCreationModule,
    ChallengeModule,
    ChatModule,
    GameEntryModule,
    SettlementModule,
    RealtimeModule,
    AdminModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
