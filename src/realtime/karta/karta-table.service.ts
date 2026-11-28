import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { COMMITTED_MATCH_STATUSES } from '../../common/match-status';
import { KARTA_TABLE_V1, KartaMatchRuntimeState } from '../../games/karta';
import { isKartaTable } from '../../gaming/player-counts';
import { MatchStatus } from '../../generated/prisma/enums';
import { LobbyService } from '../../lobby/lobby.service';
import { MatchCreationService } from '../../match-creation/match-creation.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { SettlementService } from '../../settlement/settlement.service';
import { PresenceService } from '../presence.service';
import { RealtimePublisherService } from '../realtime-publisher.service';
import { KartaRuntimeService, KartaTurnTimerService } from './karta.game';
import {
  KartaTable,
  afterRound,
  freeSeats,
  inRound,
  nextRoundSeats,
  seatedIds,
  withoutPlayer,
} from './karta-table.rules';

/** Pause after a round so everyone sees who won before the next one starts. */
const ROUND_PAUSE_MS = 3500;
/** Tables live while they are used; every change refreshes this. */
const TABLE_TTL_SECONDS = 60 * 60;
const TICK_MS = 1000;
/** Every this many ticks, look for rounds whose match was cancelled. */
const RECOVER_EVERY_TICKS = 10;
const LOCK_WAIT_MS = 2000;

type MatchSummary = {
  id: string;
  rulesVersion?: string;
  gameId?: string;
  gameModeId?: string;
  stakeAmountMinor?: string;
  platformFeeBps?: number;
  participants?: Array<{ userId: string; seat: number }>;
  gameMode?: { playerCount?: number } & Record<string, unknown>;
} & Record<string, unknown>;

/** What players and the lobby see of a table. */
export type KartaTableView = Omit<KartaTable, 'leaving'> & {
  players: Array<{ userId: string; fullName: string }>;
  freeSeats: number;
};

/**
 * Karta queue tables (KARTA_TABLE_V1): seats up to four players and chains
 * their rounds. Each round is an ordinary 1v1 Karta match (stake locked when
 * it is created, settled when it ends), so money uses the same, proven path
 * as every other match. This service only decides who plays next.
 *
 * State lives in Redis; every change runs under the table's lock, and the
 * next round's match uses a unique matchmaking key, so it is never created
 * twice even if two servers try at once.
 */
