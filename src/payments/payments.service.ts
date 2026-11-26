import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { AuditService } from '../audit/audit.service';
import { normalizeEthiopianPhone } from '../common/utils/phone.util';
import { withFinancialTiming } from '../common/utils/financial-instrumentation.util';
import { Deposit, Prisma, Withdrawal } from '../generated/prisma/client';
import { PaymentStatus, WalletTransactionType } from '../generated/prisma/enums';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimePublisherService } from '../realtime/realtime-publisher.service';
import { GeezSmsService } from '../sms/geez-sms.service';
import { WalletService } from '../wallet/wallet.service';
import { DepositConfigService } from './deposit-config.service';
import { CreateWithdrawalDto } from './dto/create-withdrawal.dto';

const playerSelect = { id: true, fullName: true, phoneNumber: true } as const;
type DepositApproval = { adminUserId: string } | { lease: Date; mode: 'LOCAL' | 'AUTOMATIC' };

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    private readonly config: DepositConfigService,
    private readonly sms: GeezSmsService,
    private readonly realtime: RealtimePublisherService,
  ) {}

  async createWithdrawal(userId: string, dto: CreateWithdrawalDto) {
    const passwordHash = await this.auth.verifyPassword(userId, dto.password);
    const amountMinor = this.parseAmount(dto.amountMinor);
    if (dto.channel !== 'TELEBIRR' && dto.channel !== 'CBE') {
      throw new BadRequestException('Unsupported withdrawal provider.');
    }
    const destination =
      dto.channel === 'TELEBIRR'
        ? normalizeEthiopianPhone(dto.destination)
        : dto.destination.trim();
    if (dto.channel === 'CBE' && !/^\d{6,32}$/.test(destination)) {
      throw new BadRequestException('Enter a valid CBE account number.');
    }
    const key = dto.idempotencyKey.trim();
    if (!key) throw new BadRequestException('An idempotency key is required.');
    const retry = (row: Withdrawal) => {
      if (
        row.userId !== userId ||
        row.amountMinor !== amountMinor ||
        row.destination !== destination ||
        row.channel !== dto.channel
      ) {
        throw new ConflictException({
          code: 'PAYMENT_REQUEST_CONFLICT',
          message: 'This request key has already been used.',
        });
      }
      return this.serializeWithdrawal(row);
    };
    const previous = await this.prisma.withdrawal.findUnique({ where: { idempotencyKey: key } });
    if (previous) return retry(previous);
    try {
      const row = await withFinancialTiming(this.logger, 'WITHDRAWAL_CREATE', { userId }, () =>
        this.prisma.$transaction(async (tx) => {
          await this.auth.assertCurrentCredential(tx, userId, passwordHash);
          const created = await tx.withdrawal.create({
            data: {
              userId,
              amountMinor,
              channel: dto.channel,
              destination,
              idempotencyKey: key,
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
      this.publishWallet(userId);
      void this.sms.notifyWithdrawal(amountMinor, dto.channel);
      return this.serializeWithdrawal(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const duplicate = await this.prisma.withdrawal.findUnique({
          where: { idempotencyKey: key },
        });
        if (duplicate) return retry(duplicate);
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
      include: { user: { select: playerSelect } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((row) => this.serializeDeposit(row));
  }

  async listWithdrawals(status?: PaymentStatus, limit = 50) {
    const rows = await this.prisma.withdrawal.findMany({
      where: status ? { status } : undefined,
      include: { user: { select: playerSelect } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((row) => this.serializeWithdrawal(row));
  }

  async approveDeposit(id: string, adminUserId: string, approvalPin: string) {
    await this.config.assertApprovalPin(approvalPin);
    return this.finalizeDeposit(id, { adminUserId });
  }

  async finalizeDeposit(id: string, approval: DepositApproval) {
    const current = await this.getDeposit(id);
    const manual = 'adminUserId' in approval;
    if (current.status !== 'PENDING') {
      if (manual && current.status !== 'APPROVED')
        throw new ConflictException('This deposit was already reviewed.');
      return this.serializeDeposit(current);
    }
    if (manual && current.verificationStatus) {
      throw new ConflictException('This deposit is being verified by a provider.');
    }
    const approved = await withFinancialTiming(
      this.logger,
      'DEPOSIT_APPROVAL',
      { depositId: id },
      () =>
        this.prisma.$transaction(async (tx) => {
          const now = new Date();
          const changed = await tx.deposit.updateMany({
            where: {
              id,
              status: 'PENDING',
              ...(manual
                ? { verificationStatus: null }
                : {
                    verificationStatus: 'VERIFYING',
                    nextCheckAt: approval.lease,
                    attemptExpiresAt: { gt: now },
                  }),
            },
            data: {
              status: 'APPROVED',
              reviewedAt: now,
              reviewedByUserId: manual ? approval.adminUserId : null,
              approvalMode: manual ? 'MANUAL' : approval.mode,
              verificationStatus: manual ? null : 'SUCCEEDED',
              nextCheckAt: null,
              lastVerificationCode: null,
            },
          });
          if (!changed.count) return false;
          await this.walletService.creditAvailableInTransaction(tx, {
            userId: current.userId,
            amountMinor: current.amountMinor,
            type: WalletTransactionType.DEPOSIT,
            idempotencyKey: `deposit:approve:${id}`,
            referenceType: 'DEPOSIT',
            referenceId: id,
          });
          await this.audit.write(
            {
              actorUserId: manual ? approval.adminUserId : undefined,
              action: 'DEPOSIT_APPROVED',
              entityType: 'DEPOSIT',
              entityId: id,
              metadata: { mode: manual ? 'MANUAL' : approval.mode },
            },
            tx,
          );
          return true;
        }),
    );
    if (approved)
      await this.followUp(
        current.userId,
        'DEPOSIT_APPROVED',
        id,
        'Deposit approved',
        'Your deposit was credited.',
      );
    const updated = await this.getDeposit(id);
    if (manual && updated.status !== 'APPROVED')
      throw new ConflictException('This deposit was already reviewed.');
    return this.serializeDeposit(updated);
  }

  async rejectDeposit(id: string, adminUserId: string, reason: string) {
    const current = await this.getDeposit(id);
    if (current.status === 'REJECTED') return this.serializeDeposit(current);
    if (current.status !== 'PENDING' || current.verificationStatus) {
      throw new ConflictException('This deposit is unavailable for manual review.');
    }
    const rejected = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.deposit.updateMany({
        where: { id, status: 'PENDING', verificationStatus: null },
        data: {
          status: 'REJECTED',
          reviewedByUserId: adminUserId,
          reviewedAt: new Date(),
          rejectionReason: reason.trim(),
          referenceKey: null,
        },
      });
      if (!changed.count) return false;
      await this.audit.write(
        {
          actorUserId: adminUserId,
          action: 'DEPOSIT_REJECTED',
          entityType: 'DEPOSIT',
          entityId: id,
        },
        tx,
      );
      return true;
    });
    if (!rejected) throw new ConflictException('This deposit was already reviewed.');
    await this.followUp(
      current.userId,
      'DEPOSIT_REJECTED',
      id,
      'Deposit rejected',
      'Your deposit was rejected.',
    );
    return this.serializeDeposit(await this.getDeposit(id));
  }

  async reviewWithdrawal(
    id: string,
    adminUserId: string,
    review: { payoutUrl: string } | { reason: string },
  ) {
    const current = await this.getWithdrawal(id);
    const paid = 'payoutUrl' in review;
    const status = paid ? 'PAID' : 'REJECTED';
    if (current.status === status) return this.serializeWithdrawal(current);
    if (current.status !== 'PENDING')
      throw new ConflictException('This withdrawal was already reviewed.');

    const reviewed = await withFinancialTiming(
      this.logger,
      paid ? 'WITHDRAWAL_APPROVAL' : 'WITHDRAWAL_REJECTION',
      { withdrawalId: id },
      () =>
        this.prisma.$transaction(async (tx) => {
          const reviewedAt = new Date();
          const changed = await tx.withdrawal.updateMany({
            where: { id, status: 'PENDING' },
            data: {
              status,
              reviewedByUserId: adminUserId,
              reviewedAt,
              ...(paid
                ? { paidAt: reviewedAt, payoutTransactionUrl: review.payoutUrl }
                : { rejectionReason: review.reason.trim() }),
            },
          });
          if (!changed.count) return false;
          const transaction = {
            userId: current.userId,
            amountMinor: current.amountMinor,
            referenceType: 'WITHDRAWAL',
            referenceId: id,
          };
          if (paid) {
            await this.walletService.debitLockedInTransaction(tx, {
              ...transaction,
              type: WalletTransactionType.WITHDRAWAL_PAYOUT,
              idempotencyKey: `withdrawal:approve:${id}`,
              metadata: { action: 'PAYOUT_CONFIRMED' },
            });
          } else {
            await this.walletService.releaseFundsInTransaction(tx, {
              ...transaction,
              type: WalletTransactionType.WITHDRAWAL_RELEASE,
              idempotencyKey: `withdrawal:reject:${id}`,
              metadata: { action: 'RELEASE_REJECTED_WITHDRAWAL' },
            });
          }
          await this.audit.write(
            {
              actorUserId: adminUserId,
              action: `WITHDRAWAL_${status}`,
              entityType: 'WITHDRAWAL',
              entityId: id,
            },
            tx,
          );
          return true;
        }),
    );
    const label = paid ? 'Withdrawal paid' : 'Withdrawal rejected';
    if (reviewed) {
      await this.followUp(
        current.userId,
        `WITHDRAWAL_${status}`,
        id,
        label,
        paid ? 'Your withdrawal was paid.' : 'Your reserved funds were returned.',
      );
    }
    const updated = await this.getWithdrawal(id);
    if (updated.status !== status)
      throw new ConflictException('This withdrawal was already reviewed.');
    return this.serializeWithdrawal(updated);
  }

  parseAmount(value: string): bigint {
    const amount = BigInt(value);
    if (amount <= 0n)
      throw new BadRequestException({
        code: 'INVALID_AMOUNT',
        message: 'Amount must be greater than zero.',
      });
    return amount;
  }

  serializeDeposit<T extends Deposit>(row: T) {
    const { amountMinor, referenceKey, providerRequestId, idempotencyKey, ...publicFields } = row;
    return { ...publicFields, amountMinor: amountMinor.toString() };
  }

  private serializeWithdrawal<T extends Withdrawal>(row: T) {
    return { ...row, amountMinor: row.amountMinor.toString() };
  }

  private async followUp(
    userId: string,
    action: string,
    entityId: string,
    title: string,
    message: string,
  ) {
    this.publishWallet(userId);
    try {
      await this.notifications.create({
        userId,
        type: action,
        title,
        message,
        data: { entityId },
        dedupeKey: `payment:${action}:${entityId}`,
      });
    } catch {
      this.logger.warn(`Payment notification failed for ${entityId}`);
    }
  }

  private publishWallet(userId: string) {
    this.realtime.publishUser(userId, 'wallet:updated', {});
  }

  private async getDeposit(id: string) {
    const row = await this.prisma.deposit.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Deposit not found.');
    return row;
  }

  private async getWithdrawal(id: string) {
    const row = await this.prisma.withdrawal.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Withdrawal not found.');
    return row;
  }
}
