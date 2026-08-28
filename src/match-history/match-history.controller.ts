import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { MatchHistoryService } from './match-history.service';

@UseGuards(JwtAuthGuard)
@Controller('matches')
export class MatchHistoryController {
  constructor(private readonly history: MatchHistoryService) {}

  @Get('me')
  mine(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.history.listMine(user.id, limit ? Number(limit) : 20, cursor);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.history.getMatch(id, user);
  }

  @Get(':id/replay')
  replay(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.history.replay(id, user);
  }
}
