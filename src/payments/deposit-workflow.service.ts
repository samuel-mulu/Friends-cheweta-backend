import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Deposit, Prisma } from '../generated/prisma/client';
import { PaymentChannel } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { DepositConfigService } from './deposit-config.service';
import { DepositVerifierService } from './deposit-verifier.service';
import { CreateDepositDto } from './dto/create-deposit.dto';
import { DepositReferenceDto } from './dto/payment-settings.dto';
import { PaymentsService } from './payments.service';

@Injectable()
export class DepositWorkflowService {
  private readonly logger = new Logger(DepositWorkflowService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly depositConfig: DepositConfigService,
    private readonly verifier: DepositVerifierService,
    private readonly payments: PaymentsService,
  ) {}

  async checkReference(dto: DepositReferenceDto) {
    const reference = this.reference(dto.channel, dto.transactionReference);
    const existing = await this.findReference(this.prisma, dto.channel, reference);
    return { available: !existing || this.isExpired(existing), transactionReference: reference };
  }

  async preview(dto: DepositReferenceDto, amountMinor: string) {
    const reference = this.reference(dto.channel, dto.transactionReference);
    const provider = await this.prisma.depositProviderConfig.findUnique({
      where: { channel: 'TELEBIRR' },
    });
    if (
      dto.channel !== 'TELEBIRR' ||
      !provider?.enabled ||
      this.depositConfig.effectiveMode(provider.approvalMode, provider.fallbackUntil) !== 'LOCAL'
    ) {
      throw new BadRequestException('Local Telebirr receipt preview is unavailable.');
    }
    const result = await this.verifier.local(reference, this.payments.parseAmount(amountMinor));
    return {
      available: result.outcome === 'verified',
      code: result.outcome === 'invalid' ? result.code : null,
    };
  }

