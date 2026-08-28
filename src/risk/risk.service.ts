import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { MatchStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class RiskService {
  constructor(private readonly prisma: PrismaService) {}

  async analyzeFinishedMatch(matchId: string): Promise<void> {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: { participants: true },
    });
    if (!match || match.status !== MatchStatus.FINISHED) return;

    for (const participant of match.participants) {
      await Promise.all([
        this.checkRepeatedOpponent(participant.userId, matchId),
        this.checkTimeoutForfeits(participant.userId, matchId),
      ]);
    }
  }

  async list(status = 'OPEN', limit = 100) {
    return this.prisma.riskFlag.findMany({
      where: status === 'ALL' ? undefined : { status },
      include: {
        user: { select: { id: true, fullName: true, phoneNumber: true } },
        match: { select: { id: true, status: true, createdAt: true, finishedAt: true } },
      },
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      take: Math.min(Math.max(limit, 1), 200),
    });
  }

  async review(id: string, adminUserId: string, status: 'REVIEWED' | 'DISMISSED') {
    return this.prisma.riskFlag.update({
      where: { id },
      data: { status, reviewedBy: adminUserId, reviewedAt: new Date() },
    });
  }

  private async checkRepeatedOpponent(userId: string, currentMatchId: string): Promise<void> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const matches = await this.prisma.match.findMany({
      where: {
        status: MatchStatus.FINISHED,
        finishedAt: { gte: since },
        participants: { some: { userId } },
      },
      select: { id: true, participants: { select: { userId: true } } },
      take: 30,
      orderBy: { finishedAt: 'desc' },
    });
    const counts = new Map<string, number>();
    for (const item of matches) {
      for (const participant of item.participants) {
        if (participant.userId !== userId) counts.set(participant.userId, (counts.get(participant.userId) ?? 0) + 1);
      }
    }
    for (const [opponentId, count] of counts) {
      if (count < 5) continue;
      await this.upsertFlag({
        userId,
        matchId: currentMatchId,
        type: 'REPEATED_OPPONENT',
        severity: 'MEDIUM',
        reason: 'Player has repeatedly matched the same opponent within 24 hours.',
        evidence: { opponentId, matchCount: count, windowHours: 24 },
        fingerprint: `REPEATED_OPPONENT:${userId}:${opponentId}:${new Date().toISOString().slice(0, 10)}`,
      });
    }
  }

  private async checkTimeoutForfeits(userId: string, currentMatchId: string): Promise<void> {
    const recent = await this.prisma.matchEvent.findMany({
      where: {
        type: 'PLAYER_RESIGNED',
        commandId: { startsWith: 'timeout:forfeit:' },
        match: { participants: { some: { userId } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    const own = recent.filter((event) => {
      const payload = event.payload as { playerId?: string } | null;
      return payload?.playerId === userId;
    });
    if (own.length < 3) return;
    await this.upsertFlag({
      userId,
      matchId: currentMatchId,
      type: 'REPEATED_TIMEOUT_FORFEIT',
      severity: 'LOW',
      reason: 'Player has repeatedly lost matches through timeout forfeits.',
      evidence: { timeoutForfeitsObserved: own.length, sampleSize: 10 },
      fingerprint: `REPEATED_TIMEOUT_FORFEIT:${userId}:${new Date().toISOString().slice(0, 10)}`,
    });
  }

  private async upsertFlag(input: {
    userId?: string;
    matchId?: string;
    type: string;
    severity: string;
    reason: string;
    evidence: unknown;
    fingerprint: string;
  }) {
    const data = {
      userId: input.userId ?? null,
      matchId: input.matchId ?? null,
      type: input.type,
      severity: input.severity,
      reason: input.reason,
      evidence: JSON.parse(JSON.stringify(input.evidence)) as Prisma.InputJsonValue,
      fingerprint: input.fingerprint,
    };
    return this.prisma.riskFlag.upsert({
      where: { fingerprint: input.fingerprint },
      create: data,
      update: { matchId: data.matchId, evidence: data.evidence, reason: data.reason },
    });
  }
}
