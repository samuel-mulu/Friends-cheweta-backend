import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { UserRole } from '../generated/prisma/enums';
import { UpdateUserStatusDto } from '../users/dto/update-user-status.dto';
import { UsersService } from '../users/users.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/users')
export class AdminController {
  constructor(
    private readonly usersService: UsersService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list() {
    return this.usersService.list();
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const user = await this.usersService.getRequiredById(id);
    return {
      id: user.id,
      fullName: user.fullName,
      phoneNumber: user.phoneNumber,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  @Patch(':id/status')
  async updateStatus(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateUserStatusDto,
  ) {
    const updated = await this.usersService.updateStatus(id, dto.status);
    await this.audit.write({
      actorUserId: admin.id,
      action: 'USER_STATUS_CHANGED',
      entityType: 'USER',
      entityId: id,
      metadata: { status: dto.status },
    });
    return updated;
  }
}