  async create(userId: string, dto: CreateDepositDto) {
    const amountMinor = this.payments.parseAmount(dto.amountMinor);
    const reference = this.reference(dto.channel, dto.transactionReference);
    const key = dto.idempotencyKey.trim();
    if (!key) throw new BadRequestException('An idempotency key is required.');
    const referenceKey = `${dto.channel}:${reference.toUpperCase()}`;
    let deposit: Deposit;
    try {
      deposit = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${referenceKey}, 0))`;
        const previous = await tx.deposit.findUnique({ where: { idempotencyKey: key } });
        if (previous)
          return this.validateRetry(previous, userId, dto.channel, reference, amountMinor);
        const provider = await tx.depositProviderConfig.findUnique({
          where: { channel: dto.channel },
        });
        if (!provider?.enabled) throw new BadRequestException('This deposit provider is disabled.');
        if (!this.depositConfig.settlement(dto.channel).account) {
          throw new BadRequestException(
            'Settlement instructions are unavailable for this provider.',
          );
        }
        const conflicting = await this.findReference(tx, dto.channel, reference);
        if (conflicting && !this.isExpired(conflicting)) throw this.referenceUsed();
        if (conflicting) {
          const expired = await tx.deposit.updateMany({
            where: { id: conflicting.id, status: 'PENDING', attemptExpiresAt: { lte: new Date() } },
            data: {
              status: 'REJECTED',
              referenceKey: null,
              verificationStatus: 'EXPIRED',
              lastVerificationCode: 'VERIFICATION_EXPIRED',
              nextCheckAt: null,
            },
          });
          if (!expired.count) throw this.referenceUsed();
        }

        const mode = this.depositConfig.effectiveMode(
          provider.approvalMode,
          provider.fallbackUntil,
        );
        const manual = mode === 'MANUAL';
        return tx.deposit.create({
          data: {
            userId,
            amountMinor,
            referenceKey,
            channel: dto.channel,
            transactionReference: reference,
            idempotencyKey: key,
            note: dto.note?.trim() || null,
            approvalMode: mode,
            verificationStatus: manual ? null : 'READY',
            attemptExpiresAt: manual ? null : new Date(Date.now() + 15 * 60_000),
          },
        });
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'))
        throw error;
      const previous = await this.prisma.deposit.findUnique({ where: { idempotencyKey: key } });
      if (!previous) throw this.referenceUsed();
      deposit = this.validateRetry(previous, userId, dto.channel, reference, amountMinor);
    }
    if (deposit.status === 'PENDING' && deposit.verificationStatus)
      return this.check(userId, deposit.id);
    return this.payments.serializeDeposit(deposit);
  }

  async active(userId: string) {
    const attempts = await this.prisma.deposit.findMany({
      where: { userId, status: 'PENDING', verificationStatus: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const current = await Promise.all(attempts.map((attempt) => this.expire(attempt)));
    return current
      .filter((attempt) => attempt.status === 'PENDING')
      .map((attempt) => this.payments.serializeDeposit(attempt));
  }

  async check(userId: string, id: string) {
    const deposit = await this.expire(await this.ownedAttempt(userId, id));
    if (deposit.status !== 'PENDING' || (deposit.nextCheckAt && deposit.nextCheckAt > new Date())) {
      return this.payments.serializeDeposit(deposit);
    }
    // Persist a short lease before contacting the provider. A retry after a
    // process crash reuses the provider request ID or deterministic POST key.
    const now = new Date();
    const lease = new Date(now.getTime() + 20_000);
    const leaseClaim = await this.prisma.deposit.updateMany({
      where: { id, status: 'PENDING', OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: now } }] },
      data: { verificationStatus: 'VERIFYING', nextCheckAt: lease },
    });
    if (leaseClaim.count !== 1)
      return this.payments.serializeDeposit(await this.ownedAttempt(userId, id));

    const provider = await this.prisma.depositProviderConfig.findUnique({
      where: { channel: deposit.channel },
    });
    const useFallback =
      deposit.approvalMode === 'LOCAL' &&
      provider?.approvalMode === 'LOCAL_WITH_FALLBACK' &&
      this.depositConfig.effectiveMode(provider.approvalMode, provider.fallbackUntil) ===
        'AUTOMATIC';
    const mode = useFallback ? 'AUTOMATIC' : deposit.approvalMode;
    const result =
      mode === 'LOCAL'
        ? await this.verifier.local(deposit.transactionReference, deposit.amountMinor)
        : await this.verifier.automatic(
            deposit.channel,
            deposit.transactionReference,
            deposit.amountMinor,
            deposit.providerRequestId,
          );

    if (result.outcome === 'verified') {
      return this.payments.finalizeDeposit(id, {
        lease,
        mode: mode === 'LOCAL' ? 'LOCAL' : 'AUTOMATIC',
      });
    }
    if (result.outcome === 'invalid') return this.close(deposit, 'FAILED', result.code, lease);

    await this.prisma.deposit.updateMany({
      where: { id, status: 'PENDING', nextCheckAt: lease },
      data: {
        approvalMode: mode,
        verificationStatus: result.outcome === 'pending' ? 'AWAITING_PROVIDER' : 'UNAVAILABLE',
        lastVerificationCode:
          result.outcome === 'pending' ? 'VERIFICATION_PENDING' : 'VERIFICATION_UNAVAILABLE',
        providerRequestId: result.requestId ?? deposit.providerRequestId,
        nextCheckAt: new Date(Date.now() + 5000),
      },
    });
    if (mode === 'LOCAL' && result.outcome === 'unavailable' && deposit.referenceKey) {
      await this.depositConfig.recordLocalFailure(deposit.referenceKey);
    }
    this.logger.debug(`Deposit verification ${result.outcome} attempt=${id} mode=${mode}`);
    return this.payments.serializeDeposit(await this.ownedAttempt(userId, id));
  }

  async cancel(userId: string, id: string) {
    const deposit = await this.ownedAttempt(userId, id);
    return this.close(deposit, 'CANCELLED', 'VERIFICATION_CANCELLED');
  }

  private async expire(deposit: Deposit) {
    if (this.isExpired(deposit)) {
      await this.close(deposit, 'EXPIRED', 'VERIFICATION_EXPIRED');
      return this.ownedAttempt(deposit.userId, deposit.id);
    }
    return deposit;
  }

  private isExpired(deposit: Deposit) {
    return (
      deposit.status === 'PENDING' &&
      deposit.attemptExpiresAt !== null &&
      deposit.attemptExpiresAt <= new Date()
    );
  }

  private async close(
    deposit: Deposit,
    status: 'FAILED' | 'CANCELLED' | 'EXPIRED',
    code: string,
    lease?: Date,
  ) {
    await this.prisma.deposit.updateMany({
      where: { id: deposit.id, status: 'PENDING', ...(lease ? { nextCheckAt: lease } : {}) },
      data: {
        status: 'REJECTED',
        verificationStatus: status,
        referenceKey: null,
        nextCheckAt: null,
        lastVerificationCode: code,
      },
    });
    return this.payments.serializeDeposit(await this.ownedAttempt(deposit.userId, deposit.id));
  }

  private async ownedAttempt(userId: string, id: string) {
    const deposit = await this.prisma.deposit.findFirst({
      where: { id, userId, verificationStatus: { not: null } },
    });
    if (!deposit) throw new NotFoundException('Deposit verification attempt was not found.');
    return deposit;
  }

  private reference(channel: PaymentChannel, input: string) {
    let reference = input.trim();
    if (channel === 'CBE' && reference.startsWith('https://')) {
      try {
        const base = new URL(
          this.config.get<string>('CBE_RECEIPT_BASE_URL') || 'https://mbreciept.cbe.com.et/receipt',
        );
        const url = new URL(reference);
        if (url.origin === base.origin) {
          const prefix = base.pathname.replace(/\/$/, '') + '/';
          const pathReference = url.pathname.startsWith(prefix)
            ? url.pathname.slice(prefix.length)
            : '';
          reference =
            url.searchParams.get('id') ??
            url.searchParams.get('token') ??
            url.searchParams.get('reference') ??
            url.searchParams.get('ref') ??
            pathReference;
        }
      } catch {
        // Invalid URLs are rejected by the reference validation below.
      }
    }
    if (!/^[A-Za-z0-9-]{6,120}$/.test(reference)) {
      throw new BadRequestException({
        code: 'INVALID_DEPOSIT_REFERENCE',
        message: 'Enter a valid transaction reference.',
      });
    }
    const upper = reference.toUpperCase();
    return channel === 'CBE' && !upper.startsWith('FT') ? reference : upper;
  }

  private findReference(tx: Prisma.TransactionClient, channel: PaymentChannel, reference: string) {
    return tx.deposit.findFirst({
      where: {
        channel,
        transactionReference: { equals: reference, mode: 'insensitive' },
        status: { in: ['PENDING', 'APPROVED'] },
      },
    });
  }

  private validateRetry(
    row: Deposit,
    userId: string,
    channel: PaymentChannel,
    reference: string,
    amountMinor: bigint,
  ) {
    if (
      row.userId !== userId ||
      row.channel !== channel ||
      row.transactionReference.toUpperCase() !== reference.toUpperCase() ||
      row.amountMinor !== amountMinor
    ) {
      throw new ConflictException({
        code: 'PAYMENT_REQUEST_CONFLICT',
        message: 'This request key has already been used.',
      });
    }
    return row;
  }

  private referenceUsed() {
    return new ConflictException({
      code: 'DEPOSIT_REFERENCE_ALREADY_USED',
      message: 'This transaction reference is already in use.',
    });
  }
}
