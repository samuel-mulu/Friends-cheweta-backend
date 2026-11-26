import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { RolesGuard } from '../common/guards/roles.guard';
import { RealtimeModule } from '../realtime/realtime.module';
import { BroadcastsService } from './broadcasts.service';
import {
  AdminBroadcastsController,
  AdminFeedbackController,
  PlayerBroadcastsController,
  PlayerFeedbackController,
} from './communications.controller';
import { FeedbackService } from './feedback.service';

@Module({
  imports: [AuthModule, AuditModule, RealtimeModule],
  providers: [BroadcastsService, FeedbackService, RolesGuard],
  controllers: [
    PlayerBroadcastsController,
    PlayerFeedbackController,
    AdminBroadcastsController,
    AdminFeedbackController,
  ],
})
export class CommunicationsModule {}
