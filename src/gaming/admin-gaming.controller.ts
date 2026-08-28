import { Body, Controller, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { UserRole } from '../generated/prisma/enums';
import { CreateGameModeDto } from './dto/create-game-mode.dto';
import { UpdateGameModeDto } from './dto/update-game-mode.dto';
import { GamingService } from './gaming.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/games')
export class AdminGamingController {
  constructor(private readonly gamingService: GamingService) {}

  @Post('modes')
  createMode(@Body() dto: CreateGameModeDto) {
    return this.gamingService.createMode(dto);
  }

  @Patch('modes/:id')
  updateMode(@Param('id') id: string, @Body() dto: UpdateGameModeDto) {
    return this.gamingService.updateMode(id, dto);
  }
}
