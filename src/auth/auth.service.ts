import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { compare, hash } from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { AppEnv } from '../config/env';
import { Prisma } from '../generated/prisma/client';
import { OtpPurpose, UserRole, UserStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { normalizeEthiopianPhone } from '../common/utils/phone.util';
import { sha256 } from '../common/utils/hash.util';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ChangePasswordDto, ResetPasswordDto } from './dto/password-recovery.dto';
import { OtpService } from './otp.service';
import { AccessTokenPayload, RefreshTokenPayload } from './types/jwt-payload.type';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService<AppEnv, true>,
    private readonly otp: OtpService,
  ) {}

  async register(dto: RegisterDto, ipAddress?: string) {
    const phoneNumber = normalizeEthiopianPhone(dto.phoneNumber);
    const challengeId = await this.otp.verify(phoneNumber, OtpPurpose.REGISTER, dto.otp);
    const passwordHash = await hash(dto.password, 12);
    const user = await this.prisma.$transaction(async (tx) => {
      await this.otp.consume(tx, challengeId);
      return this.usersService.createPlayerWithWallet(
        {
          fullName: dto.fullName.trim(),
          phoneNumber,
          passwordHash,
        },
        tx,
      );
    });

    const tokens = await this.createSessionTokens({
      userId: user.id,
      role: user.role,
      deviceName: dto.deviceName,
      ipAddress,
    });

    return {
      ...tokens,
      user: this.publicUser(user),
    };
  }

  async requestRegisterOtp(input: string, requestIp?: string) {
    const phoneNumber = normalizeEthiopianPhone(input);
    if (await this.usersService.findByPhone(phoneNumber)) {
      throw new ConflictException({
        code: 'PHONE_ALREADY_REGISTERED',
        message: 'An account already exists with this phone number.',
      });
    }
    await this.otp.request(phoneNumber, OtpPurpose.REGISTER, requestIp, true);
    return { message: 'SMS code sent.', resendAfterSeconds: 30 };
  }

  async requestResetOtp(input: string, requestIp?: string) {
    const phoneNumber = normalizeEthiopianPhone(input);
    const user = await this.usersService.findByPhone(phoneNumber);
    await this.otp.request(
      phoneNumber,
      OtpPurpose.PASSWORD_RESET,
      requestIp,
      user?.role === UserRole.PLAYER && user.status === UserStatus.ACTIVE && !user.isBot,
    );
    return {
      message: 'If this number is eligible, a reset code will arrive by SMS.',
      resendAfterSeconds: 30,
    };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const phoneNumber = normalizeEthiopianPhone(dto.phoneNumber);
    const challengeId = await this.otp.verify(phoneNumber, OtpPurpose.PASSWORD_RESET, dto.otp);
    const passwordHash = await hash(dto.newPassword, 12);
    await this.prisma.$transaction(async (tx) => {
      await this.otp.consume(tx, challengeId);
      const user = await tx.user.findUnique({ where: { phoneNumber } });
      if (!user) throw new UnauthorizedException('Invalid or expired code.');
      const changed = await tx.user.updateMany({
        where: { id: user.id, role: UserRole.PLAYER, status: UserStatus.ACTIVE, isBot: false },
        data: { passwordHash },
      });
      if (changed.count !== 1) throw new UnauthorizedException('Invalid or expired code.');
      await tx.userSession.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
    return { message: 'Password reset. Sign in with your new password.' };
  }

  async verifyPassword(userId: string, password: string) {
    const user = await this.usersService.findById(userId);
    if (
      !user ||
      user.status !== UserStatus.ACTIVE ||
      !(await compare(password, user.passwordHash))
    ) {
      throw new ForbiddenException({
        code: 'INCORRECT_PASSWORD',
        message: 'The account password is incorrect.',
      });
    }
    return user.passwordHash;
  }

  async assertCurrentCredential(
    tx: Prisma.TransactionClient,
    userId: string,
    passwordHash: string,
  ) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "User"
      WHERE id = ${userId} AND "passwordHash" = ${passwordHash} AND status = 'ACTIVE'
      FOR UPDATE
    `;
    if (!rows.length) {
      throw new ForbiddenException({
        code: 'PASSWORD_CHANGED',
        message: 'The account password has changed. Sign in again.',
      });
    }
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const current = await this.verifyPassword(userId, dto.currentPassword);
    const passwordHash = await hash(dto.newPassword, 12);
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.user.updateMany({
        where: { id: userId, passwordHash: current, status: UserStatus.ACTIVE },
        data: { passwordHash },
      });
      if (changed.count !== 1) {
        throw new ConflictException({
          code: 'PASSWORD_CHANGED',
          message: 'Your password has already changed. Sign in again.',
        });
      }
      await tx.userSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
    return { message: 'Password changed. Sign in with your new password.' };
  }

  async login(dto: LoginDto, ipAddress?: string) {
    const phoneNumber = normalizeEthiopianPhone(dto.phoneNumber);
    const user = await this.usersService.findByPhone(phoneNumber);

    if (!user || !(await compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid phone number or password.',
      });
    }

    if (user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException({ code: 'ACCOUNT_BLOCKED', message: 'Account is blocked.' });
    }

    const tokens = await this.createSessionTokens({
      userId: user.id,
      role: user.role,
      deviceName: dto.deviceName,
      ipAddress,
      passwordHash: user.passwordHash,
    });

    return { ...tokens, user: this.publicUser(user) };
  }

  async refresh(refreshToken: string) {
    const payload = await this.verifyRefreshToken(refreshToken);
    const session = await this.prisma.userSession.findUnique({ where: { id: payload.sid } });

    if (
      !session ||
      session.userId !== payload.sub ||
      session.revokedAt ||
      session.expiresAt <= new Date() ||
      session.refreshTokenHash !== sha256(refreshToken)
    ) {
      throw new UnauthorizedException({
        code: 'INVALID_REFRESH_TOKEN',
        message: 'Refresh token is invalid or expired.',
      });
    }

    const user = await this.usersService.findById(payload.sub);
    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException({
        code: user?.status === UserStatus.BLOCKED ? 'ACCOUNT_BLOCKED' : 'INVALID_REFRESH_TOKEN',
        message:
          user?.status === UserStatus.BLOCKED ? 'Account is blocked.' : 'Refresh token is invalid.',
      });
    }

    const newRefreshToken = await this.signRefreshToken(user.id, session.id);
    const expiresAt = this.refreshExpiresAt();

    const rotated = await this.prisma.userSession.updateMany({
      where: {
        id: session.id,
        userId: user.id,
        refreshTokenHash: sha256(refreshToken),
        revokedAt: null,
      },
      data: { refreshTokenHash: sha256(newRefreshToken), expiresAt },
    });

    if (rotated.count !== 1) {
      throw new UnauthorizedException({
        code: 'REFRESH_TOKEN_ALREADY_ROTATED',
        message: 'Refresh token has already been used.',
      });
    }

    return {
      accessToken: await this.signAccessToken(user.id, user.role),
      refreshToken: newRefreshToken,
    };
  }

  async validateAccessToken(accessToken: string) {
    let payload: AccessTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<AccessTokenPayload>(accessToken, {
        secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
      });
    } catch {
      throw new UnauthorizedException({
        code: 'INVALID_ACCESS_TOKEN',
        message: 'Access token is invalid or expired.',
      });
    }

    const user = await this.usersService.findById(payload.sub);
    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException({
        code: user?.status === UserStatus.BLOCKED ? 'ACCOUNT_BLOCKED' : 'INVALID_ACCESS_TOKEN',
        message:
          user?.status === UserStatus.BLOCKED ? 'Account is blocked.' : 'Invalid access token.',
      });
    }

    return { ...this.publicUser(user), isBot: user.isBot };
  }

  async logout(refreshToken: string): Promise<{ success: true }> {
    let payload: RefreshTokenPayload;
    try {
      payload = await this.verifyRefreshToken(refreshToken);
    } catch {
      return { success: true };
    }

    await this.prisma.userSession.updateMany({
      where: {
        id: payload.sid,
        userId: payload.sub,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });

    return { success: true };
  }

  private async createSessionTokens(input: {
    userId: string;
    role: UserRole;
    deviceName?: string;
    ipAddress?: string;
    passwordHash?: string;
  }) {
    const sessionId = randomUUID();
    const refreshToken = await this.signRefreshToken(input.userId, sessionId);

    const data = {
      id: sessionId,
      userId: input.userId,
      refreshTokenHash: sha256(refreshToken),
      deviceName: input.deviceName,
      ipAddress: input.ipAddress,
      expiresAt: this.refreshExpiresAt(),
    };
    try {
      const passwordHash = input.passwordHash;
      if (passwordHash) {
        await this.prisma.$transaction(async (tx) => {
          await this.assertCurrentCredential(tx, input.userId, passwordHash);
          await tx.userSession.create({ data });
        });
      } else {
        await this.prisma.userSession.create({ data });
      }
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      throw new InternalServerErrorException({
        code: 'SESSION_CREATE_FAILED',
        message: 'Could not create a login session. Please try again.',
      });
    }

    return {
      accessToken: await this.signAccessToken(input.userId, input.role),
      refreshToken,
    };
  }

  private signAccessToken(userId: string, role: UserRole): Promise<string> {
    const payload: AccessTokenPayload = { sub: userId, role };
    return this.jwtService.signAsync(payload, {
      secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
      expiresIn: this.config.get('JWT_ACCESS_TTL', { infer: true }),
    });
  }

  private signRefreshToken(userId: string, sessionId: string): Promise<string> {
    const payload: RefreshTokenPayload = { sub: userId, sid: sessionId, type: 'refresh' };
    return this.jwtService.signAsync(payload, {
      secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }),
      expiresIn: this.config.get('JWT_REFRESH_TTL', { infer: true }),
    });
  }

  private verifyRefreshToken(token: string): Promise<RefreshTokenPayload> {
    return this.jwtService.verifyAsync<RefreshTokenPayload>(token, {
      secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }),
    });
  }

  private refreshExpiresAt(): Date {
    const ttl = this.config.get('JWT_REFRESH_TTL', { infer: true });
    const match = /^(\d+)([smhd])$/.exec(ttl);
    if (!match) throw new Error('JWT_REFRESH_TTL must use s, m, h, or d suffix.');

    const value = Number(match[1]);
    const unit = match[2];
    const multiplier = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
    if (multiplier === undefined) {
      throw new Error('JWT_REFRESH_TTL must use s, m, h, or d suffix.');
    }
    return new Date(Date.now() + value * multiplier);
  }

  private publicUser(user: {
    id: string;
    fullName: string;
    phoneNumber: string;
    role: UserRole;
    status: UserStatus;
    createdAt: Date;
  }) {
    return {
      id: user.id,
      fullName: user.fullName,
      phoneNumber: user.phoneNumber,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
    };
  }
}