@Injectable()
export class KartaTableService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KartaTableService.name);
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private ticks = 0;
  private unsubscribe?: () => void;

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly lobby: LobbyService,
    private readonly matchCreation: MatchCreationService,
    private readonly settlement: SettlementService,
    private readonly presence: PresenceService,
    private readonly publisher: RealtimePublisherService,
    private readonly runtime: KartaRuntimeService,
    private readonly turnTimer: KartaTurnTimerService,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.runtime.onExecuted((state) => {
      if (state.game.rulesVersion === KARTA_TABLE_V1 && state.game.phase === 'FINISHED') {
        void this.onRoundFinished(state).catch((error: Error) =>
          this.logger.warn(`round_end_failed match=${state.game.matchId} ${error.message}`),
        );
      }
    });
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
  }

  isTableMatch(match: Record<string, unknown>): boolean {
    return typeof match.rulesVersion === 'string' && isKartaTable(match.rulesVersion);
  }

  /** The first round started from the lobby (a 1v1 pairing): open its table. */
  async open(summary: { id: string } & Record<string, unknown>): Promise<KartaTable | null> {
    const match = summary as MatchSummary;
    if (!this.isTableMatch(match)) return null;
    const existing = await this.redis.raw().get(this.matchKey(match.id));
    if (existing) return this.get(existing);
    const seats = [...(match.participants ?? [])].sort((a, b) => a.seat - b.seat);
    if (seats.length !== 2 || !match.gameModeId || !match.gameId) return null;

    const table: KartaTable = {
      id: randomUUID(),
      gameId: match.gameId,
      gameModeId: match.gameModeId,
      stakeMinor: String(match.stakeAmountMinor ?? '0'),
      platformFeeBps: match.platformFeeBps ?? 0,
      maxSeats: Math.min(4, Math.max(2, Number(match.gameMode?.playerCount ?? 4))),
      starterId: seats[0].userId, // seat 0 deals the first round
      receiverId: seats[1].userId,
      queue: [],
      round: 1,
      matchId: match.id,
      status: 'PLAYING',
      nextAt: null,
      raise: null,
      last: null,
      leaving: [],
      createdAt: new Date().toISOString(),
    };
    await this.save(table);
    await this.redis.raw().set(this.matchKey(match.id), table.id, { EX: TABLE_TTL_SECONDS });
    this.logger.log(`table_opened table=${table.id} match=${match.id}`);
    await this.broadcast(table);
    return table;
  }

  /** The table the player sits at (recovery after a restart or reconnect). */
  async mine(userId: string): Promise<KartaTableView | null> {
    const tableId = await this.redis.raw().get(this.userKey(userId));
    const table = tableId ? await this.get(tableId) : null;
    return table && table.status !== 'CLOSED' ? this.view(table) : null;
  }

  async tableIdOfMatch(matchId: string): Promise<string | null> {
    return this.redis.raw().get(this.matchKey(matchId));
  }

  /** Watching: anyone seated at the table that plays this match. */
  async canWatch(matchId: string, userId: string): Promise<boolean> {
    const tableId = await this.tableIdOfMatch(matchId);
    if (!tableId) return false;
    const table = await this.get(tableId);
    return Boolean(table && seatedIds(table).includes(userId));
  }

  /** Tables of these stakes with a free seat, for the lobby. */
  async openTables(gameModeIds: string[]): Promise<KartaTableView[]> {
    const views: KartaTableView[] = [];
    for (const gameModeId of gameModeIds) {
      const ids = await this.redis.raw().zRange(this.openKey(gameModeId), 0, 19);
      for (const id of ids) {
        const table = await this.get(id);
        if (table && freeSeats(table) > 0) views.push(await this.view(table));
        else await this.redis.raw().zRem(this.openKey(gameModeId), id);
      }
    }
    return views;
  }

  /** Join the back of the queue (mid-game is fine) while a seat is free. */
  async join(userId: string, tableId: string): Promise<KartaTableView> {
    return this.locked(tableId, async () => {
      const table = await this.require(tableId);
      if (seatedIds(table).includes(userId)) return this.view(table);
      if (freeSeats(table) <= 0)
        throw new ConflictException({ code: 'TABLE_FULL', message: 'This table is full.' });
      await this.assertFree(userId, BigInt(table.stakeMinor));

      const next = { ...table, queue: [...table.queue, userId] };
      await this.save(next);
      const left = await this.lobby.leave(userId);
      if (left.gameModeId)
        this.publisher.publishLobby(left.gameModeId, 'lobby:player_left', { player: { userId } });
      this.logger.log(`table_joined table=${table.id} user=${userId}`);
      await this.broadcast(next);
      return this.view(next);
    });
  }

  /**
   * "I'm ready" at a table stake: sit at the longest-open table with a free
   * seat. Null when there is none (the normal 1v1 pairing then opens one).
   */
  async seatReady(userId: string): Promise<KartaTableView | null> {
    const context = await this.lobby.getContext(userId);
    if (!context || context.state !== 'READY') return null;
    const ids = await this.redis.raw().zRange(this.openKey(context.gameModeId), 0, 19);
    for (const id of ids) {
      try {
        return await this.join(userId, id);
      } catch {
        continue; // full or closed meanwhile, or I can't cover its (raised) stake
      }
    }
    return null;
  }

  /**
   * Leave the table. Waiting: out at once, nothing to pay. Playing a round:
   * that round is resigned (its stake is lost) and the player is not seated
   * again.
   */
  async leave(userId: string): Promise<void> {
    const tableId = await this.redis.raw().get(this.userKey(userId));
    if (!tableId) return;
    let resignMatchId: string | null = null;
    await this.locked(tableId, async () => {
      const table = await this.get(tableId);
      if (!table || !seatedIds(table).includes(userId)) {
        await this.redis.raw().del(this.userKey(userId));
        return;
      }
      if (inRound(table, userId) && table.matchId) {
        resignMatchId = table.matchId;
        await this.save({ ...table, leaving: [...new Set([...table.leaving, userId])] });
        return;
      }
      const next = withoutPlayer(table, userId);
      await this.redis.raw().del(this.userKey(userId));
      await this.save(next);
      await this.broadcast(next);
      if (next.status === 'CLOSED') await this.close(next);
    });
    // Outside the lock: the round's end comes back through onRoundFinished.
    if (resignMatchId) await this.turnTimer.forfeitAbsent(resignMatchId, userId);
  }

  /** One player of the round in play asks to raise the stake from the next round. */
  async proposeRaise(userId: string, amountMinor: number): Promise<KartaTableView> {
    const tableId = await this.requireSeat(userId);
    return this.locked(tableId, async () => {
      const table = await this.require(tableId);
      if (!inRound(table, userId))
        throw new ForbiddenException({
          code: 'TABLE_NOT_IN_ROUND',
          message: 'Only the two players of this round can raise the stake.',
        });
      const amount = BigInt(amountMinor);
      if (!(await this.raiseAllowed(table, amount)))
        throw new ConflictException({
          code: 'TABLE_RAISE_INVALID',
          message: 'Choose one of the higher stakes.',
        });
      const next = { ...table, raise: { amountMinor: amount.toString(), byUserId: userId } };
      await this.save(next);
      await this.broadcast(next);
      return this.view(next);
    });
  }

  /** The other player answers; yes = the new stake applies from the next round. */
  async answerRaise(userId: string, accept: boolean): Promise<KartaTableView> {
    const tableId = await this.requireSeat(userId);
    return this.locked(tableId, async () => {
      const table = await this.require(tableId);
      if (!table.raise || table.raise.byUserId === userId || !inRound(table, userId))
        throw new ConflictException({ code: 'TABLE_NO_RAISE', message: 'Nothing to answer.' });
      const next = {
        ...table,
        stakeMinor: accept ? table.raise.amountMinor : table.stakeMinor,
        raise: null,
      };
      await this.save(next);
      await this.broadcast(next);
      return this.view(next);
    });
  }

  /** A round's match ended: pay it (idempotent), rotate the seats, pause. */
  async onRoundFinished(state: KartaMatchRuntimeState): Promise<void> {
    const matchId = state.game.matchId;
    const tableId = await this.tableIdOfMatch(matchId);
    if (!tableId) return;
    const [winnerId, loserId] = state.game.winnerOrder;
    await this.ensureSettled(matchId, state.game.winnerOrder);
    const settled = await this.prisma.matchSettlement.findUnique({
      where: { matchId },
      select: { payoutAmountMinor: true },
    });

    await this.locked(tableId, async () => {
      const table = await this.get(tableId);
      if (!table || table.matchId !== matchId || table.status !== 'PLAYING') return; // done already
      const leaving =
        state.game.finishReason === 'RESIGN' ? [...table.leaving, loserId] : table.leaving;
      const next = afterRound(
        { ...table, leaving },
        winnerId,
        loserId,
        (settled?.payoutAmountMinor ?? 0n).toString(),
        Date.now(),
        ROUND_PAUSE_MS,
      );
      if (leaving.includes(loserId)) await this.redis.raw().del(this.userKey(loserId));
      await this.save(next);
      await this.redis.raw().zAdd(this.betweenKey(), [{ score: next.nextAt!, value: table.id }]);
      this.logger.log(`table_round_won table=${table.id} round=${table.round} winner=${winnerId}`);
      await this.broadcast(next);
    });
  }

  /** Start every table whose pause is over. Runs every second on each server. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const due = await this.redis.raw().zRangeByScore(this.betweenKey(), 0, Date.now(), {
        LIMIT: { offset: 0, count: 20 },
      });
      for (const tableId of due) {
        await this.startNextRound(tableId).catch((error: Error) =>
          this.logger.warn(`table_next_round_failed table=${tableId} ${error.message}`),
        );
      }
      if (++this.ticks % RECOVER_EVERY_TICKS === 0) await this.recoverCancelledRounds();
    } finally {
      this.ticking = false;
    }
  }

  /**
   * A round whose match was cancelled before anyone played (e.g. a player
   * never opened it; the stakes were refunded) is played again: same seats,
   * after the usual pause, which also drops anyone no longer connected.
   */
  private async recoverCancelledRounds(): Promise<void> {
    const ids = await this.redis.raw().zRange(this.playingKey(), 0, 49);
    for (const tableId of ids) {
      const table = await this.get(tableId);
      if (!table || table.status !== 'PLAYING' || !table.matchId) {
        await this.redis.raw().zRem(this.playingKey(), tableId);
        continue;
      }
      const match = await this.prisma.match.findUnique({
        where: { id: table.matchId },
        select: { status: true },
      });
      if (match?.status !== MatchStatus.CANCELLED && match?.status !== MatchStatus.ABORTED)
        continue;
      await this.locked(tableId, async () => {
        const current = await this.get(tableId);
        if (!current || current.matchId !== table.matchId || current.status !== 'PLAYING') return;
        const next: KartaTable = {
          ...current,
          receiverId: null,
          queue: current.receiverId ? [current.receiverId, ...current.queue] : current.queue,
          round: current.round - 1, // the next round takes its number again
          matchId: null,
          status: 'BETWEEN',
          nextAt: Date.now() + ROUND_PAUSE_MS,
          raise: null,
        };
        await this.save(next);
        await this.redis.raw().zAdd(this.betweenKey(), [{ score: next.nextAt!, value: tableId }]);
        this.logger.warn(`table_round_cancelled table=${tableId} match=${table.matchId}`);
        await this.broadcast(next);
      });
    }
  }

  /** Seat the next round and create its match (stakes locked). */
  async startNextRound(tableId: string): Promise<void> {
    await this.locked(tableId, async () => {
      const table = await this.get(tableId);
      if (!table || table.status !== 'BETWEEN' || (table.nextAt ?? 0) > Date.now()) {
        if (!table || table.status !== 'BETWEEN')
          await this.redis.raw().zRem(this.betweenKey(), tableId);
        return;
      }

      // Who can play the next round: connected, able to cover the stake, free.
      const stake = BigInt(table.stakeMinor);
      const order = [table.starterId, ...table.queue];
      const reasons = new Map<string, string>();
      for (const userId of order) {
        const reason = await this.cannotPlay(userId, stake);
        if (reason) reasons.set(userId, reason);
      }
      const seats = nextRoundSeats(table, (id) => !reasons.has(id));
      for (const [userId, reason] of reasons) {
        await this.redis.raw().del(this.userKey(userId));
        this.publisher.publishUser(userId, 'karta:table:removed', { tableId, reason });
      }
      if (!seats) {
        await this.close({ ...table, queue: table.queue.filter((id) => !reasons.has(id)) });
        return;
      }

      const round = table.round + 1;
      const match = (await this.matchCreation.createSecuredMatch({
        gameModeId: table.gameModeId,
        playerIds: [seats.starterId, seats.receiverId],
        matchmakingKey: `karta-table:${table.id}:${round}`,
        source: 'CHALLENGE',
        stakeAmountMinor: stake,
      })) as MatchSummary;

      const next: KartaTable = {
        ...table,
        starterId: seats.starterId,
        receiverId: seats.receiverId,
        queue: seats.queue,
        round,
        matchId: match.id,
        status: 'PLAYING',
        nextAt: null,
      };
      await this.save(next);
      await this.redis.raw().set(this.matchKey(match.id), table.id, { EX: TABLE_TTL_SECONDS });
      await this.redis.raw().zRem(this.betweenKey(), tableId);
      for (const userId of [seats.starterId, seats.receiverId])
        this.publisher.publishUser(userId, 'match:ready', { match }, match.id);
      this.logger.log(`table_round_started table=${table.id} round=${round} match=${match.id}`);
      await this.broadcast(next);
    });
  }

  private async close(table: KartaTable): Promise<void> {
    const closed: KartaTable = { ...table, status: 'CLOSED', matchId: null, receiverId: null };
    for (const userId of seatedIds(table)) {
      await this.redis.raw().del(this.userKey(userId));
      this.publisher.publishUser(userId, 'karta:table:closed', { tableId: table.id });
    }
    await this.redis
      .raw()
      .multi()
      .set(this.tableKey(table.id), JSON.stringify(closed), { EX: 300 })
      .zRem(this.openKey(table.gameModeId), table.id)
      .zRem(this.betweenKey(), table.id)
      .zRem(this.playingKey(), table.id)
      .exec();
    this.publisher.publishLobby(table.gameModeId, 'lobby:table', {
      table: { id: table.id, status: 'CLOSED' },
    });
    this.logger.log(`table_closed table=${table.id}`);
  }

  /** Why [userId] cannot play the next round, or null. */
  private async cannotPlay(userId: string, stake: bigint): Promise<string | null> {
    if (!(await this.presence.isOnline(userId))) return 'OFFLINE';
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId },
      select: { availableBalance: true },
    });
    if ((wallet?.availableBalance ?? 0n) < stake) return 'INSUFFICIENT_BALANCE';
    return null;
  }

  /** Not seated at a table, not in a match, able to cover [stake]. */
  private async assertFree(userId: string, stake: bigint): Promise<void> {
    if (await this.redis.raw().exists(this.userKey(userId)))
      throw new ConflictException({ code: 'TABLE_ALREADY_SEATED', message: 'You are at a table.' });
    const committed = await this.prisma.matchParticipant.findFirst({
      where: { userId, match: { status: { in: COMMITTED_MATCH_STATUSES } } },
      select: { matchId: true },
    });
    if (committed)
      throw new ConflictException({
        code: 'LOBBY_ACTIVE_MATCH',
        message: 'Finish your match first.',
      });
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId },
      select: { availableBalance: true },
    });
    if ((wallet?.availableBalance ?? 0n) < stake)
      throw new ConflictException({
        code: 'INSUFFICIENT_BALANCE_FOR_MATCH',
        message: 'Available wallet balance is below the table stake.',
      });
  }

  /** A raise is one of this game's catalog stakes above the current one. */
  private async raiseAllowed(table: KartaTable, amount: bigint): Promise<boolean> {
    if (amount <= BigInt(table.stakeMinor)) return false;
    const listed = await this.prisma.gameMode.findFirst({
      where: { gameId: table.gameId, enabled: true, custom: false, stakeAmountMinor: amount },
      select: { id: true },
    });
    return Boolean(listed);
  }

  /** Settlement normally runs as the match ends; make sure before rotating. */
  private async ensureSettled(matchId: string, winnerOrder: string[]): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const match = await this.prisma.match.findUnique({
        where: { id: matchId },
        select: { status: true },
      });
      if (match?.status === MatchStatus.FINISHED) return;
      try {
        await this.settlement.settleMatchResult(matchId, winnerOrder);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 300)); // the live path is settling it
      }
    }
    throw new Error(`ROUND_NOT_SETTLED ${matchId}`);
  }

  private async view(table: KartaTable): Promise<KartaTableView> {
    const ids = seatedIds(table);
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, fullName: true },
    });
    const { leaving: _leaving, ...rest } = table;
    void _leaving;
    return {
      ...rest,
      players: ids.map((id) => ({
        userId: id,
        fullName: users.find((user) => user.id === id)?.fullName ?? 'Player',
      })),
      freeSeats: freeSeats(table),
    };
  }

  /** Every seated player gets the table; the lobby learns its free seats. */
  private async broadcast(table: KartaTable): Promise<void> {
    const view = await this.view(table);
    for (const userId of seatedIds(table))
      this.publisher.publishUser(userId, 'karta:table:state', view);
    this.publisher.publishLobby(table.gameModeId, 'lobby:table', { table: view });
  }

  private async save(table: KartaTable): Promise<void> {
    const tx = this.redis
      .raw()
      .multi()
      .set(this.tableKey(table.id), JSON.stringify(table), { EX: TABLE_TTL_SECONDS });
    for (const userId of seatedIds(table))
      tx.set(this.userKey(userId), table.id, { EX: TABLE_TTL_SECONDS });
    if (freeSeats(table) > 0)
      tx.zAdd(this.openKey(table.gameModeId), [
        { score: Date.parse(table.createdAt), value: table.id },
      ]);
    else tx.zRem(this.openKey(table.gameModeId), table.id);
    if (table.status === 'PLAYING')
      tx.zAdd(this.playingKey(), [{ score: Date.now(), value: table.id }]);
    else tx.zRem(this.playingKey(), table.id);
    await tx.exec();
  }

  private async get(tableId: string): Promise<KartaTable | null> {
    return this.redis.getJson<KartaTable>(this.tableKey(tableId));
  }

  private async require(tableId: string): Promise<KartaTable> {
    const table = await this.get(tableId);
    if (!table || table.status === 'CLOSED')
      throw new NotFoundException({ code: 'TABLE_NOT_FOUND', message: 'This table is closed.' });
    return table;
  }

  private async requireSeat(userId: string): Promise<string> {
    const tableId = await this.redis.raw().get(this.userKey(userId));
    if (!tableId)
      throw new NotFoundException({ code: 'TABLE_NOT_FOUND', message: 'You are not at a table.' });
    return tableId;
  }

  private locked<T>(tableId: string, action: () => Promise<T>): Promise<T> {
    return this.redis.withLock(this.lockKey(tableId), action, undefined, LOCK_WAIT_MS);
  }

  private tableKey(id: string): string {
    return this.redis.key('karta-table', id);
  }
  private lockKey(id: string): string {
    return this.redis.key('lock', 'karta-table', id);
  }
  private userKey(userId: string): string {
    return this.redis.key('karta-table', 'user', userId);
  }
  private matchKey(matchId: string): string {
    return this.redis.key('karta-table', 'match', matchId);
  }
  private openKey(gameModeId: string): string {
    return this.redis.key('karta-table', 'open', gameModeId);
  }
  private betweenKey(): string {
    return this.redis.key('karta-table', 'between');
  }
  private playingKey(): string {
    return this.redis.key('karta-table', 'playing');
  }
}
