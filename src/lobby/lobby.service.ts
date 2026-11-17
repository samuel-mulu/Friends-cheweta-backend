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
  CUSTOM_STAKE_MAX_MINOR,
  CUSTOM_STAKE_MIN_MINOR,
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
    customStakeMinor?: number,
  ): Promise<{
    gameId: string;
    gameModeId: string;
    previousGameModeId?: string;
    changed: boolean;
    snapshot: LobbyGameSnapshot;
    player: LobbyPlayerView;
  }> {
    const game = await this.requireGame(gameCode);
    let stakes = await this.stakesOf(game);
    if (customStakeMinor !== undefined) {
      const custom = await this.customStake(game, customStakeMinor, userId);
      gameModeId = custom.id;
      if (!stakes.some((stake) => stake.id === custom.id)) stakes = [...stakes, custom];
    } else if (gameModeId && !stakes.some((stake) => stake.id === gameModeId)) {
      // A custom stake nobody sits at any more (e.g. rejoining after a drop).
      const custom = await this.prisma.gameMode.findFirst({
        where: { id: gameModeId, gameId: game.id, enabled: true, custom: true },
      });
      if (!custom) {
        throw new NotFoundException({
          code: 'LOBBY_INVALID_MODE',
          message: 'This stake is not open.',
        });
      }
      stakes = [...stakes, custom];
    }
    const stakeIds = stakes.map((stake) => stake.id);
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
      const mode = stakes.find((stake) => stake.id === target);
      if (mode?.custom) await this.redis.raw().sAdd(this.customStakesKey(game.id), mode.id);
    } else {
      await this.assertUsersActive([userId]);
      await this.touch(userId);
    }
    const snapshot = await this.gameSnapshot(userId, game, stakes);
    const [player] = await this.playerViews([userId]);
    return { gameId: game.id, gameModeId: target, previousGameModeId, changed, snapshot, player };
  }

  /** Everyone at every stake of a game, for a lobby that shows them all. */
  async gameSnapshot(
    viewerUserId: string,
    game: Awaited<ReturnType<LobbyService['requireGame']>>,
    stakesOfGame?: Awaited<ReturnType<LobbyService['stakesOf']>>,
    recentMessages: unknown[] = [],
  ): Promise<LobbyGameSnapshot> {
    const modes = stakesOfGame ?? (await this.stakesOf(game));
    const perStake = await Promise.all(
      modes.map(async (mode) => {
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
      if (mode.custom && live.length === 0) {
        // Nobody sits at this custom stake any more: it leaves the lobby.
        await this.redis.raw().sRem(this.customStakesKey(game.id), mode.id);
        continue;
      }
      stakes.push({
        id: mode.id,
        code: mode.code,
        name: mode.name,
        stakeAmountMinor: mode.stakeAmountMinor.toString(),
        playerCount: mode.playerCount,
        platformFeeBps: mode.platformFeeBps,
        turnDurationSeconds: mode.turnDurationSeconds,
        rulesVersion: mode.rulesVersion,
        custom: mode.custom,
        onlineCount: live.length,
        readyCount: live.filter((id) => contexts.get(id)?.state === 'READY').length,
      });
    }

    const mine = contexts.get(viewerUserId);
    const inGame = mine && stakes.some((stake) => stake.id === mine.gameModeId);
    return {
      game: { id: game.id, code: game.code, name: game.name },
      stakes,
      gameModeId: inGame ? mine.gameModeId : stakes[0].id,
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
      include: {
        modes: { where: { enabled: true, custom: false }, orderBy: { stakeAmountMinor: 'asc' } },
      },
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

  /** Catalog stakes plus the custom stakes someone sits at, smallest first. */
  async stakesOf(game: Awaited<ReturnType<LobbyService['requireGame']>>) {
    const customIds = await this.redis.raw().sMembers(this.customStakesKey(game.id));
    const custom = customIds.length
      ? await this.prisma.gameMode.findMany({
          where: { id: { in: customIds }, gameId: game.id, enabled: true, custom: true },
        })
      : [];
    for (const mode of custom) this.rooms?.remember(mode.id, game.id);
    return [...game.modes, ...custom].sort((a, b) =>
      a.stakeAmountMinor < b.stakeAmountMinor
        ? -1
        : a.stakeAmountMinor > b.stakeAmountMinor
          ? 1
          : 0,
    );
  }

  /**
   * The stake for an amount a player typed: the catalog stake if one has that
   * amount, else a custom stake (created once, shared by everyone choosing
   * it), modelled on the game's smallest catalog stake. The player must hold
   * the amount.
   */
  private async customStake(
    game: Awaited<ReturnType<LobbyService['requireGame']>>,
    amountMinor: number,
    userId: string,
  ) {
    if (
      !Number.isInteger(amountMinor) ||
      amountMinor % 100 !== 0 ||
      amountMinor < CUSTOM_STAKE_MIN_MINOR ||
      amountMinor > CUSTOM_STAKE_MAX_MINOR
    ) {
      throw new BadRequestException({
        code: 'CUSTOM_STAKE_INVALID',
        message: `Choose a whole amount from ${CUSTOM_STAKE_MIN_MINOR / 100} to ${CUSTOM_STAKE_MAX_MINOR / 100} ETB.`,
      });
    }
    const amount = BigInt(amountMinor);
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId },
      select: { availableBalance: true },
    });
    if ((wallet?.availableBalance ?? 0n) < amount) {
      throw new ConflictException({
        code: 'INSUFFICIENT_BALANCE_FOR_MATCH',
        message: 'Available wallet balance is below the game stake.',
      });
    }
    const listed = game.modes.find((mode) => mode.stakeAmountMinor === amount);
    if (listed) return listed;

    const template = game.modes[0];
    const code = `${game.code}_CUSTOM_${amountMinor}`;
    const mode = await this.prisma.gameMode.upsert({
      where: { code },
      update: {},
      create: {
        gameId: game.id,
        code,
        name: `${game.name} 1v1 - ${amountMinor / 100} ETB`,
        playerCount: template.playerCount,
        stakeAmountMinor: amount,
        platformFeeBps: template.platformFeeBps,
        turnDurationSeconds: template.turnDurationSeconds,
        rulesVersion: template.rulesVersion,
        custom: true,
      },
    });
    if (!mode.enabled || !mode.custom) {
      throw new BadRequestException({
        code: 'LOBBY_MODE_DISABLED',
        message: 'This stake is not open.',
      });
    }
    this.rooms?.remember(mode.id, game.id);
    return mode;
  }

  /** Sit at a stake as ONLINE, leaving any other stake. */
  private async enter(
    userId: string,
    gameModeId: string,
  ): Promise<{ previousGameModeId?: string; player: LobbyPlayerView }> {
    const mode = await this.assertMode(gameModeId);
    await this.assertUsersActive([userId]);

    const previous = await this.getContext(userId);
    if (previous && previous.gameModeId !== gameModeId) await this.leave(userId);

    const context: LobbyUserContext = {
      gameModeId,
      stakeAmountMinor: mode.stakeAmountMinor.toString(),
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
      stakeAmountMinor: context.stakeAmountMinor,
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
        ...(context.stakeAmountMinor ? { stakeAmountMinor: context.stakeAmountMinor } : {}),
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

  /** Custom stakes of a game that someone sits at (cleaned when empty). */
  private customStakesKey(gameId: string): string {
    return this.redis.key('lobby', 'game', gameId, 'custom-stakes');
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
