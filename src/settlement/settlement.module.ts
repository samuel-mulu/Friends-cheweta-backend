import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { RiskModule } from '../risk/risk.module';
import { WalletModule } from '../wallet/wallet.module';
import { SettlementService } from './settlement.service';

@Module({
  imports: [WalletModule, NotificationsModule, RiskModule],
  providers: [SettlementService],
  exports: [SettlementService],
})
export class SettlementModule {}
