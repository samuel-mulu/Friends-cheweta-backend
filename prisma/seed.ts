import 'dotenv/config';
import { hash } from 'bcryptjs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { UserRole, UserStatus } from '../src/generated/prisma/enums';
import { normalizeEthiopianPhone } from '../src/common/utils/phone.util';

async function main(): Promise<void> {
  const fullName = process.env.ADMIN_FULL_NAME;
  const phone = process.env.ADMIN_PHONE;
  const password = process.env.ADMIN_PASSWORD;
  const databaseUrl = process.env.DATABASE_URL;

  if (!fullName || !phone || !password || !databaseUrl) {
    throw new Error('ADMIN_FULL_NAME, ADMIN_PHONE, ADMIN_PASSWORD and DATABASE_URL are required for seed.');
  }

  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter });

  try {
    const phoneNumber = normalizeEthiopianPhone(phone);
    const passwordHash = await hash(password, 12);

    await prisma.user.upsert({
      where: { phoneNumber },
      update: {
        fullName,
        passwordHash,
        role: UserRole.ADMIN,
        status: UserStatus.ACTIVE,
      },
      create: {
        fullName,
        phoneNumber,
        passwordHash,
        role: UserRole.ADMIN,
        status: UserStatus.ACTIVE,
        wallet: { create: {} },
      },
    });

    const ludo = await prisma.game.upsert({
      where: { code: 'LUDO' },
      update: { name: 'Ludo', enabled: true },
      create: {
        code: 'LUDO',
        name: 'Ludo',
        description: 'Server-authoritative classic Ludo. First game in Friends Game Hub.',
      },
    });

    const modes = [
      { code: 'LUDO_1V1_10', name: 'Ludo 1v1 - 10 ETB', stakeAmountMinor: 1000n },
      { code: 'LUDO_1V1_20', name: 'Ludo 1v1 - 20 ETB', stakeAmountMinor: 2000n },
      { code: 'LUDO_1V1_50', name: 'Ludo 1v1 - 50 ETB', stakeAmountMinor: 5000n },
    ];

    for (const mode of modes) {
      await prisma.gameMode.upsert({
        where: { code: mode.code },
        update: {
          gameId: ludo.id,
          name: mode.name,
          playerCount: 2,
          stakeAmountMinor: mode.stakeAmountMinor,
          platformFeeBps: 0,
          turnDurationSeconds: 30,
          rulesVersion: 'LUDO_CLASSIC_V1',
          enabled: true,
        },
        create: {
          gameId: ludo.id,
          code: mode.code,
          name: mode.name,
          playerCount: 2,
          stakeAmountMinor: mode.stakeAmountMinor,
          platformFeeBps: 0,
          turnDurationSeconds: 30,
          rulesVersion: 'LUDO_CLASSIC_V1',
          enabled: true,
        },
      });
    }

    console.log(`Seeded admin ${phoneNumber} and Ludo game catalog.`);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
