import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { LeaderboardPeriod, StatsService } from './stats.service';

@UseGuards(JwtAuthGuard)
@Controller('stats')
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get('me')
  mine(@CurrentUser() user: AuthenticatedUser) {
    return this.stats.playerSummary(user.id);
  }

  @Get('leaderboard')
  leaderboard(@Query('period') period?: string) {
    return this.stats.leaderboard((period === 'week' ? 'week' : 'all') as LeaderboardPeriod);
  }

  @Get('matches/:id')
  match(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.stats.matchStats(id, user);
  }
}
