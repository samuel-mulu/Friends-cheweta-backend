import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { COMMITTED_MATCH_STATUSES, RECOVERABLE_MATCH_STATUSES } from '../common/match-status';
import { UserStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { LobbyRooms } from './lobby-rooms';
import {
  LOBBY_TTL_SECONDS,
  LobbyGameSnapshot,
  LobbyPlayerView,
  LobbySnapshot,
  LobbyUserContext,
} from './lobby.types';

@Injectable()
export class LobbyService {
  private readonly snapshotLimit = 150;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Optional() private readonly rooms?: LobbyRooms,
  ) {}

  async join(
    userId: string,
    gameModeId: string,
    recentMessages: unknown[] = [],
  ): Promise<{ previousGameModeId?: string; snapshot: LobbySnapshot; player: LobbyPlayerView }> {
    const { previousGameModeId, player } = await this.enter(userId, gameModeId);
    const snapshot = await this.snapshot(userId, gameModeId, recentMessages);
    return { previousGameModeId, snapshot, player };
  }

  /**
   * Open a game's lobby at a stake: `gameModeId`, else the stake the player
   * already sits at in this game, else the smallest. Re-entering at the same
   * stake keeps the player's state (ready, or a pending challenge); moving to
   * another stake starts them ONLINE there.
   */
  async joinGame(
    userId: string,
    gameCode: string,
    gameModeId?: string,
  ): Promise<{
    gameId: string;
    gameModeId: string;
    previousGameModeId?: string;
    changed: boolean;
    snapshot: LobbyGameSnapshot;
    player: LobbyPlayerView;
  }> {
    const game = await this.requireGame(gameCode);
    const stakeIds = game.modes.map((mode) => mode.id);
    if (gameModeId && !stakeIds.includes(gameModeId)) {
      throw new NotFoundException({
        code: 'LOBBY_INVALID_MODE',
        message: 'This stake is not open.',
      });
    }
    const current = await this.getContext(userId);
    const target =
      gameModeId ??
      (current && stakeIds.includes(current.gameModeId) ? current.gameModeId : stakeIds[0]);

    let previousGameModeId = current?.gameModeId;
    let changed = false;
    if (current?.gameModeId !== target) {
      if (current?.state === 'CHALLENGED') {
        throw new ConflictException({
          code: 'LOBBY_USER_BUSY',
          message: 'Resolve the challenge first.',
        });
      }
      previousGameModeId = (await this.enter(userId, target)).previousGameModeId;
      changed = true;
    } else {
      await this.assertUsersActive([userId]);
      await this.touch(userId);
    }
    const snapshot = await this.gameSnapshot(userId, game);
    const [player] = await this.playerViews([userId]);
    return { gameId: game.id, gameModeId: target, previousGameModeId, changed, snapshot, player };
  }

  /** Everyone at every stake of a game, for a lobby that shows them all. */
  async gameSnapshot(
    viewerUserId: string,
    game: Awaited<ReturnType<LobbyService['requireGame']>>,
    recentMessages: unknown[] = [],
  ): Promise<LobbyGameSnapshot> {
    const perStake = await Promise.all(
      game.modes.map(async (mode) => {
        const [onlineIds, readyIds] = await Promise.all([
          this.redis.raw().sMembers(this.onlineKey(mode.id)),
          this.redis.raw().zRange(this.readyKey(mode.id), 0, this.snapshotLimit - 1),
        ]);
        return { mode, ids: [...new Set([...readyIds, ...onlineIds])] };
      }),
    );
    const allIds = [...new Set(perStake.flatMap((stake) => stake.ids))].slice(
      0,
      this.snapshotLimit,
    );
    const contexts = await this.getContexts([...new Set([...allIds, viewerUserId])]);

    const liveIds: string[] = [];
    const stakes = [];
    for (const { mode, ids } of perStake) {
      const stale = ids.filter((id) => contexts.get(id)?.gameModeId !== mode.id);
      if (stale.length > 0) {
        await this.redis
          .raw()
          .multi()
          .sRem(this.onlineKey(mode.id), stale)
          .zRem(this.readyKey(mode.id), stale)
          .exec();
      }
      const live = ids.filter((id) => !stale.includes(id) && allIds.includes(id));
      liveIds.push(...live);
      stakes.push({
        id: mode.id,
        stakeAmountMinor: mode.stakeAmountMinor.toString(),
        onlineCount: live.length,
        readyCount: live.filter((id) => contexts.get(id)?.state === 'READY').length,
      });
    }

    const mine = contexts.get(viewerUserId);
    const inGame = mine && game.modes.some((mode) => mode.id === mine.gameModeId);
    return {
      game: { id: game.id, code: game.code, name: game.name },
      stakes,
      gameModeId: inGame ? mine.gameModeId : game.modes[0].id,
      myState: inGame ? mine.state : 'ONLINE',
      players: await this.playerViews(liveIds, viewerUserId, contexts),
      recentMessages,
      serverTime: new Date().toISOString(),
    };
  }

  /** An enabled game with its enabled stakes, smallest first. */
  async requireGame(gameCode: string) {
    const game = await this.prisma.game.findUnique({
      where: { code: gameCode },
      include: { modes: { where: { enabled: true }, orderBy: { stakeAmountMinor: 'asc' } } },
    });
    if (!game)
      throw new NotFoundException({ code: 'LOBBY_INVALID_GAME', message: 'Game does not exist.' });
    if (!game.enabled || game.modes.length === 0) {
      throw new BadRequestException({
        code: 'LOBBY_MODE_DISABLED',
        message: 'This game has no open rooms.',
      });
    }
    for (const mode of game.modes) this.rooms?.remember(mode.id, game.id);
    return game;
  }

  /** Sit at a stake as ONLINE, leaving any other stake. */
  private async enter(
    userId: string,
    gameModeId: string,
  ): Promise<{ previousGameModeId?: string; player: LobbyPlayerView }> {
    await this.assertMode(gameModeId);
    await this.assertUsersActive([userId]);

    const previous = await this.getContext(userId);
    if (previous && previous.gameModeId !== gameModeId) await this.leave(userId);

    const context: LobbyUserContext = {
      gameModeId,
      state: 'ONLINE',
      joinedAt: new Date().toISOString(),
    };
    await this.redis
      .raw()
      .multi()
      .sAdd(this.onlineKey(gameModeId), userId)
      .expire(this.onlineKey(gameModeId), LOBBY_TTL_SECONDS)
      .set(this.userKey(userId), JSON.stringify(context), { EX: LOBBY_TTL_SECONDS })
      .exec();

    // Room-broadcast player view must be viewer-neutral (no isSelf).
    const [player] = await this.playerViews([userId]);
    return { previousGameModeId: previous?.gameModeId, player };
  }

  async activeMatchForUser(userId: string) {
    const participant = await this.prisma.matchParticipant.findFirst({
      where: { userId, match: { status: { in: RECOVERABLE_MATCH_STATUSES } } },
      include: {
        match: {
          include: {
            game: true,
            gameMode: true,
            participants: {
              include: { user: { select: { id: true, fullName: true } } },
              orderBy: { seat: 'asc' },
            },
          },
        },
      },
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

  async ready(userId: string): Promise<{ gameModeId: string; player: LobbyPlayerView }> {
    const context = await this.requireContext(userId);
    if (context.state === 'READY')
      throw new ConflictException({
        code: 'LOBBY_ALREADY_READY',
        message: 'You are already ready.',
      });
    if (context.state !== 'ONLINE')
      throw new ConflictException({
        code: 'LOBBY_USER_BUSY',
        message: 'You cannot ready while busy.',
      });
    await this.assertCanPlay([userId], context.gameModeId);

    const readyAt = new Date().toISOString();
    const next: LobbyUserContext = { ...context, state: 'READY', readyAt };
    await this.redis
      .raw()
      .multi()
      .zAdd(this.readyKey(context.gameModeId), [{ score: Date.parse(readyAt), value: userId }])
      .expire(this.readyKey(context.gameModeId), LOBBY_TTL_SECONDS)
      .set(this.userKey(userId), JSON.stringify(next), { EX: LOBBY_TTL_SECONDS })
      .exec();
    const [player] = await this.playerViews([userId]);
    return { gameModeId: context.gameModeId, player };
  }

  async unready(userId: string): Promise<{ gameModeId: string; player: LobbyPlayerView }> {
    const context = await this.requireContext(userId);
    if (context.state === 'CHALLENGED')
      throw new ConflictException({ code: 'LOBBY_USER_BUSY', message: 'Resolve challenge first.' });
    if (context.state !== 'READY')
      throw new ConflictException({ code: 'LOBBY_NOT_READY', message: 'You are not ready.' });
    const next: LobbyUserContext = {
      gameModeId: context.gameModeId,
      state: 'ONLINE',
      joinedAt: context.joinedAt,
    };
    await this.redis
      .raw()
      .multi()
      .zRem(this.readyKey(context.gameModeId), userId)
      .set(this.userKey(userId), JSON.stringify(next), { EX: LOBBY_TTL_SECONDS })
      .exec();
    const [player] = await this.playerViews([userId]);
    return { gameModeId: context.gameModeId, player };
  }

  async leave(userId: string): Promise<{ gameModeId?: string; player?: LobbyPlayerView }> {
    const context = await this.getContext(userId);
    if (!context) return {};
    const [player] = await this.playerViews([userId]);
    await this.redis
      .raw()
      .multi()
      .sRem(this.onlineKey(context.gameModeId), userId)
      .zRem(this.readyKey(context.gameModeId), userId)
      .del(this.userKey(userId))
      .exec();
    return { gameModeId: context.gameModeId, player };
  }

  async snapshot(
    viewerUserId: string,
    gameModeId: string,
    recentMessages: unknown[] = [],
  ): Promise<LobbySnapshot> {
    const mode = await this.assertMode(gameModeId);
    const [onlineIds, readyIds] = await Promise.all([
      this.redis.raw().sMembers(this.onlineKey(gameModeId)),
      this.redis.raw().zRange(this.readyKey(gameModeId), 0, this.snapshotLimit - 1),
    ]);
    const ids = [...new Set([...readyIds, ...onlineIds])].slice(0, this.snapshotLimit);
    const contexts = await this.getContexts(ids);

    const staleIds = ids.filter((id) => contexts.get(id)?.gameModeId !== gameModeId);
    if (staleIds.length > 0) {
      await this.redis
        .raw()
        .multi()
        .sRem(this.onlineKey(gameModeId), staleIds)
        .zRem(this.readyKey(gameModeId), staleIds)
        .exec();
    }

    const liveIds = ids.filter((id) => !staleIds.includes(id));
    const players = await this.playerViews(liveIds, viewerUserId, contexts);
    const myContext = contexts.get(viewerUserId) ?? (await this.getContext(viewerUserId));
    return {
      gameMode: {
        id: mode.id,
        code: mode.code,
        name: mode.name,
        stakeAmountMinor: mode.stakeAmountMinor.toString(),
        currency: 'ETB',
      },
      myState: myContext?.gameModeId === gameModeId ? myContext.state : 'ONLINE',
      players,
      recentMessages,
      serverTime: new Date().toISOString(),
    };
  }

  /**
   * Viewer-specific views when `viewerUserId` is given; viewer-neutral (no
   * isSelf) otherwise. Users without a lobby context are skipped.
   */
  async playerViews(
    userIds: string[],
    viewerUserId?: string,
    knownContexts?: Map<string, LobbyUserContext>,
  ): Promise<LobbyPlayerView[]> {
    if (userIds.length === 0) return [];
    const contexts = knownContexts ?? (await this.getContexts(userIds));
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, fullName: true },
    });
    const nameById = new Map(users.map((user) => [user.id, user.fullName]));
    const views: LobbyPlayerView[] = [];
    for (const userId of userIds) {
      const context = contexts.get(userId);
      if (!context) continue;
      views.push({
        userId,
        displayName: nameById.get(userId) ?? 'Player',
        gameModeId: context.gameModeId,
        state: context.state,
        ...(context.readyAt ? { readyAt: context.readyAt } : {}),
        ...(viewerUserId === userId ? { isSelf: true } : {}),
      });
    }
    return views;
  }

  /**
   * Single eligibility rule for entering a paid pairing: active account, mode
   * enabled, enough available balance, and no open/active match commitment.
   */
  async assertCanPlay(userIds: string[], gameModeId: string) {
    const mode = await this.assertMode(gameModeId);
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, status: true, wallet: { select: { availableBalance: true } } },
    });
    if (
      users.length !== new Set(userIds).size ||
      users.some((user) => user.status !== UserStatus.ACTIVE)
    ) {
      throw new ConflictException({
        code: 'PLAYER_NOT_ELIGIBLE',
        message: 'Player is not active.',
      });
    }
    if (users.some((user) => (user.wallet?.availableBalance ?? 0n) < mode.stakeAmountMinor)) {
      throw new ConflictException({
        code: 'INSUFFICIENT_BALANCE_FOR_MATCH',
        message: 'Available wallet balance is below the game stake.',
      });
    }
    const committed = await this.prisma.matchParticipant.findFirst({
      where: { userId: { in: userIds }, match: { status: { in: COMMITTED_MATCH_STATUSES } } },
      select: { userId: true },
    });
    if (committed) {
      throw new ConflictException({
        code: 'LOBBY_ACTIVE_MATCH',
        message: 'Player is already in a match.',
      });
    }
    return mode;
  }

  /** Refresh lobby Redis TTLs while the socket stays connected (reuses presence heartbeat). */
  async touch(userId: string): Promise<void> {
    const context = await this.getContext(userId);
    if (!context) return;
    const tx = this.redis
      .raw()
      .multi()
      .expire(this.userKey(userId), LOBBY_TTL_SECONDS)
      .expire(this.onlineKey(context.gameModeId), LOBBY_TTL_SECONDS);
    if (context.state === 'READY') tx.expire(this.readyKey(context.gameModeId), LOBBY_TTL_SECONDS);
    await tx.exec();
  }

  async getContext(userId: string): Promise<LobbyUserContext | null> {
    return this.redis.getJson<LobbyUserContext>(this.userKey(userId));
  }

  async requireContext(userId: string): Promise<LobbyUserContext> {
    const context = await this.getContext(userId);
    if (!context)
      throw new ConflictException({ code: 'LOBBY_NOT_JOINED', message: 'Join a lobby first.' });
    return context;
  }

  private async getContexts(userIds: string[]): Promise<Map<string, LobbyUserContext>> {
    if (userIds.length === 0) return new Map();
    const raw = await this.redis.raw().mGet(userIds.map((id) => this.userKey(id)));
    const contexts = new Map<string, LobbyUserContext>();
    userIds.forEach((id, index) => {
      const value = raw[index];
      if (typeof value === 'string') contexts.set(id, JSON.parse(value) as LobbyUserContext);
    });
    return contexts;
  }

  private async assertMode(gameModeId: string) {
    const mode = await this.prisma.gameMode.findUnique({
      where: { id: gameModeId },
      include: { game: true },
    });
    if (!mode)
      throw new NotFoundException({
        code: 'LOBBY_INVALID_MODE',
        message: 'Lobby mode does not exist.',
      });
    if (mode.gameId) this.rooms?.remember(mode.id, mode.gameId);
    if (!mode.enabled || !mode.game.enabled)
      throw new BadRequestException({
        code: 'LOBBY_MODE_DISABLED',
        message: 'Lobby mode is disabled.',
      });
    return mode;
  }

  private async assertUsersActive(userIds: string[]): Promise<void> {
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { status: true },
    });
    if (
      users.length !== userIds.length ||
      users.some((user) => user.status !== UserStatus.ACTIVE)
    ) {
      throw new BadRequestException({
        code: 'PLAYER_NOT_ELIGIBLE',
        message: 'Player is not eligible.',
      });
    }
  }

  private onlineKey(gameModeId: string): string {
    return this.redis.key('lobby', gameModeId, 'online');
  }
  private readyKey(gameModeId: string): string {
    return this.redis.key('lobby', gameModeId, 'ready');
  }
  private userKey(userId: string): string {
    return this.redis.key('lobby', 'user', userId);
  }
}
