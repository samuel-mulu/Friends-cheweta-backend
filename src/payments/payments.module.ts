import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { RolesGuard } from '../common/guards/roles.guard';
import { NotificationsModule } from '../notifications/notifications.module';
import { WalletModule } from '../wallet/wallet.module';
import { AdminPaymentsController } from './admin-payments.controller';
import { PaymentsController } from './payments.controller';
import { RealtimeModule } from '../realtime/realtime.module';
import { SmsModule } from '../sms/sms.module';
import { DepositConfigService } from './deposit-config.service';
import { DepositVerifierService } from './deposit-verifier.service';
import { DepositWorkflowService } from './deposit-workflow.service';
import { PaymentsService } from './payments.service';

@Module({
  imports: [AuthModule, WalletModule, NotificationsModule, AuditModule, RealtimeModule, SmsModule],
  controllers: [PaymentsController, AdminPaymentsController],
  providers: [
    PaymentsService,
    DepositConfigService,
    DepositVerifierService,
    DepositWorkflowService,
    RolesGuard,
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
