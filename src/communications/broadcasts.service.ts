import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { RECOVERABLE_MATCH_STATUSES } from '../common/match-status';
import { AuditService } from '../audit/audit.service';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ADMIN_OPERATIONS_ROOM,
  PLAYER_COMMUNICATIONS_ROOM,
  RealtimePublisherService,
} from '../realtime/realtime-publisher.service';
import { CreateBroadcastDto } from './communications.dto';

const pageSize = 30;
const live = { category: 'FORCED', forcedLive: true, deletedAt: null } as const;
const playerSelect = {
  id: true,
  title: true,
  body: true,
  category: true,
  revision: true,
  createdAt: true,
} as const;
const adminSelect = {
  ...playerSelect,
  forcedLive: true,
  updatedAt: true,
  createdBy: { select: { fullName: true } },
} as const;
type Change = 'PUBLISHED' | 'REMINDED' | 'FORCED_CHANGED' | 'DELETED';

@Injectable()
export class BroadcastsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimePublisherService,
    private readonly audit: AuditService,
  ) {}

  async inbox(userId: string, page: number, spotlightId?: string) {
    return this.prisma.$transaction(
      async (tx) => {
        const where: Prisma.AdminBroadcastWhereInput = {
          deletedAt: null,
          category: { not: 'FORCED' },
          dismissals: { none: { userId } },
        };
        const forced = await tx.adminBroadcast.findFirst({ where: live, select: playerSelect });
        const items = await tx.adminBroadcast.findMany({
          where,
          select: playerSelect,
          orderBy: [{ category: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize + 1,
        });
        const unreadCount = await tx.adminBroadcast.count({
          where: { ...where, category: 'DISMISSIBLE' },
        });
        const spotlight = spotlightId
          ? await tx.adminBroadcast.findFirst({
              where: { ...where, id: spotlightId },
              select: playerSelect,
            })
          : null;
        const participant = forced
          ? await tx.matchParticipant.findFirst({
              where: {
                userId,
                match: {
                  status: { in: RECOVERABLE_MATCH_STATUSES },
                  OR: [{ source: null }, { source: { not: 'PRACTICE' } }],
                },
              },
              orderBy: { joinedAt: 'desc' },
              select: { match: { select: { id: true, game: { select: { code: true } } } } },
            })
          : null;
        return {
          items: items.slice(0, pageSize),
          hasMore: items.length > pageSize,
          unreadCount,
          forced,
          spotlight,
          recoverableMatch: participant
            ? { id: participant.match.id, gameCode: participant.match.game.code }
            : null,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  async list(page: number) {
    return this.prisma.$transaction(
      async (tx) => {
        const active = await tx.adminBroadcast.findFirst({ where: live, select: adminSelect });
        const items = await tx.adminBroadcast.findMany({
          where: { deletedAt: null },
          select: adminSelect,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize + 1,
        });
        return { active, items: items.slice(0, pageSize), hasMore: items.length > pageSize };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  async publish(actorUserId: string, input: CreateBroadcastDto) {
    const category = input.category ?? 'DISMISSIBLE';
    const forcedLive = category === 'FORCED';
    const result = await this.prisma.$transaction(async (tx) => {
      if (forcedLive) {
        await this.lock(tx, 'forced-broadcast');
        await this.replaceLive(tx, input.expectedLiveId);
      }
      const created = await tx.adminBroadcast.create({
        data: {
          title: input.title,
          body: input.body,
          category,
          forcedLive,
          createdById: actorUserId,
        },
        select: adminSelect,
      });
      await this.writeAudit(tx, actorUserId, created.id, 'BROADCAST_PUBLISHED', {
        category,
        replacedId: input.expectedLiveId ?? null,
      });
      return created;
    });
    this.publishChange(result, forcedLive ? 'FORCED_CHANGED' : 'PUBLISHED');
    return result;
  }

  async setLive(id: string, actorUserId: string, enabled: boolean, expectedLiveId?: string | null) {
    const { row, changed } = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, 'forced-broadcast');
      const current = await this.find(tx, id);
      if (current.category !== 'FORCED')
        throw new BadRequestException('Only forced broadcasts can be turned on or off.');
      if (current.forcedLive === enabled) return { row: current, changed: false };
      if (enabled) await this.replaceLive(tx, expectedLiveId);
      const row = await tx.adminBroadcast.update({
        where: { id },
        data: { forcedLive: enabled, revision: { increment: 1 } },
        select: adminSelect,
      });
      await this.writeAudit(
        tx,
        actorUserId,
        id,
        enabled ? 'BROADCAST_ACTIVATED' : 'BROADCAST_STOPPED',
        { replacedId: enabled ? (expectedLiveId ?? null) : null },
      );
      return { row, changed: true };
    });
    if (changed) this.publishChange(row, 'FORCED_CHANGED');
    return row;
  }

  async remind(id: string, actorUserId: string) {
    const row = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, `broadcast:${id}`);
      const current = await this.find(tx, id);
      if (current.category !== 'DISMISSIBLE')
        throw new BadRequestException('Only dismissible notices can be reminded.');
      await tx.broadcastDismissal.deleteMany({ where: { broadcastId: id } });
      const updated = await tx.adminBroadcast.update({
        where: { id },
        data: { revision: { increment: 1 } },
        select: adminSelect,
      });
      await this.writeAudit(tx, actorUserId, id, 'BROADCAST_REMINDED', {
        revision: updated.revision,
      });
      return updated;
    });
    this.publishChange(row, 'REMINDED');
    return row;
  }

  async dismiss(userId: string, id: string, revision: number) {
    await this.prisma.$transaction(async (tx) => {
      const lockKey = `broadcast:${id}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${lockKey}, 0))`;
      const row = await this.find(tx, id);
      if (row.category !== 'DISMISSIBLE')
        throw new BadRequestException('This notice cannot be dismissed.');
      if (row.revision !== revision)
        throw new ConflictException({
          code: 'BROADCAST_UPDATED',
          message: 'This notice has been reminded. Open it again to dismiss it.',
        });
      await tx.broadcastDismissal.createMany({
        data: [{ broadcastId: id, userId }],
        skipDuplicates: true,
      });
    });
    this.realtime.publishUser(userId, 'broadcast:changed', { id, revision, kind: 'DISMISSED' });
    return { success: true };
  }

  async remove(id: string, actorUserId: string) {
    const row = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, 'forced-broadcast');
      await this.lock(tx, `broadcast:${id}`);
      await this.find(tx, id);
      const deleted = await tx.adminBroadcast.update({
        where: { id },
        data: { deletedAt: new Date(), forcedLive: false, revision: { increment: 1 } },
      });
      await this.writeAudit(tx, actorUserId, id, 'BROADCAST_DELETED', {
        category: deleted.category,
      });
      return deleted;
    });
    this.publishChange(row, 'DELETED');
    return { success: true };
  }

  private async replaceLive(tx: Prisma.TransactionClient, expectedId?: string | null) {
    const current = await tx.adminBroadcast.findFirst({ where: live, select: { id: true } });
    if ((current?.id ?? null) !== (expectedId ?? null)) {
      throw new ConflictException({
        code: 'LIVE_NOTICE_CHANGED',
        message: 'The live notice changed. Review it before confirming again.',
      });
    }
    if (current)
      await tx.adminBroadcast.update({
        where: { id: current.id },
        data: { forcedLive: false, revision: { increment: 1 } },
      });
  }

  private async find(tx: Prisma.TransactionClient, id: string) {
    const row = await tx.adminBroadcast.findFirst({
      where: { id, deletedAt: null },
      select: adminSelect,
    });
    if (!row) throw new NotFoundException('Broadcast not found.');
    return row;
  }

  private lock(tx: Prisma.TransactionClient, key: string) {
    return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }

  private writeAudit(
    tx: Prisma.TransactionClient,
    actorUserId: string,
    entityId: string,
    action: string,
    metadata: unknown,
  ) {
    return this.audit.write(
      { actorUserId, entityType: 'BROADCAST', entityId, action, metadata },
      tx,
    );
  }

  private publishChange(row: { id: string; revision: number }, kind: Change) {
    this.realtime.publishRoom(
      [PLAYER_COMMUNICATIONS_ROOM, ADMIN_OPERATIONS_ROOM],
      'broadcast:changed',
      { id: row.id, revision: row.revision, kind },
    );
  }
}
