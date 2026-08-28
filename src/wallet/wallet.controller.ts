import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { WalletTransactionsQueryDto } from './dto/wallet-transactions-query.dto';
import { WalletService } from './wallet.service';

@UseGuards(JwtAuthGuard)
@Controller('wallet')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.walletService.getPublicWallet(user.id);
  }

  @Get('transactions/me')
  transactions(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: WalletTransactionsQueryDto,
  ) {
    return this.walletService.listTransactions(user.id, query.limit, query.cursor);
  }
}
