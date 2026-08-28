import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { MatchStatus } from '../generated/prisma/enums';
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

    const existing = await this.prisma.gameMode.findUnique({ where: { code: dto.code.toUpperCase() } });
    if (existing) {
      throw new ConflictException({ code: 'GAME_MODE_CODE_EXISTS', message: 'Game mode code already exists.' });
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
    if (!existing) throw new NotFoundException({ code: 'GAME_MODE_NOT_FOUND', message: 'Game mode not found.' });

    const mode = await this.prisma.gameMode.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.stakeAmountMinor !== undefined ? { stakeAmountMinor: BigInt(dto.stakeAmountMinor) } : {}),
        ...(dto.platformFeeBps !== undefined ? { platformFeeBps: dto.platformFeeBps } : {}),
        ...(dto.turnDurationSeconds !== undefined ? { turnDurationSeconds: dto.turnDurationSeconds } : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      },
    });
    return this.serializeMode(mode);
  }

  async createMatch(gameModeId: string, userIds: string[]) {
    const mode = await this.prisma.gameMode.findUnique({
      where: { id: gameModeId },
      include: { game: true },
    });
    if (!mode || !mode.enabled || !mode.game.enabled) {
      throw new NotFoundException({ code: 'GAME_MODE_NOT_AVAILABLE', message: 'Game mode is not available.' });
    }
    if (userIds.length !== mode.playerCount || new Set(userIds).size !== userIds.length) {
      throw new ConflictException({
        code: 'INVALID_MATCH_PARTICIPANTS',
        message: `This mode requires exactly ${mode.playerCount} unique players.`,
      });
    }

    return this.prisma.match.create({
      data: {
        gameId: mode.gameId,
        gameModeId: mode.id,
        status: MatchStatus.CREATED,
        rulesVersion: mode.rulesVersion,
        stakeAmountMinor: mode.stakeAmountMinor,
        platformFeeBps: mode.platformFeeBps,
        participants: {
          create: userIds.map((userId, index) => ({ userId, seat: index })),
        },
      },
      include: { game: true, gameMode: true, participants: true },
    });
  }

  async createMatchedMatch(gameModeId: string, userIds: string[], matchmakingKey: string) {
    const existing = await this.prisma.match.findUnique({
      where: { matchmakingKey },
      include: { game: true, gameMode: true, participants: true },
    });
    if (existing) return this.serializeMatch(existing);

    const mode = await this.prisma.gameMode.findUnique({
      where: { id: gameModeId },
      include: { game: true },
    });
    if (!mode || !mode.enabled || !mode.game.enabled) {
      throw new NotFoundException({ code: 'GAME_MODE_NOT_AVAILABLE', message: 'Game mode is not available.' });
    }
    if (mode.game.code !== 'LUDO' || mode.playerCount !== 2) {
      throw new ConflictException({
        code: 'MATCHMAKING_MODE_NOT_SUPPORTED',
        message: 'B13 matchmaking currently supports Ludo 1v1 modes only.',
      });
    }
    if (userIds.length !== 2 || new Set(userIds).size !== 2) {
      throw new ConflictException({
        code: 'INVALID_MATCH_PARTICIPANTS',
        message: 'Ludo 1v1 matchmaking requires exactly two unique players.',
      });
    }

    try {
      const match = await this.prisma.match.create({
        data: {
          gameId: mode.gameId,
          gameModeId: mode.id,
          matchmakingKey,
          status: MatchStatus.CREATED,
          rulesVersion: mode.rulesVersion,
          stakeAmountMinor: mode.stakeAmountMinor,
          platformFeeBps: mode.platformFeeBps,
          participants: {
            create: userIds.map((userId, index) => ({ userId, seat: index })),
          },
        },
        include: { game: true, gameMode: true, participants: true },
      });
      return this.serializeMatch(match);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const duplicate = await this.prisma.match.findUnique({
          where: { matchmakingKey },
          include: { game: true, gameMode: true, participants: true },
        });
        if (duplicate) return this.serializeMatch(duplicate);
      }
      throw error;
    }
  }

  async getMatchForUser(matchId: string, userId: string, isAdmin = false) {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: {
        game: true,
        gameMode: true,
        participants: {
          include: { user: { select: { id: true, fullName: true } } },
          orderBy: { seat: 'asc' },
        },
      },
    });
    if (!match) throw new NotFoundException({ code: 'MATCH_NOT_FOUND', message: 'Match not found.' });
    if (!isAdmin && !match.participants.some((participant) => participant.userId === userId)) {
      throw new ForbiddenException({ code: 'MATCH_ACCESS_DENIED', message: 'You are not part of this match.' });
    }
    return this.serializeMatch(match);
  }

  private serializeMode(mode: any) {
    return { ...mode, stakeAmountMinor: mode.stakeAmountMinor.toString() };
  }

  private serializeMatch(match: any) {
    return {
      ...match,
      stakeAmountMinor: match.stakeAmountMinor.toString(),
      gameMode: this.serializeMode(match.gameMode),
    };
  }
}
