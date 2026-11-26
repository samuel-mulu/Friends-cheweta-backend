import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { compare, hash } from 'bcryptjs';
import { AuditService } from '../audit/audit.service';
import { Prisma } from '../generated/prisma/client';
import { DepositApprovalMode, PaymentChannel } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateDepositConfigDto } from './dto/payment-settings.dto';

export const depositChannels: readonly PaymentChannel[] = ['CBE', 'TELEBIRR', 'AWASH', 'BOA'];
const standardModes: DepositApprovalMode[] = ['MANUAL', 'AUTOMATIC'];
const telebirrModes: DepositApprovalMode[] = [...standardModes, 'LOCAL', 'LOCAL_WITH_FALLBACK'];

@Injectable()
export class DepositConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  settlement(channel: PaymentChannel) {
    const account = this.config.get<string>(`${channel}_SETTLEMENT_ACCOUNT`)?.trim() || '';
    const receiverName = this.config.get<string>(`${channel}_RECEIVER_NAME`)?.trim() || '';
    return { account, receiverName };
  }

  effectiveMode(mode: DepositApprovalMode, until: Date | null): DepositApprovalMode {
    if (mode !== 'LOCAL_WITH_FALLBACK') return mode;
    return until && until.getTime() > Date.now() ? 'AUTOMATIC' : 'LOCAL';
  }

  async playerConfig() {
    const rows = await this.prisma.depositProviderConfig.findMany({ where: { enabled: true } });
    return rows.map((row) => ({
      channel: row.channel,
      approvalMode: this.effectiveMode(row.approvalMode, row.fallbackUntil),
      ...this.settlement(row.channel),
    }));
  }

  async adminConfig() {
    const rows = await this.prisma.depositProviderConfig.findMany({ orderBy: { channel: 'asc' } });
    const pin = await this.prisma.depositApprovalPin.findUnique({
      where: { id: 1 },
      select: { id: true },
    });
    return {
      hasApprovalPin:
        Boolean(pin) || /^\d{6}$/.test(this.config.get<string>('DEPOSIT_APPROVAL_PIN') ?? ''),
      providers: rows.map((row) => ({
        ...row,
        effectiveMode: this.effectiveMode(row.approvalMode, row.fallbackUntil),
        allowedModes: row.channel === 'TELEBIRR' ? telebirrModes : standardModes,
        settlementConfigured: Boolean(this.settlement(row.channel).account),
      })),
    };
  }

  async update(channel: PaymentChannel, dto: UpdateDepositConfigDto, actorUserId: string) {
    const allowedModes = channel === 'TELEBIRR' ? telebirrModes : standardModes;
    if (!depositChannels.includes(channel) || !allowedModes.includes(dto.approvalMode)) {
      throw new BadRequestException('This deposit mode is unavailable for the provider.');
    }
    if (dto.enabled) this.assertConfigured(channel, dto.approvalMode);
    const {
      enabled,
      approvalMode,
      fallbackThreshold,
      fallbackWindowMinutes,
      fallbackDurationMinutes,
    } = dto;
    await this.prisma.$transaction(async (tx) => {
      if (channel === 'TELEBIRR') await this.lockFallback(tx);
      const previous = await tx.depositProviderConfig.findUniqueOrThrow({ where: { channel } });
      const clearFallback =
        channel === 'TELEBIRR' &&
        (!enabled ||
          approvalMode !== 'LOCAL_WITH_FALLBACK' ||
          previous.approvalMode !== approvalMode);
      await tx.depositProviderConfig.update({
        where: { channel },
        data: {
          enabled,
          approvalMode,
          ...(channel === 'TELEBIRR'
            ? { fallbackThreshold, fallbackWindowMinutes, fallbackDurationMinutes }
            : {}),
          ...(clearFallback ? { fallbackUntil: null, fallbackReason: null } : {}),
        },
      });
      if (clearFallback) await tx.depositLookupFailure.deleteMany();
      await this.audit.write(
        {
          actorUserId,
          action: 'DEPOSIT_CONFIG_UPDATED',
          entityType: 'DEPOSIT_PROVIDER',
          entityId: channel,
          metadata: {
            enabled,
            approvalMode,
            fallbackThreshold,
            fallbackWindowMinutes,
            fallbackDurationMinutes,
          },
        },
        tx,
      );
    });
    return this.adminConfig();
  }

  async resetFallback(actorUserId: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.lockFallback(tx);
      await tx.depositProviderConfig.update({
        where: { channel: 'TELEBIRR' },
        data: { fallbackUntil: null, fallbackReason: null },
      });
      await tx.depositLookupFailure.deleteMany();
      await this.audit.write(
        {
          actorUserId,
          action: 'DEPOSIT_FALLBACK_RESET',
          entityType: 'DEPOSIT_PROVIDER',
          entityId: 'TELEBIRR',
        },
        tx,
      );
    });
    return this.adminConfig();
  }

  async recordLocalFailure(referenceKey: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.lockFallback(tx);
      const row = await tx.depositProviderConfig.findUnique({ where: { channel: 'TELEBIRR' } });
      if (!row?.enabled || row.approvalMode !== 'LOCAL_WITH_FALLBACK') return;
      const now = new Date();
      if (row.fallbackUntil && row.fallbackUntil > now) return;
      const windowStart = new Date(now.getTime() - row.fallbackWindowMinutes * 60_000);
      await tx.depositLookupFailure.deleteMany({ where: { createdAt: { lt: windowStart } } });
      const existing = await tx.depositLookupFailure.findFirst({ where: { referenceKey } });
      if (!existing) await tx.depositLookupFailure.create({ data: { referenceKey } });
      const failures = await tx.depositLookupFailure.count();
      if (failures < row.fallbackThreshold) return;
      const fallbackUntil = new Date(now.getTime() + row.fallbackDurationMinutes * 60_000);
      const fallbackReason = `${failures} Telebirr lookup failures in ${row.fallbackWindowMinutes} minutes`;
      await tx.depositProviderConfig.update({
        where: { channel: 'TELEBIRR' },
        data: { fallbackUntil, fallbackReason },
      });
      await this.audit.write(
        {
          action: 'DEPOSIT_FALLBACK_ACTIVATED',
          entityType: 'DEPOSIT_PROVIDER',
          entityId: 'TELEBIRR',
          metadata: { fallbackUntil, fallbackReason },
        },
        tx,
      );
      await tx.depositLookupFailure.deleteMany();
    });
  }

  async assertApprovalPin(pin: string) {
    const stored = await this.prisma.depositApprovalPin.findUnique({ where: { id: 1 } });
    const initialPin = this.config.get<string>('DEPOSIT_APPROVAL_PIN') ?? '';
    if (!stored && !/^\d{6}$/.test(initialPin)) {
      throw new ServiceUnavailableException('The deposit approval PIN has not been configured.');
    }
    const initialHash = stored?.hash ?? (await hash(initialPin, 10));
    if (!(await compare(pin, initialHash))) {
      throw new ForbiddenException({
        code: 'INVALID_APPROVAL_PIN',
        message: 'Incorrect deposit approval PIN.',
      });
    }
    return stored;
  }

  async changePin(currentPin: string, newPin: string, actorUserId: string) {
    const newHash = await hash(newPin, 10);
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('deposit-approval-pin', 0))`;
      const stored = await this.assertApprovalPin(currentPin);
      await tx.depositApprovalPin.upsert({
        where: { id: 1 },
        create: { id: 1, hash: newHash },
        update: { hash: newHash },
      });
      await this.audit.write(
        {
          actorUserId,
          action: stored ? 'DEPOSIT_PIN_CHANGED' : 'DEPOSIT_PIN_INITIALIZED',
          entityType: 'DEPOSIT_PROVIDER',
        },
        tx,
      );
    });
    return { success: true };
  }

  private assertConfigured(channel: PaymentChannel, mode: DepositApprovalMode) {
    if (!this.settlement(channel).account)
      throw new BadRequestException('Configure the settlement account first.');
    if (
      (mode === 'AUTOMATIC' || mode === 'LOCAL_WITH_FALLBACK') &&
      !this.config.get<string>('VERIFY_ET_API_KEY')?.trim()
    ) {
      throw new BadRequestException('Configure Verify.ET before enabling this mode.');
    }
    if (
      (mode === 'LOCAL' || mode === 'LOCAL_WITH_FALLBACK') &&
      (!this.config.get<string>('TELEBIRR_VERIFIER_URL')?.startsWith('https://') ||
        !this.config.get<string>('TELEBIRR_VERIFIER_TOKEN') ||
        !this.settlement(channel).receiverName)
    ) {
      throw new BadRequestException(
        'Configure the Telebirr receipt verifier before enabling this mode.',
      );
    }
  }

  private lockFallback(tx: Prisma.TransactionClient) {
    return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('telebirr-fallback', 0))`;
  }
}
