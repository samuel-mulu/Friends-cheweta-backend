import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { RolesGuard } from '../common/guards/roles.guard';
import { MatchHistoryModule } from '../match-history/match-history.module';
import { RiskModule } from '../risk/risk.module';
import { UsersModule } from '../users/users.module';
import { AdminOpsController } from './admin-ops.controller';
import { AdminOpsService } from './admin-ops.service';
import { AdminController } from './admin.controller';

@Module({
  imports: [AuthModule, UsersModule, MatchHistoryModule, RiskModule, AuditModule],
  controllers: [AdminController, AdminOpsController],
  providers: [RolesGuard, AdminOpsService],
})
export class AdminModule {}
