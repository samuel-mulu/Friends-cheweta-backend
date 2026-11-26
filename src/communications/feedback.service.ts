import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ADMIN_OPERATIONS_ROOM,
  RealtimePublisherService,
} from '../realtime/realtime-publisher.service';
import {
  FeedbackQuery,
  StartFeedbackDto,
  SubmitFeedbackDto,
  UpdateFeedbackDto,
} from './communications.dto';

const pageSize = 30;
const maxReplyCursor = 9223372036854775807n;
const playerSelect = {
  id: true,
  category: true,
  status: true,
  message: true,
  adminReply: true,
  createdAt: true,
  repliedAt: true,
  playerSeenAt: true,
} as const;
const adminSelect = {
  ...playerSelect,
  user: { select: { id: true, fullName: true, phoneNumber: true } },
  repliedBy: { select: { fullName: true } },
} as const;
const order = [
  { createdAt: 'desc' },
  { id: 'desc' },
] satisfies Prisma.PlayerFeedbackOrderByWithRelationInput[];

@Injectable()
export class FeedbackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimePublisherService,
    private readonly audit: AuditService,
  ) {}

  async submit(userId: string, input: SubmitFeedbackDto) {
    const key = { userId, requestId: input.requestId };
    try {
      const row = await this.prisma.playerFeedback.create({
        data: { ...key, category: input.category, message: input.message },
        select: playerSelect,
      });
      this.publish(row.id, 'CREATED', userId);
      return row;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'))
        throw error;
      const row = await this.prisma.playerFeedback.findUniqueOrThrow({
        where: { userId_requestId: key },
        select: playerSelect,
      });
      if (row.category !== input.category || row.message !== input.message) {
        throw new ConflictException('This feedback request was already used.');
      }
      return row;
    }
  }

  async inbox(userId: string, page: number) {
    return this.prisma.$transaction(
      async (tx) => {
        const items = await tx.playerFeedback.findMany({
          where: { userId },
          select: playerSelect,
          orderBy: order,
          skip: (page - 1) * pageSize,
          take: pageSize + 1,
        });
        const unread = await tx.playerFeedback.aggregate({
          where: { userId, status: 'REPLIED', adminReply: { not: null }, playerSeenAt: null },
          _count: true,
          _max: { replyCursor: true },
        });
        return {
          items: items.slice(0, pageSize),
          hasMore: items.length > pageSize,
          unreadCount: unread._count,
          seenThrough: (unread._max.replyCursor ?? 0n).toString(),
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  async markSeen(userId: string, seenThrough: string) {
    const cutoff = BigInt(seenThrough);
    if (cutoff > maxReplyCursor) throw new BadRequestException('Invalid feedback snapshot.');
    const { count } = await this.prisma.playerFeedback.updateMany({
      where: {
        userId,
        status: 'REPLIED',
        adminReply: { not: null },
        playerSeenAt: null,
        replyCursor: { lte: cutoff },
      },
      data: { playerSeenAt: new Date() },
    });
    if (count) {
      this.realtime.publishUser(userId, 'feedback:changed', { kind: 'SEEN' });
      this.realtime.publishRoom(ADMIN_OPERATIONS_ROOM, 'feedback:changed', { kind: 'SEEN' });
    }
    return { updated: count };
  }

  async list(query: FeedbackQuery) {
    const items = await this.prisma.playerFeedback.findMany({
      where: { status: query.status, category: query.category },
      select: adminSelect,
      orderBy: order,
      skip: (query.page - 1) * pageSize,
      take: pageSize + 1,
    });
    return { items: items.slice(0, pageSize), hasMore: items.length > pageSize };
  }

  async detail(id: string) {
    const row = await this.prisma.playerFeedback.findUnique({ where: { id }, select: adminSelect });
    if (!row) throw new NotFoundException('Feedback not found.');
    return row;
  }

  async openCount() {
    return { count: await this.prisma.playerFeedback.count({ where: { status: 'OPEN' } }) };
  }

  async start(actorUserId: string, input: StartFeedbackDto) {
    const row = await this.prisma.$transaction(async (tx) => {
      const player = await tx.user.findFirst({
        where: { id: input.userId, role: 'PLAYER', isBot: false },
        select: { id: true },
      });
      if (!player) throw new NotFoundException('Player not found.');
      const result = await tx.playerFeedback.create({
        data: {
          userId: player.id,
          category: input.category ?? 'OTHER',
          adminReply: input.adminReply,
          repliedById: actorUserId,
          repliedAt: new Date(),
          replyCursor: await this.nextReplyCursor(tx, player.id),
          status: 'REPLIED',
        },
        select: adminSelect,
      });
      await this.audit.write(
        { actorUserId, action: 'FEEDBACK_STARTED', entityType: 'FEEDBACK', entityId: result.id },
        tx,
      );
      return result;
    });
    this.publish(row.id, 'REPLIED', row.user.id);
    return row;
  }

  async update(id: string, actorUserId: string, input: UpdateFeedbackDto) {
    if (!input.status && !input.adminReply)
      throw new BadRequestException('Provide a reply or a status.');
    if (input.adminReply && input.status && input.status !== 'REPLIED') {
      throw new BadRequestException('Send the reply before changing its status.');
    }
    const row = await this.prisma.$transaction(async (tx) => {
      const key = `feedback:${id}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      const current = await tx.playerFeedback.findUnique({
        where: { id },
        select: { adminReply: true, userId: true },
      });
      if (!current) throw new NotFoundException('Feedback not found.');
      if (input.status === 'REPLIED' && !input.adminReply && !current.adminReply) {
        throw new BadRequestException('Send a reply first.');
      }
      const updated = await tx.playerFeedback.update({
        where: { id },
        select: adminSelect,
        data: input.adminReply
          ? {
              status: 'REPLIED',
              adminReply: input.adminReply,
              repliedAt: new Date(),
              replyCursor: await this.nextReplyCursor(tx, current.userId),
              repliedById: actorUserId,
              playerSeenAt: null,
            }
          : { status: input.status },
      });
      await this.audit.write(
        {
          actorUserId,
          action: input.adminReply ? 'FEEDBACK_REPLIED' : 'FEEDBACK_STATUS_CHANGED',
          entityType: 'FEEDBACK',
          entityId: id,
          metadata: { status: updated.status },
        },
        tx,
      );
      return updated;
    });
    this.publish(id, input.adminReply ? 'REPLIED' : 'STATUS_CHANGED', row.user.id);
    return row;
  }

  private async nextReplyCursor(tx: Prisma.TransactionClient, userId: string) {
    // Keep reply versions in commit order for each player, including admin-started messages.
    const key = `feedback-inbox:${userId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    const { _max } = await tx.playerFeedback.aggregate({
      where: { userId },
      _max: { replyCursor: true },
    });
    return (_max.replyCursor ?? 0n) + 1n;
  }

  private publish(id: string, kind: string, ownerId: string) {
    this.realtime.publishRoom(ADMIN_OPERATIONS_ROOM, 'feedback:changed', { id, kind });
    this.realtime.publishUser(ownerId, 'feedback:changed', { id, kind });
  }
}
