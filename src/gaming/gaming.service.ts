import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { GameMode } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateGameModeDto } from './dto/create-game-mode.dto';
import { UpdateGameModeDto } from './dto/update-game-mode.dto';

@Injectable()
export class GamingService {
  constructor(private readonly prisma: PrismaService) {}

  async listGames() {
    const games = await this.prisma.game.findMany({
      where: { enabled: true },
      orderBy: { name: 'asc' },
    });
    return games;
  }

  async listAdminGames() {
    return this.prisma.game.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { modes: true, matches: true } } },
    });
  }

  async listAdminModes(gameCode: string) {
    const game = await this.prisma.game.findUnique({ where: { code: gameCode.toUpperCase() } });
    if (!game) {
      throw new NotFoundException({ code: 'GAME_NOT_FOUND', message: 'Game not found.' });
    }

    const modes = await this.prisma.gameMode.findMany({
      where: { gameId: game.id },
      orderBy: [{ stakeAmountMinor: 'asc' }, { playerCount: 'asc' }],
    });
    return modes.map((mode) => this.serializeMode(mode));
  }

  async listModes(gameCode: string) {
    const game = await this.prisma.game.findUnique({ where: { code: gameCode.toUpperCase() } });
    if (!game || !game.enabled) {
      throw new NotFoundException({ code: 'GAME_NOT_FOUND', message: 'Game not found.' });
    }

    const modes = await this.prisma.gameMode.findMany({
      where: { gameId: game.id, enabled: true },
      orderBy: [{ stakeAmountMinor: 'asc' }, { playerCount: 'asc' }],
    });
    return modes.map((mode) => this.serializeMode(mode));
  }

  async createMode(dto: CreateGameModeDto) {
    const game = await this.prisma.game.findUnique({ where: { code: dto.gameCode.toUpperCase() } });
    if (!game) throw new NotFoundException({ code: 'GAME_NOT_FOUND', message: 'Game not found.' });

    const existing = await this.prisma.gameMode.findUnique({
      where: { code: dto.code.toUpperCase() },
    });
    if (existing) {
      throw new ConflictException({
        code: 'GAME_MODE_CODE_EXISTS',
        message: 'Game mode code already exists.',
      });
    }

    const mode = await this.prisma.gameMode.create({
      data: {
        gameId: game.id,
        code: dto.code.toUpperCase(),
        name: dto.name.trim(),
        playerCount: dto.playerCount,
        stakeAmountMinor: BigInt(dto.stakeAmountMinor),
        platformFeeBps: dto.platformFeeBps,
        turnDurationSeconds: dto.turnDurationSeconds,
        rulesVersion: dto.rulesVersion.trim(),
        enabled: dto.enabled ?? true,
      },
    });
    return this.serializeMode(mode);
  }

  async updateMode(id: string, dto: UpdateGameModeDto) {
    const existing = await this.prisma.gameMode.findUnique({ where: { id } });
    if (!existing)
      throw new NotFoundException({ code: 'GAME_MODE_NOT_FOUND', message: 'Game mode not found.' });

    const mode = await this.prisma.gameMode.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.stakeAmountMinor !== undefined
          ? { stakeAmountMinor: BigInt(dto.stakeAmountMinor) }
          : {}),
        ...(dto.platformFeeBps !== undefined ? { platformFeeBps: dto.platformFeeBps } : {}),
        ...(dto.turnDurationSeconds !== undefined
          ? { turnDurationSeconds: dto.turnDurationSeconds }
          : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      },
    });
    return this.serializeMode(mode);
  }

  private serializeMode(mode: GameMode) {
    return { ...mode, stakeAmountMinor: mode.stakeAmountMinor.toString() };
  }
}
