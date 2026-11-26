import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { BroadcastsService } from './broadcasts.service';
import { FeedbackService } from './feedback.service';
import {
  BroadcastInboxQuery,
  CreateBroadcastDto,
  DismissBroadcastDto,
  FeedbackQuery,
  InboxQuery,
  MarkFeedbackSeenDto,
  SetBroadcastLiveDto,
  StartFeedbackDto,
  SubmitFeedbackDto,
  UpdateFeedbackDto,
} from './communications.dto';

function playerId(user: AuthenticatedUser) {
  if (user.role !== 'PLAYER' || user.isBot) throw new ForbiddenException('Player access required.');
  return user.id;
}

@UseGuards(JwtAuthGuard)
@Controller('notifications/broadcasts')
export class PlayerBroadcastsController {
  constructor(private readonly broadcasts: BroadcastsService) {}

  @Get()
  inbox(@CurrentUser() user: AuthenticatedUser, @Query() query: BroadcastInboxQuery) {
    return this.broadcasts.inbox(playerId(user), query.page, query.spotlightId);
  }

  @Post(':id/dismiss')
  dismiss(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DismissBroadcastDto,
  ) {
    return this.broadcasts.dismiss(playerId(user), id, dto.revision);
  }
}

@UseGuards(JwtAuthGuard)
@Controller('support/messages')
export class PlayerFeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  submit(@CurrentUser() user: AuthenticatedUser, @Body() input: SubmitFeedbackDto) {
    return this.feedback.submit(playerId(user), input);
  }

  @Get('me')
  inbox(@CurrentUser() user: AuthenticatedUser, @Query() query: InboxQuery) {
    return this.feedback.inbox(playerId(user), query.page);
  }

  @Post('me/mark-seen')
  markSeen(@CurrentUser() user: AuthenticatedUser, @Body() input: MarkFeedbackSeenDto) {
    return this.feedback.markSeen(playerId(user), input.seenThrough);
  }
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
@Controller('admin/broadcasts')
export class AdminBroadcastsController {
  constructor(private readonly broadcasts: BroadcastsService) {}

  @Get()
  list(@Query() query: InboxQuery) {
    return this.broadcasts.list(query.page);
  }

  @Post()
  publish(@CurrentUser() user: AuthenticatedUser, @Body() input: CreateBroadcastDto) {
    return this.broadcasts.publish(user.id, input);
  }

  @Patch(':id/forced-live')
  setLive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: SetBroadcastLiveDto,
  ) {
    return this.broadcasts.setLive(id, user.id, input.live, input.expectedLiveId);
  }

  @Post(':id/remind')
  remind(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.broadcasts.remind(id, user.id);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.broadcasts.remove(id, user.id);
  }
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
@Controller('admin/support/messages')
export class AdminFeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  @Get()
  list(@Query() query: FeedbackQuery) {
    return this.feedback.list(query);
  }

  @Get('open-count')
  openCount() {
    return this.feedback.openCount();
  }

  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.feedback.detail(id);
  }

  @Post()
  start(@CurrentUser() user: AuthenticatedUser, @Body() input: StartFeedbackDto) {
    return this.feedback.start(user.id, input);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateFeedbackDto,
  ) {
    return this.feedback.update(id, user.id, input);
  }
}
