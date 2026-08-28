import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { UserRole } from '../generated/prisma/enums';
import { PaymentListQueryDto } from './dto/payment-list-query.dto';
import { RejectPaymentDto } from './dto/reject-payment.dto';
import { PaymentsService } from './payments.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/payments')
export class AdminPaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Get('deposits')
  deposits(@Query() query: PaymentListQueryDto) {
    return this.paymentsService.listDeposits(query.status, query.limit);
  }

  @Patch('deposits/:id/approve')
  approveDeposit(@Param('id') id: string, @CurrentUser() admin: AuthenticatedUser) {
    return this.paymentsService.approveDeposit(id, admin.id);
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
  approveWithdrawal(@Param('id') id: string, @CurrentUser() admin: AuthenticatedUser) {
    return this.paymentsService.approveWithdrawal(id, admin.id);
  }

  @Patch('withdrawals/:id/reject')
  rejectWithdrawal(
    @Param('id') id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: RejectPaymentDto,
  ) {
    return this.paymentsService.rejectWithdrawal(id, admin.id, dto.reason);
  }
}
