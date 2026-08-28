import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: {
    userId: string;
    type: string;
    title: string;
    message: string;
    data?: unknown;
    dedupeKey?: string;
  }) {
    if (input.dedupeKey) {
      const existing = await this.prisma.notification.findUnique({ where: { dedupeKey: input.dedupeKey } });
      if (existing) return existing;
    }
    try {
      return await this.prisma.notification.create({
        data: {
          userId: input.userId,
          type: input.type,
          title: input.title,
          message: input.message,
          data: input.data === undefined ? undefined : this.toJson(input.data),
          dedupeKey: input.dedupeKey ?? null,
        },
      });
    } catch (error) {
      if (input.dedupeKey && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return this.prisma.notification.findUniqueOrThrow({ where: { dedupeKey: input.dedupeKey } });
      }
      throw error;
    }
  }

  async list(userId: string, limit = 30, unreadOnly = false) {
    const rows = await this.prisma.notification.findMany({
      where: { userId, ...(unreadOnly ? { readAt: null } : {}) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
    });
    const unreadCount = await this.prisma.notification.count({ where: { userId, readAt: null } });
    return { items: rows, unreadCount };
  }

  async markRead(userId: string, id: string) {
    const changed = await this.prisma.notification.updateMany({
      where: { id, userId },
      data: { readAt: new Date() },
    });
    if (changed.count !== 1) throw new NotFoundException({ code: 'NOTIFICATION_NOT_FOUND', message: 'Notification not found.' });
    return this.prisma.notification.findUniqueOrThrow({ where: { id } });
  }

  async markAllRead(userId: string) {
    const result = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
