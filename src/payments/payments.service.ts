import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PaymentStatus, WalletTransactionType } from '../generated/prisma/enums';
import { withFinancialTiming } from '../common/utils/financial-instrumentation.util';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WalletService } from '../wallet/wallet.service';
import { CreateDepositDto } from './dto/create-deposit.dto';
import { CreateWithdrawalDto } from './dto/create-withdrawal.dto';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  async createDeposit(userId: string, dto: CreateDepositDto) {
    const amountMinor = this.parseAmount(dto.amountMinor);
    const existing = await this.prisma.deposit.findUnique({ where: { idempotencyKey: dto.idempotencyKey } });
    if (existing) return this.serializeDeposit(existing);

    const referenceInUse = await this.prisma.deposit.findUnique({
      where: { transactionReference: dto.transactionReference.trim() },
    });
    if (referenceInUse) {
      throw new ConflictException({
        code: 'DEPOSIT_REFERENCE_ALREADY_USED',
        message: 'This transaction reference has already been submitted.',
      });
    }

    try {
      const deposit = await this.prisma.deposit.create({
        data: {
          userId,
          amountMinor,
          channel: dto.channel,
          transactionReference: dto.transactionReference.trim(),
          idempotencyKey: dto.idempotencyKey.trim(),
          note: dto.note?.trim() || null,
        },
      });
      return this.serializeDeposit(deposit);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const duplicate = await this.prisma.deposit.findUnique({ where: { idempotencyKey: dto.idempotencyKey } });
        if (duplicate) return this.serializeDeposit(duplicate);
        throw new ConflictException({
          code: 'DEPOSIT_REFERENCE_ALREADY_USED',
          message: 'This transaction reference has already been submitted.',
        });
      }
      throw error;
    }
  }

  async createWithdrawal(userId: string, dto: CreateWithdrawalDto) {
    const amountMinor = this.parseAmount(dto.amountMinor);
    const existing = await this.prisma.withdrawal.findUnique({ where: { idempotencyKey: dto.idempotencyKey } });
    if (existing) return this.serializeWithdrawal(existing);

    try {
      const withdrawal = await withFinancialTiming(this.logger, 'WITHDRAWAL_CREATE', { userId }, () =>
        this.prisma.$transaction(async (tx) => {
          const created = await tx.withdrawal.create({
            data: {
              userId,
              amountMinor,
              channel: dto.channel,
              destination: dto.destination.trim(),
              idempotencyKey: dto.idempotencyKey.trim(),
              note: dto.note?.trim() || null,
            },
          });

          await this.walletService.lockFundsInTransaction(tx, {
            userId,
            amountMinor,
            type: WalletTransactionType.WITHDRAWAL_LOCK,
            idempotencyKey: `withdrawal:lock:${created.id}`,
            referenceType: 'WITHDRAWAL',
            referenceId: created.id,
            metadata: { action: 'LOCK_FOR_WITHDRAWAL' },
          });

          return created;
        }),
      );

      return this.serializeWithdrawal(withdrawal);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const duplicate = await this.prisma.withdrawal.findUnique({ where: { idempotencyKey: dto.idempotencyKey } });
        if (duplicate) return this.serializeWithdrawal(duplicate);
      }
      throw error;
    }
  }

  async listMyDeposits(userId: string, limit = 50) {
    const rows = await this.prisma.deposit.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((row) => this.serializeDeposit(row));
  }

  async listMyWithdrawals(userId: string, limit = 50) {
    const rows = await this.prisma.withdrawal.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((row) => this.serializeWithdrawal(row));
  }

  async listDeposits(status?: PaymentStatus, limit = 50) {
    const rows = await this.prisma.deposit.findMany({
      where: status ? { status } : undefined,
      include: { user: { select: { id: true, fullName: true, phoneNumber: true } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((row) => ({ ...this.serializeDeposit(row), user: row.user }));
  }

  async listWithdrawals(status?: PaymentStatus, limit = 50) {
    const rows = await this.prisma.withdrawal.findMany({
      where: status ? { status } : undefined,
      include: { user: { select: { id: true, fullName: true, phoneNumber: true } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((row) => ({ ...this.serializeWithdrawal(row), user: row.user }));
  }

  async approveDeposit(id: string, adminUserId: string) {
    const current = await this.getDeposit(id);
    if (current.status === PaymentStatus.APPROVED) return this.serializeDeposit(current);
    if (current.status !== PaymentStatus.PENDING) {
      throw new ConflictException({ code: 'DEPOSIT_NOT_PENDING', message: 'Deposit is not pending.' });
    }

    await withFinancialTiming(this.logger, 'DEPOSIT_APPROVAL', { depositId: id }, () =>
      this.prisma.$transaction(async (tx) => {
        const changed = await tx.deposit.updateMany({
          where: { id, status: PaymentStatus.PENDING },
          data: { status: PaymentStatus.APPROVED, reviewedByUserId: adminUserId, reviewedAt: new Date() },
        });
        if (changed.count !== 1) {
          throw new ConflictException({ code: 'DEPOSIT_ALREADY_REVIEWED', message: 'Deposit was already reviewed.' });
        }

        await this.walletService.creditAvailableInTransaction(tx, {
          userId: current.userId,
          amountMinor: current.amountMinor,
          type: WalletTransactionType.DEPOSIT,
          idempotencyKey: `deposit:approve:${id}`,
          referenceType: 'DEPOSIT',
          referenceId: id,
        });
      }),
    );

    const result = this.serializeDeposit(await this.getDeposit(id));
    await this.paymentFollowUp(current.userId, adminUserId, 'DEPOSIT_APPROVED', id, 'Deposit approved', 'Your deposit was approved.');
    return result;
  }

  async rejectDeposit(id: string, adminUserId: string, reason: string) {
    const current = await this.getDeposit(id);
    if (current.status === PaymentStatus.REJECTED) return this.serializeDeposit(current);
    if (current.status !== PaymentStatus.PENDING) {
      throw new ConflictException({ code: 'DEPOSIT_NOT_PENDING', message: 'Deposit is not pending.' });
    }

    const changed = await this.prisma.deposit.updateMany({
      where: { id, status: PaymentStatus.PENDING },
      data: {
        status: PaymentStatus.REJECTED,
        reviewedByUserId: adminUserId,
        reviewedAt: new Date(),
        rejectionReason: reason.trim(),
      },
    });
    if (changed.count !== 1) {
      throw new ConflictException({ code: 'DEPOSIT_ALREADY_REVIEWED', message: 'Deposit was already reviewed.' });
    }
    const result = this.serializeDeposit(await this.getDeposit(id));
    await this.paymentFollowUp(current.userId, adminUserId, 'DEPOSIT_REJECTED', id, 'Deposit rejected', 'Your deposit was rejected.');
    return result;
  }

  async approveWithdrawal(id: string, adminUserId: string) {
    const current = await this.getWithdrawal(id);
    if (current.status === PaymentStatus.APPROVED) return this.serializeWithdrawal(current);
    if (current.status !== PaymentStatus.PENDING) {
      throw new ConflictException({ code: 'WITHDRAWAL_NOT_PENDING', message: 'Withdrawal is not pending.' });
    }

    await withFinancialTiming(this.logger, 'WITHDRAWAL_APPROVAL', { withdrawalId: id }, () =>
      this.prisma.$transaction(async (tx) => {
        const changed = await tx.withdrawal.updateMany({
          where: { id, status: PaymentStatus.PENDING },
          data: { status: PaymentStatus.APPROVED, reviewedByUserId: adminUserId, reviewedAt: new Date() },
        });
        if (changed.count !== 1) {
          throw new ConflictException({ code: 'WITHDRAWAL_ALREADY_REVIEWED', message: 'Withdrawal was already reviewed.' });
        }

        await this.walletService.debitLockedInTransaction(tx, {
          userId: current.userId,
          amountMinor: current.amountMinor,
          type: WalletTransactionType.WITHDRAWAL_PAYOUT,
          idempotencyKey: `withdrawal:approve:${id}`,
          referenceType: 'WITHDRAWAL',
          referenceId: id,
          metadata: { action: 'PAYOUT_APPROVED' },
        });
      }),
    );

    const result = this.serializeWithdrawal(await this.getWithdrawal(id));
    await this.paymentFollowUp(current.userId, adminUserId, 'WITHDRAWAL_APPROVED', id, 'Withdrawal approved', 'Your withdrawal was approved.');
    return result;
  }

  async rejectWithdrawal(id: string, adminUserId: string, reason: string) {
    const current = await this.getWithdrawal(id);
    if (current.status === PaymentStatus.REJECTED) return this.serializeWithdrawal(current);
    if (current.status !== PaymentStatus.PENDING) {
      throw new ConflictException({ code: 'WITHDRAWAL_NOT_PENDING', message: 'Withdrawal is not pending.' });
    }

    await withFinancialTiming(this.logger, 'WITHDRAWAL_REJECTION', { withdrawalId: id }, () =>
      this.prisma.$transaction(async (tx) => {
        const changed = await tx.withdrawal.updateMany({
          where: { id, status: PaymentStatus.PENDING },
          data: {
            status: PaymentStatus.REJECTED,
            reviewedByUserId: adminUserId,
            reviewedAt: new Date(),
            rejectionReason: reason.trim(),
          },
        });
        if (changed.count !== 1) {
          throw new ConflictException({ code: 'WITHDRAWAL_ALREADY_REVIEWED', message: 'Withdrawal was already reviewed.' });
        }

        await this.walletService.releaseFundsInTransaction(tx, {
          userId: current.userId,
          amountMinor: current.amountMinor,
          type: WalletTransactionType.WITHDRAWAL_RELEASE,
          idempotencyKey: `withdrawal:reject:${id}`,
          referenceType: 'WITHDRAWAL',
          referenceId: id,
          metadata: { action: 'RELEASE_REJECTED_WITHDRAWAL' },
        });
      }),
    );

    const result = this.serializeWithdrawal(await this.getWithdrawal(id));
    await this.paymentFollowUp(current.userId, adminUserId, 'WITHDRAWAL_REJECTED', id, 'Withdrawal rejected', 'Your withdrawal was rejected.');
    return result;
  }

  private async paymentFollowUp(userId: string, adminUserId: string, action: string, entityId: string, title: string, message: string) {
    try {
      await this.notifications.create({
        userId,
        type: action,
        title,
        message,
        data: { entityId },
        dedupeKey: `payment:${action}:${entityId}`,
      });
      await this.audit.write({
        actorUserId: adminUserId,
        action,
        entityType: action.startsWith('DEPOSIT') ? 'DEPOSIT' : 'WITHDRAWAL',
        entityId,
      });
    } catch (error) {
      this.logger.warn(`Payment follow-up failed for ${entityId}: ${(error as Error).message}`);
    }
  }

  private async getDeposit(id: string) {
    const row = await this.prisma.deposit.findUnique({ where: { id } });
    if (!row) throw new NotFoundException({ code: 'DEPOSIT_NOT_FOUND', message: 'Deposit not found.' });
    return row;
  }

  private async getWithdrawal(id: string) {
    const row = await this.prisma.withdrawal.findUnique({ where: { id } });
    if (!row) throw new NotFoundException({ code: 'WITHDRAWAL_NOT_FOUND', message: 'Withdrawal not found.' });
    return row;
  }

  private parseAmount(value: string): bigint {
    const amount = BigInt(value);
    if (amount <= 0n) {
      throw new BadRequestException({ code: 'INVALID_AMOUNT', message: 'Amount must be greater than zero.' });
    }
    return amount;
  }

  private serializeDeposit(row: any) {
    return { ...row, amountMinor: row.amountMinor.toString() };
  }

  private serializeWithdrawal(row: any) {
    return { ...row, amountMinor: row.amountMinor.toString() };
  }
}
