import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { GamingService } from './gaming.service';

@UseGuards(JwtAuthGuard)
@Controller()
export class GamingController {
  constructor(private readonly gamingService: GamingService) {}

  @Get('games')
  games() {
    return this.gamingService.listGames();
  }

  @Get('games/:code/modes')
  modes(@Param('code') code: string) {
    return this.gamingService.listModes(code);
  }

  @Get('matches/:id')
  match(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.gamingService.getMatchForUser(id, user.id, false);
  }
}
