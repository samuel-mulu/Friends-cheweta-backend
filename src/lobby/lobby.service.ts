import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { COMMITTED_MATCH_STATUSES, RECOVERABLE_MATCH_STATUSES } from '../common/match-status';
import { MatchStatus, UserStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { LobbyPlayerState, LobbyPlayerView, LobbySnapshot, LobbyUserContext } from './lobby.types';

@Injectable()
export class LobbyService {
  private readonly ttlSeconds = 180;
  private readonly snapshotLimit = 150;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async join(userId: string, gameModeId: string, recentMessages: unknown[] = []): Promise<{ previousGameModeId?: string; snapshot: LobbySnapshot; player: LobbyPlayerView }> {
    const mode = await this.assertMode(gameModeId);
    // Join allows CREATED/WAITING open commitments (stale ones are cleaned by
    // maintenance). Recoverable games are handled by the gateway before join.
    await this.assertPlayerActive(userId);

    const previous = await this.getContext(userId);
    if (previous && previous.gameModeId !== gameModeId) await this.leave(userId);

    const now = new Date().toISOString();
    const context: LobbyUserContext = { gameModeId, state: 'ONLINE', joinedAt: now };
    await this.redis.raw().multi()
      .sAdd(this.onlineKey(gameModeId), userId)
      .expire(this.onlineKey(gameModeId), this.ttlSeconds)
      .set(this.userKey(userId), JSON.stringify(context), { EX: this.ttlSeconds })
      .exec();

    const snapshot = await this.snapshot(userId, gameModeId, undefined, recentMessages);
    // Room-broadcast player view must be viewer-neutral (no isSelf).
    return { previousGameModeId: previous?.gameModeId, snapshot, player: await this.playerView(userId, context) };
  }

  async activeMatchForUser(userId: string) {
    const participant = await this.prisma.matchParticipant.findFirst({
      where: { userId, match: { status: { in: RECOVERABLE_MATCH_STATUSES } } },
      include: { match: { include: { game: true, gameMode: true, participants: { include: { user: { select: { id: true, fullName: true } } }, orderBy: { seat: 'asc' } } } } },
      orderBy: { joinedAt: 'desc' },
    });
    if (!participant) return null;
    const match = participant.match;
    return {
      ...match,
      stakeAmountMinor: match.stakeAmountMinor.toString(),
      gameMode: { ...match.gameMode, stakeAmountMinor: match.gameMode.stakeAmountMinor.toString() },
    };
  }

  async findCommittedMatchForUser(userId: string): Promise<{ matchId: string; status: MatchStatus } | null> {
    const participant = await this.prisma.matchParticipant.findFirst({
      where: { userId, match: { status: { in: COMMITTED_MATCH_STATUSES } } },
      select: { matchId: true, match: { select: { status: true } } },
      orderBy: { joinedAt: 'desc' },
    });
    if (!participant) return null;
    return { matchId: participant.matchId, status: participant.match.status };
  }

  async ready(userId: string): Promise<{ gameModeId: string; player: LobbyPlayerView }> {
    const context = await this.requireContext(userId);
    if (context.state === 'READY') throw new ConflictException({ code: 'LOBBY_ALREADY_READY', message: 'You are already ready.' });
    if (context.state !== 'ONLINE') throw new ConflictException({ code: 'LOBBY_USER_BUSY', message: 'You cannot ready while busy.' });
    await this.assertMode(context.gameModeId);
    await this.assertNoCommittedMatch(userId);

    const readyAt = new Date().toISOString();
    const next: LobbyUserContext = { ...context, state: 'READY', readyAt };
    await this.redis.raw().multi()
      .zAdd(this.readyKey(context.gameModeId), [{ score: Date.parse(readyAt), value: userId }])
      .expire(this.readyKey(context.gameModeId), this.ttlSeconds)
      .set(this.userKey(userId), JSON.stringify(next), { EX: this.ttlSeconds })
      .exec();
    return { gameModeId: context.gameModeId, player: await this.playerView(userId, next) };
  }

  async unready(userId: string): Promise<{ gameModeId: string; player: LobbyPlayerView }> {
    const context = await this.requireContext(userId);
    if (context.state === 'CHALLENGED') throw new ConflictException({ code: 'LOBBY_USER_BUSY', message: 'Resolve challenge first.' });
    if (context.state !== 'READY') throw new ConflictException({ code: 'LOBBY_NOT_READY', message: 'You are not ready.' });
    const next: LobbyUserContext = { gameModeId: context.gameModeId, state: 'ONLINE', joinedAt: context.joinedAt };
    await this.redis.raw().multi()
      .zRem(this.readyKey(context.gameModeId), userId)
      .set(this.userKey(userId), JSON.stringify(next), { EX: this.ttlSeconds })
      .exec();
    return { gameModeId: context.gameModeId, player: await this.playerView(userId, next) };
  }

  async leave(userId: string): Promise<{ gameModeId?: string; player?: LobbyPlayerView }> {
    const context = await this.getContext(userId);
    if (!context) return {};
    const player = await this.playerView(userId, context);
    await this.redis.raw().multi()
      .sRem(this.onlineKey(context.gameModeId), userId)
      .zRem(this.readyKey(context.gameModeId), userId)
      .del(this.userKey(userId))
      .exec();
    return { gameModeId: context.gameModeId, player };
  }

  async snapshot(viewerUserId: string, gameModeId: string, activeChallenge?: unknown, recentMessages: unknown[] = []): Promise<LobbySnapshot> {
    const mode = await this.assertMode(gameModeId);
    const onlineIds = await this.redis.raw().sMembers(this.onlineKey(gameModeId));
    const readyIds = await this.redis.raw().zRange(this.readyKey(gameModeId), 0, this.snapshotLimit - 1);
    const ids = [...new Set([...readyIds, ...onlineIds])].slice(0, this.snapshotLimit);
    const players: LobbyPlayerView[] = [];
    for (const userId of ids) {
      const context = await this.getContext(userId);
      if (!context || context.gameModeId !== gameModeId) {
        await this.redis.raw().sRem(this.onlineKey(gameModeId), userId);
        await this.redis.raw().zRem(this.readyKey(gameModeId), userId);
        continue;
      }
      players.push(await this.playerView(userId, context, viewerUserId));
    }
    const myContext = await this.getContext(viewerUserId);
    return {
      gameMode: { id: mode.id, code: mode.code, name: mode.name, stakeAmountMinor: mode.stakeAmountMinor.toString(), currency: 'ETB' },
      myState: myContext?.gameModeId === gameModeId ? myContext.state : 'ONLINE',
      players,
      ...(activeChallenge ? { activeChallenge } : {}),
      recentMessages,
      serverTime: new Date().toISOString(),
    };
  }

  async setChallenged(userIds: string[], gameModeId: string): Promise<LobbyPlayerView[]> {
    const views: LobbyPlayerView[] = [];
    const tx = this.redis.raw().multi();
    for (const userId of userIds) {
      const context = await this.requireContext(userId);
      const next: LobbyUserContext = { ...context, state: 'CHALLENGED' };
      tx.zRem(this.readyKey(gameModeId), userId);
      tx.set(this.userKey(userId), JSON.stringify(next), { EX: this.ttlSeconds });
      views.push(await this.playerView(userId, next));
    }
    await tx.exec();
    return views;
  }

  async restoreReady(userIds: string[], gameModeId: string): Promise<LobbyPlayerView[]> {
    const now = Date.now();
    const views: LobbyPlayerView[] = [];
    const tx = this.redis.raw().multi();
    for (const userId of userIds) {
      const context = await this.getContext(userId);
      if (!context || context.gameModeId !== gameModeId) continue;
      const readyAt = new Date(now).toISOString();
      const next: LobbyUserContext = { ...context, state: 'READY', readyAt };
      tx.zAdd(this.readyKey(gameModeId), [{ score: now, value: userId }]);
      tx.set(this.userKey(userId), JSON.stringify(next), { EX: this.ttlSeconds });
      views.push(await this.playerView(userId, next));
    }
    await tx.exec();
    return views;
  }

  /** Refresh lobby Redis TTLs while the socket stays connected (reuses presence heartbeat). */
  async touch(userId: string): Promise<void> {
    const context = await this.getContext(userId);
    if (!context) return;
    const tx = this.redis.raw().multi()
      .expire(this.userKey(userId), this.ttlSeconds)
      .expire(this.onlineKey(context.gameModeId), this.ttlSeconds);
    if (context.state === 'READY') {
      tx.expire(this.readyKey(context.gameModeId), this.ttlSeconds);
    }
    await tx.exec();
  }

  async getContext(userId: string): Promise<LobbyUserContext | null> {
    return this.redis.getJson<LobbyUserContext>(this.userKey(userId));
  }

  async requireContext(userId: string): Promise<LobbyUserContext> {
    const context = await this.getContext(userId);
    if (!context) throw new ConflictException({ code: 'LOBBY_NOT_JOINED', message: 'Join a lobby first.' });
    return context;
  }

  userRoom(gameModeId: string): string {
    return `lobby:${gameModeId}`;
  }

  private async playerView(userId: string, context: LobbyUserContext, viewerUserId?: string): Promise<LobbyPlayerView> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } });
    return {
      userId,
      displayName: user?.fullName ?? 'Player',
      state: context.state,
      ...(context.readyAt ? { readyAt: context.readyAt } : {}),
      ...(viewerUserId === userId ? { isSelf: true } : {}),
    };
  }

  private async assertMode(gameModeId: string) {
    const mode = await this.prisma.gameMode.findUnique({ where: { id: gameModeId }, include: { game: true } });
    if (!mode) throw new NotFoundException({ code: 'LOBBY_INVALID_MODE', message: 'Lobby mode does not exist.' });
    if (!mode.enabled || !mode.game.enabled) throw new BadRequestException({ code: 'LOBBY_MODE_DISABLED', message: 'Lobby mode is disabled.' });
    return mode;
  }

  private async assertPlayerActive(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new BadRequestException({ code: 'PLAYER_NOT_ELIGIBLE', message: 'Player is not eligible.' });
    }
  }

  private async assertNoCommittedMatch(userId: string): Promise<void> {
    await this.assertPlayerActive(userId);
    const active = await this.prisma.matchParticipant.findFirst({
      where: { userId, match: { status: { in: COMMITTED_MATCH_STATUSES } } },
      select: { matchId: true, match: { select: { status: true } } },
    });
    if (active) {
      throw new ConflictException({
        code: 'LOBBY_ACTIVE_MATCH',
        message: 'You already have an open match entry.',
      });
    }
  }

  private onlineKey(gameModeId: string): string { return this.redis.key('lobby', gameModeId, 'online'); }
  private readyKey(gameModeId: string): string { return this.redis.key('lobby', gameModeId, 'ready'); }
  private userKey(userId: string): string { return this.redis.key('lobby', 'user', userId); }
}
