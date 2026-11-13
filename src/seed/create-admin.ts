import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { hash } from 'bcryptjs';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client';
import { UserRole, UserStatus } from '../generated/prisma/enums';
import { normalizeEthiopianPhone } from '../common/utils/phone.util';

/**
 * One-time production admin. Asks for name, phone, and password in the terminal.
 * Does not change an existing account. Run inside the API container:
 * node dist/seed/create-admin.js
 */

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  return rl.question(question).finally(() => rl.close());
}

function askHidden(question: string): Promise<string> {
  const setRawMode = stdin.setRawMode?.bind(stdin);
  if (!stdin.isTTY || !setRawMode) {
    return Promise.reject(
      new Error(
        'Run this in an interactive terminal so the password is not stored in the command.',
      ),
    );
  }

  stdout.write(question);
  setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return new Promise((resolve) => {
    let value = '';
    const finish = (result: string) => {
      setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stdout.write('\n');
      resolve(result);
    };
    const onData = (chunk: string) => {
      if (chunk.includes('\u0003')) {
        setRawMode(false);
        stdin.off('data', onData);
        stdout.write('\n');
        process.exit(1);
      }
      const lineEnd = chunk.search(/\r|\n/);
      if (lineEnd !== -1) {
        finish(value + chunk.slice(0, lineEnd));
        return;
      }
      if (chunk === '\u007f' || chunk === '\b') {
        value = value.slice(0, -1);
        return;
      }
      if (chunk.startsWith('\u001b')) return;
      value += chunk;
    };
    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') {
    throw new Error('create-admin must run with NODE_ENV=production.');
  }
  if (!stdin.isTTY) {
    throw new Error(
      'Run this in an interactive terminal so the password is not stored in the command.',
    );
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');

  const fullName = (await ask('Full name: ')).trim();
  if (fullName.length < 2 || fullName.length > 80) {
    throw new Error('Full name must be 2 to 80 characters. Nothing was created.');
  }

  const phoneInput = (await ask('Phone number: ')).trim();
  let phoneNumber: string;
  try {
    phoneNumber = normalizeEthiopianPhone(phoneInput);
  } catch {
    throw new Error('Use a valid Ethiopian mobile number. Nothing was created.');
  }

  const password = await askHidden('Password: ');
  const confirmation = await askHidden('Confirm password: ');
  if (password.length < 8 || password.length > 72) {
    throw new Error('Password must be 8 to 72 characters. Nothing was created.');
  }
  if (password !== confirmation) {
    throw new Error('Passwords did not match. Nothing was created.');
  }

  const passwordHash = await hash(password, 12);
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

  try {
    const existing = await prisma.user.findUnique({
      where: { phoneNumber },
      select: { role: true, status: true },
    });
    if (existing) {
      throw new Error(
        `An account already exists for ${phoneNumber} (role ${existing.role}, status ${existing.status}). Password and role were not changed.`,
      );
    }

    const admin = await prisma.user.create({
      data: {
        fullName,
        phoneNumber,
        passwordHash,
        role: UserRole.ADMIN,
        status: UserStatus.ACTIVE,
        isBot: false,
        wallet: { create: {} },
      },
      select: { id: true, fullName: true, phoneNumber: true, role: true, status: true },
    });

    console.log(
      `Created admin ${admin.fullName} (${admin.phoneNumber}), role ${admin.role}, status ${admin.status}, id ${admin.id}.`,
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new Error(
        `An account already exists for ${phoneNumber}. Password and role were not changed.`,
      );
    }
    if (error instanceof Prisma.PrismaClientInitializationError) {
      throw new Error('Could not connect to the database. Nothing was created.');
    }
    if (error instanceof Error && !error.message.includes('passwordHash')) throw error;
    throw new Error('Could not create the admin account. Nothing was created.');
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : '';
  console.error(
    message && !message.includes('passwordHash')
      ? message
      : 'Could not create the admin account. Nothing was created.',
  );
  process.exit(1);
});
