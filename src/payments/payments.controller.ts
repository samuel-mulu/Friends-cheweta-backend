import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PAYMENT_RATE_LIMIT } from '../common/rate-limit';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { CreateDepositDto } from './dto/create-deposit.dto';
import { CreateWithdrawalDto } from './dto/create-withdrawal.dto';
import { DepositConfigService } from './deposit-config.service';
import { DepositWorkflowService } from './deposit-workflow.service';
import { DepositReferenceDto, PreviewDepositDto } from './dto/payment-settings.dto';
import { PaymentsService } from './payments.service';

@UseGuards(JwtAuthGuard)
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly depositWorkflow: DepositWorkflowService,
    private readonly depositConfig: DepositConfigService,
  ) {}

  @Get('deposits/config')
  config() {
    return this.depositConfig.playerConfig();
  }

  @Throttle(PAYMENT_RATE_LIMIT)
  @Post('deposits/check-ref')
  checkReference(@Body() dto: DepositReferenceDto) {
    return this.depositWorkflow.checkReference(dto);
  }

  @Throttle(PAYMENT_RATE_LIMIT)
  @Post('deposits/preview')
  previewDeposit(@Body() dto: PreviewDepositDto) {
    return this.depositWorkflow.preview(dto, dto.amountMinor);
  }

  @Get('deposits/verification-attempts/active')
  activeAttempts(@CurrentUser() user: AuthenticatedUser) {
    return this.depositWorkflow.active(user.id);
  }

  @Throttle(PAYMENT_RATE_LIMIT)
  @Post('deposits/verification-attempts/:id/check')
  checkAttempt(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.depositWorkflow.check(user.id, id);
  }

  @Post('deposits/verification-attempts/:id/cancel')
  cancelAttempt(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.depositWorkflow.cancel(user.id, id);
  }

  @Throttle(PAYMENT_RATE_LIMIT)
  @Post('deposits')
  createDeposit(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateDepositDto) {
    return this.depositWorkflow.create(user.id, dto);
  }

  @Get('deposits/me')
  deposits(@CurrentUser() user: AuthenticatedUser) {
    return this.paymentsService.listMyDeposits(user.id);
  }

  @Throttle(PAYMENT_RATE_LIMIT)
  @Post('withdrawals')
  createWithdrawal(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateWithdrawalDto) {
    return this.paymentsService.createWithdrawal(user.id, dto);
  }

  @Get('withdrawals/me')
  withdrawals(@CurrentUser() user: AuthenticatedUser) {
    return this.paymentsService.listMyWithdrawals(user.id);
  }
}
