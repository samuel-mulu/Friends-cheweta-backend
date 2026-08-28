import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { UserRole, UserStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async createPlayerWithWallet(input: {
    fullName: string;
    phoneNumber: string;
    passwordHash: string;
  }) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        return tx.user.create({
          data: {
            fullName: input.fullName,
            phoneNumber: input.phoneNumber,
            passwordHash: input.passwordHash,
            role: UserRole.PLAYER,
            wallet: { create: {} },
          },
          include: { wallet: true },
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({
          code: 'PHONE_ALREADY_REGISTERED',
          message: 'An account already exists with this phone number.',
        });
      }
      throw error;
    }
  }

  findByPhone(phoneNumber: string) {
    return this.prisma.user.findUnique({ where: { phoneNumber } });
  }

  findById(id: string) {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async getRequiredById(id: string) {
    const user = await this.findById(id);
    if (!user) {
      throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found.' });
    }
    return user;
  }

  list(limit = 50) {
    return this.prisma.user.findMany({
      take: Math.min(limit, 100),
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        fullName: true,
        phoneNumber: true,
        role: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async updateStatus(id: string, status: UserStatus) {
    await this.getRequiredById(id);
    return this.prisma.user.update({
      where: { id },
      data: { status },
      select: {
        id: true,
        fullName: true,
        phoneNumber: true,
        role: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }
}
