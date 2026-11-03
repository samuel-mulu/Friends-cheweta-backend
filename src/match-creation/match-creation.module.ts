import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module';
import { MatchCreationService } from './match-creation.service';

@Module({
  imports: [WalletModule],
  providers: [MatchCreationService],
  exports: [MatchCreationService],
})
export class MatchCreationModule {}
