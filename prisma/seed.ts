import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { hash } from 'bcryptjs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { UserRole, UserStatus } from '../src/generated/prisma/enums';
import { normalizeEthiopianPhone } from '../src/common/utils/phone.util';
import { PRACTICE_BOTS } from '../src/practice/practice.constants';

const ADMIN_ACCOUNTS = [
  { fullName: 'Friends Admin 1', phone: '0911111111', password: '12345678' },
  { fullName: 'Friends Admin 2', phone: '0911111112', password: '12345678' },
] as const;

/** Practice opponents, one per level (single definition shared with the app). */
const BOT_ACCOUNTS = Object.values(PRACTICE_BOTS);

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for seed.');
  }

  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter });

  try {
    const seededPhones: string[] = [];

    for (const admin of ADMIN_ACCOUNTS) {
      const phoneNumber = normalizeEthiopianPhone(admin.phone);
      const passwordHash = await hash(admin.password, 12);

      await prisma.user.upsert({
        where: { phoneNumber },
        update: {
          fullName: admin.fullName,
          passwordHash,
          role: UserRole.ADMIN,
          status: UserStatus.ACTIVE,
        },
        create: {
          fullName: admin.fullName,
          phoneNumber,
          passwordHash,
          role: UserRole.ADMIN,
          status: UserStatus.ACTIVE,
          wallet: { create: {} },
        },
      });

      seededPhones.push(phoneNumber);
    }

    for (const bot of BOT_ACCOUNTS) {
      const phoneNumber = normalizeEthiopianPhone(bot.phone);
      // Bots never log in: a random, discarded password.
      const passwordHash = await hash(randomBytes(32).toString('hex'), 12);
      await prisma.user.upsert({
        where: { phoneNumber },
        update: { fullName: bot.fullName, isBot: true, status: UserStatus.ACTIVE },
        create: {
          fullName: bot.fullName,
          phoneNumber,
          passwordHash,
          role: UserRole.PLAYER,
          status: UserStatus.ACTIVE,
          isBot: true,
          wallet: { create: {} },
        },
      });
    }

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
          rulesVersion: 'LUDO_CLASSIC_V2',
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
          rulesVersion: 'LUDO_CLASSIC_V2',
          enabled: true,
        },
      });
    }

    const dama = await prisma.game.upsert({
      where: { code: 'DAMA' },
      update: { name: 'Dama', enabled: true },
      create: {
        code: 'DAMA',
        name: 'Dama',
        description: 'Ethiopian Dama (ዳማ): flying kings, compulsory maximum capture.',
      },
    });
    const damaModes = [
      { code: 'DAMA_1V1_10', name: 'Dama 1v1 - 10 ETB', stakeAmountMinor: 1000n },
      { code: 'DAMA_1V1_20', name: 'Dama 1v1 - 20 ETB', stakeAmountMinor: 2000n },
      { code: 'DAMA_1V1_50', name: 'Dama 1v1 - 50 ETB', stakeAmountMinor: 5000n },
    ];
    for (const mode of damaModes) {
      const data = {
        gameId: dama.id,
        name: mode.name,
        playerCount: 2,
        stakeAmountMinor: mode.stakeAmountMinor,
        platformFeeBps: 0,
        turnDurationSeconds: 40,
        rulesVersion: 'DAMA_ET_V1',
        enabled: true,
      };
      await prisma.gameMode.upsert({ where: { code: mode.code }, update: data, create: { code: mode.code, ...data } });
    }

    const karta = await prisma.game.upsert({
      where: { code: 'KARTA' },
      update: { name: 'Karta Lat Lat', enabled: true },
      create: {
        code: 'KARTA',
        name: 'Karta Lat Lat',
        description: 'ካርታ ላጥ ላጥ: call a rank, turn the cards; whoever gets it wins the round. First to 3.',
      },
    });
    const kartaModes = [
      { code: 'KARTA_1V1_10', name: 'Karta Lat Lat 1v1 - 10 ETB', stakeAmountMinor: 1000n },
      { code: 'KARTA_1V1_20', name: 'Karta Lat Lat 1v1 - 20 ETB', stakeAmountMinor: 2000n },
      { code: 'KARTA_1V1_50', name: 'Karta Lat Lat 1v1 - 50 ETB', stakeAmountMinor: 5000n },
    ];
    for (const mode of kartaModes) {
      const data = {
        gameId: karta.id,
        name: mode.name,
        playerCount: 2,
        stakeAmountMinor: mode.stakeAmountMinor,
        platformFeeBps: 0,
        turnDurationSeconds: 15,
        rulesVersion: 'KARTA_LATLAT_V1',
        enabled: true,
      };
      await prisma.gameMode.upsert({ where: { code: mode.code }, update: data, create: { code: mode.code, ...data } });
    }

    console.log(`Seeded admins ${seededPhones.join(', ')}, ${BOT_ACCOUNTS.length} practice bots, Ludo, Dama and Karta game catalog.`);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
