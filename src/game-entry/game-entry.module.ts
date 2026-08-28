import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module';
import { GameEntryService } from './game-entry.service';

@Module({
  imports: [WalletModule],
  providers: [GameEntryService],
  exports: [GameEntryService],
})
export class GameEntryModule {}
