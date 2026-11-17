import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const REFRESH_MS = 5 * 60 * 1000;

/**
 * Socket rooms of the lobby. A player sits at one stake (a game mode) and is
 * in that stake's room; clients that show a whole game at once (every stake,
 * with filters) join the game's room instead. Every lobby broadcast goes to
 * both, so each kind of client sees the changes it shows.
 *
 * Which game a stake belongs to is needed synchronously when broadcasting,
 * so the (tiny, rarely changing) mode → game map is kept in memory.
 */
@Injectable()
export class LobbyRooms implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(LobbyRooms.name);
  private gameByMode = new Map<string, string>();
  private timer?: NodeJS.Timeout;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh(): Promise<void> {
    try {
      const modes = await this.prisma.gameMode.findMany({ select: { id: true, gameId: true } });
      this.gameByMode = new Map(modes.map((mode) => [mode.id, mode.gameId]));
    } catch (error) {
      this.logger.warn(`lobby_rooms_refresh_failed reason=${(error as Error).message}`);
    }
  }

  /** Called when a stake is looked up anyway, so a new stake is known at once. */
  remember(gameModeId: string, gameId: string): void {
    this.gameByMode.set(gameModeId, gameId);
  }

  stakeRoom(gameModeId: string): string {
    return `lobby:${gameModeId}`;
  }

  gameRoom(gameId: string): string {
    return `lobby-game:${gameId}`;
  }

  /** Everyone who should see a change at this stake. */
  roomsFor(gameModeId: string): string[] {
    const gameId = this.gameByMode.get(gameModeId);
    if (!gameId) void this.refresh();
    return gameId
      ? [this.stakeRoom(gameModeId), this.gameRoom(gameId)]
      : [this.stakeRoom(gameModeId)];
  }
}
