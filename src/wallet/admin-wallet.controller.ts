import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { UserRole } from '../generated/prisma/enums';
import { AdminWalletTransactionsQueryDto } from './dto/admin-wallet-transactions-query.dto';
import { WalletService } from './wallet.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/wallet')
export class AdminWalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get('transactions')
  listTransactions(@Query() query: AdminWalletTransactionsQueryDto) {
    return this.walletService.listAdminTransactions({
      type: query.type,
      userId: query.userId,
      limit: query.limit,
    });
  }

  @Get('users/:userId')
  getUserWallet(@Param('userId') userId: string) {
    return this.walletService.getAdminWallet(userId);
  }
}
