import 'dotenv/config';
import { hash } from 'bcryptjs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { UserRole, UserStatus } from '../src/generated/prisma/enums';
import { normalizeEthiopianPhone } from '../src/common/utils/phone.util';
import { seedCatalog } from '../src/seed/catalog-seed';

const ADMIN_ACCOUNTS = [
  { fullName: 'Friends Admin 1', phone: '0911111111', password: '12345678' },
  { fullName: 'Friends Admin 2', phone: '0911111112', password: '12345678' },
] as const;

/** Local development admins. Refuses to run when NODE_ENV=production. */
async function seedDevAdmins(prisma: PrismaClient): Promise<string[]> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed development admin accounts in production.');
  }

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
  return seededPhones;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for seed.');
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  try {
    const adminPhones = process.env.NODE_ENV === 'production' ? [] : await seedDevAdmins(prisma);
    const { bots } = await seedCatalog(prisma);
    if (adminPhones.length === 0) {
      console.log(`Seeded ${bots} practice bots and the game catalog. Development admin accounts were not created.`);
      return;
    }
    console.log(`Seeded admins ${adminPhones.join(', ')}, ${bots} practice bots, Ludo, Dama and Karta game catalog.`);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
