/**
 * One-shot dev cleanup: cancel confirmed orphan WAITING matches via GameEntryService.cancelAndRefund.
 * Run: npx tsx scripts/cleanup-dev-orphans.ts
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PREMATCH_ORPHAN_STATUSES } from '../src/common/match-status';
import { GameEntryService } from '../src/game-entry/game-entry.service';
import { PrismaClient } from '../src/generated/prisma/client';
import { MatchEntryStatus, WalletTransactionType } from '../src/generated/prisma/enums';
import { WalletService } from '../src/wallet/wallet.service';

const ORPHAN_MATCH_IDS = [
  '516572cb-f6ee-4e4d-844d-e0cf9cd5d87a',
  '271ba47c-61aa-4d92-bb86-8769d3d583d3',
  'b68930a5-603c-4c72-b2b3-82ef718b9e0f',
  'dd802de2-5ec4-40ad-9e10-93dec6235ffe',
  '53d43981-2580-42aa-b29c-d6ef8d9130bc',
  '1f6ae473-027f-4e6c-89b7-7cf6f08710df',
];

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl, max: 5 }),
  });
  const walletService = new WalletService(prisma as any);
  const gameEntry = new GameEntryService(prisma as any, walletService);
  const report: Array<Record<string, unknown>> = [];

  try {
    for (const matchId of ORPHAN_MATCH_IDS) {
      const before = await prisma.match.findUnique({
        where: { id: matchId },
        include: { entries: true },
      });
      if (!before) {
        report.push({ matchId, skipped: 'NOT_FOUND' });
        continue;
      }
      if (['FINISHED', 'PLAYING', 'FINISHING'].includes(before.status)) {
        report.push({ matchId, skipped: 'PROTECTED_STATUS', status: before.status });
        continue;
      }

      for (const entry of before.entries) {
        const wallet = await prisma.wallet.findUnique({
          where: { userId: entry.userId },
          select: { lockedBalance: true, availableBalance: true },
        });
        console.log(
          JSON.stringify({
            phase: 'before',
            matchId,
            userId: entry.userId,
            entryId: entry.id,
            lockedAmount: entry.amountMinor.toString(),
            walletLockedBalance: wallet?.lockedBalance.toString() ?? null,
            matchStatus: before.status,
            entryStatus: entry.status,
          }),
        );
      }

      const oldStatus = before.status;
      const oldEntryStatuses = before.entries.map((e) => ({
        id: e.id,
        status: e.status,
        amount: e.amountMinor.toString(),
      }));

      await gameEntry.cancelAndRefund(matchId, 'DEV_ORPHAN_CLEANUP', {
        expectedStatuses: PREMATCH_ORPHAN_STATUSES,
      });

      const after = await prisma.match.findUnique({
        where: { id: matchId },
        include: { entries: true },
      });
      const ledgerCounts: Array<{ userId: string; count: number }> = [];
      for (const entry of before.entries) {
        const count = await prisma.walletTransaction.count({
          where: {
            type: WalletTransactionType.GAME_ENTRY_RELEASE,
            idempotencyKey: `game-entry-refund:${matchId}:${entry.userId}`,
          },
        });
        ledgerCounts.push({ userId: entry.userId, count });
        const wallet = await prisma.wallet.findUnique({
          where: { userId: entry.userId },
          select: { lockedBalance: true, availableBalance: true },
        });
        console.log(
          JSON.stringify({
            phase: 'after',
            matchId,
            userId: entry.userId,
            entryId: entry.id,
            entryStatus: after?.entries.find((e) => e.id === entry.id)?.status,
            walletLockedBalance: wallet?.lockedBalance.toString() ?? null,
            walletAvailableBalance: wallet?.availableBalance.toString() ?? null,
            ledgerReleaseCount: count,
          }),
        );
      }

      report.push({
        matchId,
        oldStatus,
        newStatus: after?.status,
        entries: oldEntryStatuses.map((old) => ({
          entryId: old.id,
          oldStatus: old.status,
          newStatus: after?.entries.find((e) => e.id === old.id)?.status,
          refundAmount: old.amount,
          expectedRefunded: old.status === MatchEntryStatus.LOCKED,
        })),
        ledgerCounts,
      });
    }

    console.log('CLEANUP_REPORT', JSON.stringify(report, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
