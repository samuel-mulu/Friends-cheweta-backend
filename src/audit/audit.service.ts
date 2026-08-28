import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  write(input: {
    actorUserId?: string;
    action: string;
    entityType: string;
    entityId?: string;
    metadata?: unknown;
    requestId?: string;
  }) {
    return this.prisma.auditLog.create({
      data: {
        actorUserId: input.actorUserId ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        metadata: input.metadata === undefined ? undefined : this.toJson(input.metadata),
        requestId: input.requestId ?? null,
      },
    });
  }

  list(limit = 100, action?: string) {
    return this.prisma.auditLog.findMany({
      where: action ? { action } : undefined,
      include: { actor: { select: { id: true, fullName: true, phoneNumber: true } } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
