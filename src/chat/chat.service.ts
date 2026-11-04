import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MatchStatus, UserStatus } from '../generated/prisma/enums';
import { LobbyService } from '../lobby/lobby.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ChatMessage, normalizeChatText } from './chat.types';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly historyLimit = 50;
  private readonly lobbyTtlSeconds = 7200;
  private readonly matchTtlSeconds = 86400;
  private readonly commandTtlSeconds = 300;
  private readonly rateLimitCount = 5;
  private readonly rateLimitWindowSeconds = 10;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly lobby: LobbyService,
  ) {}

  async sendLobbyMessage(
    userId: string,
    commandId: string,
    rawText: string,
  ): Promise<{ message: ChatMessage; duplicate: boolean }> {
    const context = await this.lobby.requireContext(userId);
    await this.assertActive(userId);
    await this.assertModeExists(context.gameModeId);
    const duplicate = await this.commandResult(userId, commandId);
    if (duplicate) return { message: duplicate, duplicate: true };
    await this.rateLimit('lobby', context.gameModeId, userId);
    const message = await this.buildMessage('LOBBY', context.gameModeId, userId, rawText);
    await this.store(message, this.lobbyChatKey(context.gameModeId), this.lobbyTtlSeconds);
    await this.storeCommand(userId, commandId, message);
    this.logger.log(
      `chat_lobby_message user=${userId} mode=${context.gameModeId} message=${message.id}`,
    );
    return { message, duplicate: false };
  }

  async sendMatchMessage(
    userId: string,
    matchId: string,
    commandId: string,
    rawText: string,
  ): Promise<{ message: ChatMessage; duplicate: boolean }> {
    await this.assertActive(userId);
    const match = await this.assertMatchParticipant(userId, matchId);
    if (
      !(
        [
          MatchStatus.READY,
          MatchStatus.PLAYING,
          MatchStatus.FINISHING,
          MatchStatus.FINISHED,
        ] as MatchStatus[]
      ).includes(match.status)
    ) {
      throw new ConflictException({
        code: 'MATCH_CHAT_NOT_AVAILABLE',
        message: 'Match chat is not available for this match.',
      });
    }

    const duplicate = await this.commandResult(userId, commandId);
    if (duplicate) return { message: duplicate, duplicate: true };
    await this.rateLimit('match', matchId, userId);
    const message = await this.buildMessage('MATCH', matchId, userId, rawText);
    await this.store(message, this.matchChatKey(matchId), this.matchTtlSeconds);
    await this.storeCommand(userId, commandId, message);
    this.logger.log(`chat_match_message user=${userId} match=${matchId} message=${message.id}`);
    return { message, duplicate: false };
  }

  async getLobbyHistory(gameModeId: string): Promise<ChatMessage[]> {
    return this.history(this.lobbyChatKey(gameModeId));
  }

  async getMatchHistory(matchId: string): Promise<ChatMessage[]> {
    return this.history(this.matchChatKey(matchId));
  }

  async getMatchHistoryForUser(userId: string, matchId: string): Promise<ChatMessage[]> {
    await this.assertMatchParticipant(userId, matchId);
    return this.getMatchHistory(matchId);
  }

  private async buildMessage(
    scope: ChatMessage['scope'],
    scopeId: string,
    userId: string,
    rawText: string,
  ): Promise<ChatMessage> {
    const text = normalizeChatText(rawText);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { fullName: true },
    });
    if (!user)
      throw new BadRequestException({
        code: 'PLAYER_NOT_ELIGIBLE',
        message: 'Player is not eligible.',
      });
    return {
      id: randomUUID(),
      scope,
      scopeId,
      sender: { userId, displayName: user.fullName },
      text,
      createdAt: new Date().toISOString(),
    };
  }

  private async store(message: ChatMessage, key: string, ttlSeconds: number): Promise<void> {
    await this.redis.raw().rPush(key, JSON.stringify(message));
    await this.redis.raw().lTrim(key, -this.historyLimit, -1);
    await this.redis.raw().expire(key, ttlSeconds);
  }

  private async history(key: string): Promise<ChatMessage[]> {
    const values = await this.redis.raw().lRange(key, 0, -1);
    return values.map((value) => JSON.parse(value) as ChatMessage);
  }

  private async rateLimit(
    scope: 'lobby' | 'match',
    scopeId: string,
    userId: string,
  ): Promise<void> {
    const key = this.redis.key('chat', 'rate', scope, scopeId, userId);
    const count = await this.redis.raw().incr(key);
    if (count === 1) await this.redis.raw().expire(key, this.rateLimitWindowSeconds);
    if (count > this.rateLimitCount) {
      throw new ConflictException({
        code: 'CHAT_RATE_LIMITED',
        message: 'You are sending messages too quickly.',
      });
    }
  }

  private async commandResult(userId: string, commandId: string): Promise<ChatMessage | null> {
    return this.redis.getJson<ChatMessage>(this.commandKey(userId, commandId));
  }

  private async storeCommand(
    userId: string,
    commandId: string,
    message: ChatMessage,
  ): Promise<void> {
    await this.redis.setJson(this.commandKey(userId, commandId), message, this.commandTtlSeconds);
  }

  private async assertActive(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { status: true },
    });
    if (!user || user.status !== UserStatus.ACTIVE)
      throw new BadRequestException({
        code: 'PLAYER_NOT_ELIGIBLE',
        message: 'Player is not eligible.',
      });
  }

  private async assertModeExists(gameModeId: string): Promise<void> {
    const mode = await this.prisma.gameMode.findUnique({
      where: { id: gameModeId },
      select: { enabled: true, game: { select: { enabled: true } } },
    });
    if (!mode || !mode.enabled || !mode.game.enabled)
      throw new BadRequestException({
        code: 'LOBBY_MODE_DISABLED',
        message: 'Lobby mode is disabled.',
      });
  }

  private async assertMatchParticipant(userId: string, matchId: string) {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: { id: true, status: true, participants: { select: { userId: true } } },
    });
    if (!match)
      throw new NotFoundException({ code: 'MATCH_NOT_FOUND', message: 'Match not found.' });
    if (!match.participants.some((participant) => participant.userId === userId)) {
      throw new ForbiddenException({
        code: 'MATCH_CHAT_NOT_ALLOWED',
        message: 'You are not part of this match.',
      });
    }
    return match;
  }

  private lobbyChatKey(gameModeId: string): string {
    return this.redis.key('lobby', gameModeId, 'chat');
  }
  private matchChatKey(matchId: string): string {
    return this.redis.key('match', matchId, 'chat');
  }
  private commandKey(userId: string, commandId: string): string {
    return this.redis.key('chat', 'command', userId, commandId);
  }
}
