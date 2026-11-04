import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { UserStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { normalizeChatText } from './chat.types';

export type DirectMessageView = {
  id: string;
  conversationId: string;
  sender: { userId: string; displayName: string };
  recipientId: string;
  text: string;
  createdAt: string;
  readAt: string | null;
};

export type ConversationView = {
  conversationId: string;
  peer: { userId: string; displayName: string };
  lastMessage: DirectMessageView;
  unread: number;
};

type Row = {
  id: string;
  conversationId: string;
  senderId: string;
  recipientId: string;
  text: string;
  createdAt: Date;
  readAt: Date | null;
};

const HISTORY_PAGE = 50;
const RATE_LIMIT = { count: 8, windowSeconds: 10 };

/**
 * Private 1:1 messages. Durable in PostgreSQL (unlike lobby/match room chat,
 * which is ephemeral in Redis). Delivery goes to each user's personal room,
 * so a message arrives wherever the recipient is in the app.
 */
@Injectable()
export class DirectChatService {
  private readonly logger = new Logger(DirectChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  static conversationId(a: string, b: string): string {
    return [a, b].sort().join(':');
  }

  async send(
    senderId: string,
    recipientId: string,
    commandId: string,
    rawText: string,
  ): Promise<{ message: DirectMessageView; duplicate: boolean }> {
    if (senderId === recipientId)
      throw new BadRequestException({ code: 'CHAT_SELF', message: 'You cannot message yourself.' });
    const text = normalizeChatText(rawText);
    const names = await this.activeUsers([senderId, recipientId]);
    await this.rateLimit(senderId);

    try {
      const row = await this.prisma.directMessage.create({
        data: {
          conversationId: DirectChatService.conversationId(senderId, recipientId),
          senderId,
          recipientId,
          text,
          clientCommandId: commandId,
        },
      });
      this.logger.log(
        `chat_direct_message sender=${senderId} recipient=${recipientId} message=${row.id}`,
      );
      return { message: this.view(row, names), duplicate: false };
    } catch (error) {
      // Retried command: return the message that was already stored.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.prisma.directMessage.findUnique({
          where: { senderId_clientCommandId: { senderId, clientCommandId: commandId } },
        });
        if (existing) return { message: this.view(existing, names), duplicate: true };
      }
      throw error;
    }
  }

  /** Newest page (or the page before [before]), oldest first. */
  async history(userId: string, peerId: string, before?: string): Promise<DirectMessageView[]> {
    const names = await this.names([userId, peerId]);
    if (!names.has(peerId))
      throw new NotFoundException({ code: 'PLAYER_NOT_FOUND', message: 'Player not found.' });
    const rows = await this.prisma.directMessage.findMany({
      where: {
        conversationId: DirectChatService.conversationId(userId, peerId),
        ...(before ? { createdAt: { lt: new Date(before) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_PAGE,
    });
    return rows.reverse().map((row) => this.view(row, names));
  }

  /** Marks everything [peerId] sent to [userId] as read; returns how many changed. */
  async markRead(userId: string, peerId: string): Promise<number> {
    const result = await this.prisma.directMessage.updateMany({
      where: {
        conversationId: DirectChatService.conversationId(userId, peerId),
        recipientId: userId,
        readAt: null,
      },
      data: { readAt: new Date() },
    });
    return result.count;
  }

  /** Inbox: one row per conversation, newest first, with unread counts. */
  async conversations(
    userId: string,
  ): Promise<{ conversations: ConversationView[]; unreadTotal: number }> {
    const latest = await this.prisma.$queryRaw<Row[]>`
      SELECT DISTINCT ON ("conversationId")
        "id", "conversationId", "senderId", "recipientId", "text", "createdAt", "readAt"
      FROM "DirectMessage"
      WHERE "senderId" = ${userId} OR "recipientId" = ${userId}
      ORDER BY "conversationId", "createdAt" DESC
      LIMIT 100`;
    const unread = await this.prisma.directMessage.groupBy({
      by: ['conversationId'],
      where: { recipientId: userId, readAt: null },
      _count: { _all: true },
    });
    const unreadBy = new Map(unread.map((row) => [row.conversationId, row._count._all]));
    const peerIds = latest.map((row) => (row.senderId === userId ? row.recipientId : row.senderId));
    const names = await this.names([userId, ...peerIds]);

    const conversations = latest
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((row) => {
        const peerId = row.senderId === userId ? row.recipientId : row.senderId;
        return {
          conversationId: row.conversationId,
          peer: { userId: peerId, displayName: names.get(peerId) ?? 'Player' },
          lastMessage: this.view(row, names),
          unread: unreadBy.get(row.conversationId) ?? 0,
        };
      });
    return { conversations, unreadTotal: [...unreadBy.values()].reduce((sum, n) => sum + n, 0) };
  }

  private view(row: Row, names: Map<string, string>): DirectMessageView {
    return {
      id: row.id,
      conversationId: row.conversationId,
      sender: { userId: row.senderId, displayName: names.get(row.senderId) ?? 'Player' },
      recipientId: row.recipientId,
      text: row.text,
      createdAt: row.createdAt.toISOString(),
      readAt: row.readAt?.toISOString() ?? null,
    };
  }

  private async activeUsers(userIds: string[]): Promise<Map<string, string>> {
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, fullName: true, status: true },
    });
    if (
      users.length !== new Set(userIds).size ||
      users.some((user) => user.status !== UserStatus.ACTIVE)
    ) {
      throw new NotFoundException({
        code: 'PLAYER_NOT_FOUND',
        message: 'This player cannot receive messages.',
      });
    }
    return new Map(users.map((user) => [user.id, user.fullName]));
  }

  private async names(userIds: string[]): Promise<Map<string, string>> {
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(userIds)] } },
      select: { id: true, fullName: true },
    });
    return new Map(users.map((user) => [user.id, user.fullName]));
  }

  private async rateLimit(userId: string): Promise<void> {
    const key = this.redis.key('chat', 'rate', 'direct', userId);
    const count = await this.redis.raw().incr(key);
    if (count === 1) await this.redis.raw().expire(key, RATE_LIMIT.windowSeconds);
    if (count > RATE_LIMIT.count) {
      throw new ConflictException({
        code: 'CHAT_RATE_LIMITED',
        message: 'You are sending messages too quickly.',
      });
    }
  }
}
