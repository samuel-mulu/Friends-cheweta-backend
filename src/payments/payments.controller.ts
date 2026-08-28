import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { CreateDepositDto } from './dto/create-deposit.dto';
import { CreateWithdrawalDto } from './dto/create-withdrawal.dto';
import { PaymentsService } from './payments.service';

@UseGuards(JwtAuthGuard)
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('deposits')
  createDeposit(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateDepositDto) {
    return this.paymentsService.createDeposit(user.id, dto);
  }

  @Get('deposits/me')
  deposits(@CurrentUser() user: AuthenticatedUser) {
    return this.paymentsService.listMyDeposits(user.id);
  }

  @Post('withdrawals')
  createWithdrawal(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateWithdrawalDto) {
    return this.paymentsService.createWithdrawal(user.id, dto);
  }

  @Get('withdrawals/me')
  withdrawals(@CurrentUser() user: AuthenticatedUser) {
    return this.paymentsService.listMyWithdrawals(user.id);
  }
}
