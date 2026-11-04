/**
 * Development-only test players with wallet balance, so Ready / Connect /
 * matches can be tested end to end.  Run: npm run seed:dev
 *
 * Balances are credited through a real ledger row (ADMIN_ADJUSTMENT), so wallet
 * invariants and history stay consistent. Re-running tops nobody up twice
 * (idempotency key per player).
 */
import 'dotenv/config';
import { hash } from 'bcryptjs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { UserRole, UserStatus, WalletTransactionType } from '../src/generated/prisma/enums';
import { normalizeEthiopianPhone } from '../src/common/utils/phone.util';

const PASSWORD = 'player123';
const STARTING_BALANCE_MINOR = 100_000n; // 1,000 ETB
const PLAYERS = [
  { fullName: 'Test Player One', phone: '0922000001' },
  { fullName: 'Test Player Two', phone: '0922000002' },
  { fullName: 'Test Player Three', phone: '0922000003' },
  { fullName: 'Test Player Four', phone: '0922000004' },
];

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('seed:dev must never run in production.');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  try {
    const passwordHash = await hash(PASSWORD, 12);
    for (const player of PLAYERS) {
      const phoneNumber = normalizeEthiopianPhone(player.phone);
      const user = await prisma.user.upsert({
        where: { phoneNumber },
        update: { fullName: player.fullName, status: UserStatus.ACTIVE },
        create: {
          fullName: player.fullName,
          phoneNumber,
          passwordHash,
          role: UserRole.PLAYER,
          status: UserStatus.ACTIVE,
          wallet: { create: {} },
        },
        include: { wallet: true },
      });
      const wallet = user.wallet ?? (await prisma.wallet.create({ data: { userId: user.id } }));
      const idempotencyKey = `dev-seed:${phoneNumber}`;

      await prisma.$transaction(async (tx) => {
        if (await tx.walletTransaction.findUnique({ where: { idempotencyKey } })) return;
        const current = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
        const after = current.availableBalance + STARTING_BALANCE_MINOR;
        await tx.wallet.update({ where: { id: wallet.id }, data: { availableBalance: after } });
        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            type: WalletTransactionType.ADMIN_ADJUSTMENT,
            amountMinor: STARTING_BALANCE_MINOR,
            availableDelta: STARTING_BALANCE_MINOR,
            lockedDelta: 0n,
            availableBalanceBefore: current.availableBalance,
            availableBalanceAfter: after,
            lockedBalanceBefore: current.lockedBalance,
            lockedBalanceAfter: current.lockedBalance,
            idempotencyKey,
            referenceType: 'DEV_SEED',
            metadata: { reason: 'Development test balance' },
          },
        });
      });
      console.log(`${player.fullName}: ${player.phone} / ${PASSWORD}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main();
