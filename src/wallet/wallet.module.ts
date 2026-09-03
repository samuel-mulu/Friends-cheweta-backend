import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RolesGuard } from '../common/guards/roles.guard';
import { AdminWalletController } from './admin-wallet.controller';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';

@Module({
  imports: [AuthModule],
  controllers: [WalletController, AdminWalletController],
  providers: [WalletService, RolesGuard],
  exports: [WalletService],
})
export class WalletModule {}
