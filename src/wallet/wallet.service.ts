import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { WalletTransactionType } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

export type WalletMutationInput = {
  userId: string;
  amountMinor: bigint;
  type: WalletTransactionType;
  idempotencyKey: string;
  referenceType?: string;
  referenceId?: string;
  metadata?: Prisma.InputJsonValue;
};

type WalletDbClient = PrismaService | Prisma.TransactionClient;

@Injectable()
export class WalletService {
  constructor(private readonly prisma: PrismaService) {}

  async getByUserId(userId: string) {
    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) {
      throw new NotFoundException({ code: 'WALLET_NOT_FOUND', message: 'Wallet not found.' });
    }
    return wallet;
  }

  async getPublicWallet(userId: string) {
    return this.serializeWallet(await this.getByUserId(userId));
  }

  async getAdminWallet(userId: string) {
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId },
      include: {
        user: { select: { id: true, fullName: true, phoneNumber: true, status: true } },
      },
    });
    if (!wallet) {
      throw new NotFoundException({ code: 'WALLET_NOT_FOUND', message: 'Wallet not found.' });
    }
    return {
      ...this.serializeWallet(wallet),
      user: wallet.user,
    };
  }

  async listAdminTransactions(params: {
    type?: WalletTransactionType;
    userId?: string;
    limit?: number;
  } = {}) {
    const limit = Math.min(Math.max(params.limit ?? 100, 1), 100);
    const rows = await this.prisma.walletTransaction.findMany({
      where: {
        ...(params.type ? { type: params.type } : {}),
        ...(params.userId ? { wallet: { userId: params.userId } } : {}),
      },
      include: {
        wallet: {
          select: {
            id: true,
            currency: true,
            user: { select: { id: true, fullName: true, phoneNumber: true } },
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });

    return rows.map((row) => ({
      ...this.serializeTransaction(row),
      walletId: row.walletId,
      currency: row.wallet.currency,
      user: row.wallet.user,
    }));
  }

  async listTransactions(userId: string, limit: number, cursor?: string) {
    const wallet = await this.getByUserId(userId);
    const rows = await this.prisma.walletTransaction.findMany({
      where: { walletId: wallet.id },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    return {
      items: items.map((row) => this.serializeTransaction(row)),
      nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null,
    };
  }

  creditAvailable(input: WalletMutationInput) {
    return this.mutate(input, input.amountMinor, 0n, 'credit');
  }

  debitAvailable(input: WalletMutationInput) {
    return this.mutate(input, -input.amountMinor, 0n, 'available');
  }

  lockFunds(input: WalletMutationInput) {
    return this.mutate(input, -input.amountMinor, input.amountMinor, 'available');
  }

  releaseFunds(input: WalletMutationInput) {
    return this.mutate(input, input.amountMinor, -input.amountMinor, 'locked');
  }

  debitLocked(input: WalletMutationInput) {
    return this.mutate(input, 0n, -input.amountMinor, 'locked');
  }

  creditAvailableInTransaction(tx: Prisma.TransactionClient, input: WalletMutationInput) {
    return this.mutateWithClient(tx, input, input.amountMinor, 0n, 'credit');
  }

  lockFundsInTransaction(tx: Prisma.TransactionClient, input: WalletMutationInput) {
    return this.mutateWithClient(tx, input, -input.amountMinor, input.amountMinor, 'available');
  }

  releaseFundsInTransaction(tx: Prisma.TransactionClient, input: WalletMutationInput) {
    return this.mutateWithClient(tx, input, input.amountMinor, -input.amountMinor, 'locked');
  }

  debitLockedInTransaction(tx: Prisma.TransactionClient, input: WalletMutationInput) {
    return this.mutateWithClient(tx, input, 0n, -input.amountMinor, 'locked');
  }

  private async mutate(
    input: WalletMutationInput,
    availableDelta: bigint,
    lockedDelta: bigint,
    requiredBalance: 'credit' | 'available' | 'locked',
  ) {
    this.validateMutation(input);

    const existing = await this.prisma.walletTransaction.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) return this.serializeTransaction(existing);

    try {
      const transaction = await this.prisma.$transaction((tx) =>
        this.mutateWithClient(tx, input, availableDelta, lockedDelta, requiredBalance),
      );
      return this.serializeTransaction(transaction);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const duplicate = await this.prisma.walletTransaction.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (duplicate) return this.serializeTransaction(duplicate);
      }
      throw error;
    }
  }

  // DB2: this intentionally issues exactly 4 queries - (1) idempotency
  // lookup, (2) wallet lookup (also gives us the before-balances), (3) the
  // guarded conditional update (the sole correctness guard - double-spend
  // protection lives entirely in this WHERE clause + the count===1 check),
  // (4) the ledger insert. The after-balances are derived arithmetically
  // from the before-balances we already have plus the known delta, which
  // removes a previously-redundant post-update re-read without weakening
  // the guard: the guarded `updateMany` is still the only thing that
  // decides whether the mutation succeeded.
  private async mutateWithClient(
    db: WalletDbClient,
    input: WalletMutationInput,
    availableDelta: bigint,
    lockedDelta: bigint,
    requiredBalance: 'credit' | 'available' | 'locked',
  ) {
    this.validateMutation(input);

    const existing = await db.walletTransaction.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) return existing;

    const wallet = await db.wallet.findUnique({ where: { userId: input.userId } });
    if (!wallet) {
      throw new NotFoundException({ code: 'WALLET_NOT_FOUND', message: 'Wallet not found.' });
    }

    const where: Prisma.WalletWhereInput = { id: wallet.id };
    if (requiredBalance === 'available') where.availableBalance = { gte: input.amountMinor };
    if (requiredBalance === 'locked') where.lockedBalance = { gte: input.amountMinor };

    const updated = await db.wallet.updateMany({
      where,
      data: {
        ...(availableDelta !== 0n ? { availableBalance: { increment: availableDelta } } : {}),
        ...(lockedDelta !== 0n ? { lockedBalance: { increment: lockedDelta } } : {}),
      },
    });

    if (updated.count !== 1) {
      throw new BadRequestException({
        code: requiredBalance === 'locked' ? 'INSUFFICIENT_LOCKED_BALANCE' : 'INSUFFICIENT_BALANCE',
        message:
          requiredBalance === 'locked'
            ? 'Insufficient locked balance.'
            : 'Insufficient available balance.',
      });
    }

    const beforeAvailable = wallet.availableBalance;
    const beforeLocked = wallet.lockedBalance;
    const afterAvailable = beforeAvailable + availableDelta;
    const afterLocked = beforeLocked + lockedDelta;

    return db.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: input.type,
        amountMinor: input.amountMinor,
        availableDelta,
        lockedDelta,
        availableBalanceBefore: beforeAvailable,
        availableBalanceAfter: afterAvailable,
        lockedBalanceBefore: beforeLocked,
        lockedBalanceAfter: afterLocked,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        idempotencyKey: input.idempotencyKey,
        metadata: input.metadata,
      },
    });
  }

  private validateMutation(input: WalletMutationInput): void {
    if (input.amountMinor <= 0n) {
      throw new BadRequestException({ code: 'INVALID_AMOUNT', message: 'Amount must be greater than zero.' });
    }
    if (!input.idempotencyKey.trim()) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'A non-empty idempotency key is required.',
      });
    }
  }

  private serializeWallet(wallet: {
    id: string;
    currency: string;
    availableBalance: bigint;
    lockedBalance: bigint;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: wallet.id,
      currency: wallet.currency,
      availableBalance: wallet.availableBalance.toString(),
      lockedBalance: wallet.lockedBalance.toString(),
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  }

  private serializeTransaction(row: {
    id: string;
    type: WalletTransactionType;
    amountMinor: bigint;
    availableDelta: bigint;
    lockedDelta: bigint;
    availableBalanceBefore: bigint;
    availableBalanceAfter: bigint;
    lockedBalanceBefore: bigint;
    lockedBalanceAfter: bigint;
    referenceType: string | null;
    referenceId: string | null;
    idempotencyKey: string;
    metadata: unknown;
    createdAt: Date;
  }) {
    return {
      id: row.id,
      type: row.type,
      amountMinor: row.amountMinor.toString(),
      availableDelta: row.availableDelta.toString(),
      lockedDelta: row.lockedDelta.toString(),
      availableBalanceBefore: row.availableBalanceBefore.toString(),
      availableBalanceAfter: row.availableBalanceAfter.toString(),
      lockedBalanceBefore: row.lockedBalanceBefore.toString(),
      lockedBalanceAfter: row.lockedBalanceAfter.toString(),
      referenceType: row.referenceType,
      referenceId: row.referenceId,
      idempotencyKey: row.idempotencyKey,
      metadata: row.metadata,
      createdAt: row.createdAt,
    };
  }
}
