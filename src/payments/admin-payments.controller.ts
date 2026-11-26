import {
  Body,
  Controller,
  Get,
  Param,
  ParseEnumPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { PaymentChannel, UserRole } from '../generated/prisma/enums';
import { PaymentListQueryDto } from './dto/payment-list-query.dto';
import { RejectPaymentDto } from './dto/reject-payment.dto';
import { Throttle } from '@nestjs/throttler';
import { GeezSmsService } from '../sms/geez-sms.service';
import { DepositConfigService } from './deposit-config.service';
import {
  ApproveDepositDto,
  ChangeApprovalPinDto,
  PayWithdrawalDto,
  UpdateDepositConfigDto,
} from './dto/payment-settings.dto';
import { PaymentsService } from './payments.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/payments')
export class AdminPaymentsController {
  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly depositConfig: DepositConfigService,
    private readonly sms: GeezSmsService,
  ) {}

  @Get('deposit-config')
  config() {
    return this.depositConfig.adminConfig();
  }

  @Patch('deposit-config/:channel')
  updateConfig(
    @Param('channel', new ParseEnumPipe(PaymentChannel)) channel: PaymentChannel,
    @Body() dto: UpdateDepositConfigDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.depositConfig.update(channel, dto, admin.id);
  }

  @Post('deposit-config/telebirr/reset-fallback')
  resetFallback(@CurrentUser() admin: AuthenticatedUser) {
    return this.depositConfig.resetFallback(admin.id);
  }

  @Throttle({ default: { ttl: 60_000, limit: 8 } })
  @Post('deposit-config/change-pin')
  changePin(@Body() dto: ChangeApprovalPinDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.depositConfig.changePin(dto.currentPin, dto.newPin, admin.id);
  }

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Get('sms/balance')
  smsBalance() {
    return this.sms.balance();
  }

  @Get('deposits')
  deposits(@Query() query: PaymentListQueryDto) {
    return this.paymentsService.listDeposits(query.status, query.limit);
  }

  @Throttle({ default: { ttl: 60_000, limit: 12 } })
  @Patch('deposits/:id/approve')
  approveDeposit(
    @Param('id') id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: ApproveDepositDto,
  ) {
    return this.paymentsService.approveDeposit(id, admin.id, dto.approvalPin);
  }

  @Patch('deposits/:id/reject')
  rejectDeposit(
    @Param('id') id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: RejectPaymentDto,
  ) {
    return this.paymentsService.rejectDeposit(id, admin.id, dto.reason);
  }

  @Get('withdrawals')
  withdrawals(@Query() query: PaymentListQueryDto) {
    return this.paymentsService.listWithdrawals(query.status, query.limit);
  }

  @Patch('withdrawals/:id/approve')
  approveWithdrawal(
    @Param('id') id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: PayWithdrawalDto,
  ) {
    return this.paymentsService.reviewWithdrawal(id, admin.id, {
      payoutUrl: dto.payoutTransactionUrl,
    });
  }

  @Patch('withdrawals/:id/reject')
  rejectWithdrawal(
    @Param('id') id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: RejectPaymentDto,
  ) {
    return this.paymentsService.reviewWithdrawal(id, admin.id, { reason: dto.reason });
  }
}
