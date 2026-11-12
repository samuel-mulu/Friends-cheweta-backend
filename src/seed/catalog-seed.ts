import { randomBytes } from 'node:crypto';
import { hash } from 'bcryptjs';
import { PrismaClient } from '../generated/prisma/client';
import { UserRole, UserStatus } from '../generated/prisma/enums';
import { normalizeEthiopianPhone } from '../common/utils/phone.util';
import { PRACTICE_BOTS } from '../practice/practice.constants';

const BOT_ACCOUNTS = Object.values(PRACTICE_BOTS);

/**
 * Games, stake modes, and practice bots. No human accounts and no passwords
 * that anyone can log in with. Safe to run against a production database.
 */
export async function seedCatalog(prisma: PrismaClient): Promise<{ bots: number }> {
  for (const bot of BOT_ACCOUNTS) {
    const phoneNumber = normalizeEthiopianPhone(bot.phone);
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

  const ludoModes = [
    { code: 'LUDO_1V1_10', name: 'Ludo 1v1 - 10 ETB', stakeAmountMinor: 1000n },
    { code: 'LUDO_1V1_20', name: 'Ludo 1v1 - 20 ETB', stakeAmountMinor: 2000n },
    { code: 'LUDO_1V1_50', name: 'Ludo 1v1 - 50 ETB', stakeAmountMinor: 5000n },
  ];
  for (const mode of ludoModes) {
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

  return { bots: BOT_ACCOUNTS.length };
}
