import { BadRequestException, Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { UserRole } from '../generated/prisma/enums';
import { AuditService } from '../audit/audit.service';
import { MatchHistoryService } from '../match-history/match-history.service';
import { RiskService } from '../risk/risk.service';
import { AdminOpsService } from './admin-ops.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin')
export class AdminOpsController {
  constructor(
    private readonly ops: AdminOpsService,
    private readonly history: MatchHistoryService,
    private readonly risk: RiskService,
    private readonly audit: AuditService,
  ) {}

  @Get('dashboard')
  dashboard() {
    return this.ops.dashboard();
  }

  @Get('matches')
  matches(@Query('limit') limit?: string, @Query('status') status?: string) {
    return this.history.listAdmin(limit ? Number(limit) : 50, status);
  }

  @Get('matches/:id')
  match(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.history.getMatch(id, user);
  }

  @Get('matches/:id/replay')
  replay(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.history.replay(id, user);
  }

  @Get('risk-flags')
  riskFlags(@Query('status') status?: string, @Query('limit') limit?: string) {
    return this.risk.list(status ?? 'OPEN', limit ? Number(limit) : 100);
  }

  @Patch('risk-flags/:id')
  async reviewRisk(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: { status: 'REVIEWED' | 'DISMISSED' },
  ) {
    if (!['REVIEWED', 'DISMISSED'].includes(body.status)) {
      throw new BadRequestException({ code: 'INVALID_RISK_STATUS', message: 'Risk status must be REVIEWED or DISMISSED.' });
    }
    const flag = await this.risk.review(id, user.id, body.status);
    await this.audit.write({
      actorUserId: user.id,
      action: 'RISK_FLAG_REVIEWED',
      entityType: 'RISK_FLAG',
      entityId: id,
      metadata: { status: body.status },
    });
    return flag;
  }

  @Get('audit')
  auditLogs(@Query('limit') limit?: string, @Query('action') action?: string) {
    return this.audit.list(limit ? Number(limit) : 100, action);
  }
}
