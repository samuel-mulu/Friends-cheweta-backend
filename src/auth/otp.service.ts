import { HttpException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { compare, hash } from 'bcryptjs';
import { Prisma } from '../generated/prisma/client';
import { OtpPurpose } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { GeezSmsService } from '../sms/geez-sms.service';

const resendMs = 30_000;
const expiryMs = 5 * 60_000;
const maxAttempts = 8;
const invalidCode = () =>
  new UnauthorizedException({ code: 'INVALID_OTP', message: 'Invalid or expired code.' });

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sms: GeezSmsService,
  ) {}

  async request(
    phoneNumber: string,
    purpose: OtpPurpose,
    requestIp: string | undefined,
    deliver: boolean,
  ) {
    const challenge = await this.prisma.$transaction(async (tx) => {
      if (requestIp) await this.lock(tx, `otp-ip:${requestIp}`);
      await this.lock(tx, `otp-phone:${phoneNumber}`);
      const now = new Date();
      const windowStart = new Date(now.getTime() - 15 * 60_000);
      const latest = await tx.otpChallenge.findFirst({
        where: { phoneNumber },
        orderBy: { createdAt: 'desc' },
      });
      if (latest && now.getTime() - latest.createdAt.getTime() < resendMs) this.rateLimited();
      const byPhone = await tx.otpChallenge.count({
        where: { phoneNumber, createdAt: { gte: windowStart } },
      });
      if (byPhone >= 30) this.rateLimited();
      if (requestIp) {
        const byIp = await tx.otpChallenge.count({
          where: { requestIp, createdAt: { gte: windowStart } },
        });
        if (byIp >= 200) this.rateLimited();
      }
      await tx.otpChallenge.updateMany({
        where: { phoneNumber, purpose, consumedAt: null },
        data: { consumedAt: now, codeHash: null },
      });
      return tx.otpChallenge.create({
        data: {
          phoneNumber,
          purpose,
          requestIp,
          expiresAt: new Date(now.getTime() + expiryMs),
        },
      });
    });

    if (!deliver) return;
    const delivery = this.deliver(challenge.id, phoneNumber, purpose);
    if (purpose === OtpPurpose.REGISTER) await delivery;
  }

  private async deliver(id: string, phoneNumber: string, purpose: OtpPurpose) {
    try {
      const code = await this.sms.sendOtp(phoneNumber);
      const codeHash = await hash(code, 10);
      await this.prisma.otpChallenge.updateMany({
        where: { id, consumedAt: null },
        data: { codeHash },
      });
    } catch (error) {
      this.logger.warn(`OTP delivery failed for ${purpose}`);
      if (purpose === OtpPurpose.REGISTER) throw error;
    }
  }

  async verify(phoneNumber: string, purpose: OtpPurpose, code: string) {
    const now = new Date();
    const challenge = await this.prisma.otpChallenge.findFirst({
      where: { phoneNumber, purpose, consumedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    });
    if (!challenge?.codeHash) throw invalidCode();
    const attempt = await this.prisma.otpChallenge.updateMany({
      where: {
        id: challenge.id,
        consumedAt: null,
        attempts: { lt: maxAttempts },
        expiresAt: { gt: now },
      },
      data: { attempts: { increment: 1 } },
    });
    if (attempt.count !== 1 || !(await compare(code, challenge.codeHash))) throw invalidCode();
    return challenge.id;
  }

  async consume(tx: Prisma.TransactionClient, id: string) {
    const now = new Date();
    const result = await tx.otpChallenge.updateMany({
      where: { id, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now, codeHash: null },
    });
    if (result.count !== 1) throw invalidCode();
  }

  private lock(tx: Prisma.TransactionClient, key: string) {
    return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }

  private rateLimited(): never {
    throw new HttpException(
      { code: 'OTP_RATE_LIMITED', message: 'Please wait before requesting another code.' },
      429,
    );
  }
}
