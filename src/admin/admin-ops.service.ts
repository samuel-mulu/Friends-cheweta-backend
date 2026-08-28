import { Injectable } from '@nestjs/common';
import { MatchStatus, PaymentStatus, UserStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminOpsService {
  constructor(private readonly prisma: PrismaService) {}

  async dashboard() {
    const [
      totalPlayers,
      activePlayers,
      blockedPlayers,
      liveMatches,
      finishedMatches,
      pendingDeposits,
      pendingWithdrawals,
      openRiskFlags,
      settlementTotals,
    ] = await Promise.all([
      this.prisma.user.count({ where: { role: 'PLAYER' } }),
      this.prisma.user.count({ where: { role: 'PLAYER', status: UserStatus.ACTIVE } }),
      this.prisma.user.count({ where: { role: 'PLAYER', status: UserStatus.BLOCKED } }),
      this.prisma.match.count({ where: { status: { in: [MatchStatus.READY, MatchStatus.PLAYING, MatchStatus.FINISHING] } } }),
      this.prisma.match.count({ where: { status: MatchStatus.FINISHED } }),
      this.prisma.deposit.count({ where: { status: PaymentStatus.PENDING } }),
      this.prisma.withdrawal.count({ where: { status: PaymentStatus.PENDING } }),
      this.prisma.riskFlag.count({ where: { status: 'OPEN' } }),
      this.prisma.matchSettlement.aggregate({
        _sum: { potAmountMinor: true, platformFeeMinor: true, payoutAmountMinor: true },
      }),
    ]);

    return {
      users: { totalPlayers, activePlayers, blockedPlayers },
      matches: { live: liveMatches, finished: finishedMatches },
      payments: { pendingDeposits, pendingWithdrawals },
      risk: { openFlags: openRiskFlags },
      settlements: {
        totalPotMinor: (settlementTotals._sum.potAmountMinor ?? 0n).toString(),
        totalPlatformFeeMinor: (settlementTotals._sum.platformFeeMinor ?? 0n).toString(),
        totalPayoutMinor: (settlementTotals._sum.payoutAmountMinor ?? 0n).toString(),
      },
    };
  }
}
