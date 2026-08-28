import {
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { compare, hash } from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { AppEnv } from '../config/env';
import { UserRole, UserStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { normalizeEthiopianPhone } from '../common/utils/phone.util';
import { sha256 } from '../common/utils/hash.util';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { AccessTokenPayload, RefreshTokenPayload } from './types/jwt-payload.type';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  async register(dto: RegisterDto, ipAddress?: string) {
    const phoneNumber = normalizeEthiopianPhone(dto.phoneNumber);
    const passwordHash = await hash(dto.password, 12);

    const user = await this.usersService.createPlayerWithWallet({
      fullName: dto.fullName.trim(),
      phoneNumber,
      passwordHash,
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
        message: user?.status === UserStatus.BLOCKED ? 'Account is blocked.' : 'Refresh token is invalid.',
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
        message: user?.status === UserStatus.BLOCKED ? 'Account is blocked.' : 'Invalid access token.',
      });
    }

    return this.publicUser(user);
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
  }) {
    const sessionId = randomUUID();
    const refreshToken = await this.signRefreshToken(input.userId, sessionId);

    try {
      await this.prisma.userSession.create({
        data: {
          id: sessionId,
          userId: input.userId,
          refreshTokenHash: sha256(refreshToken),
          deviceName: input.deviceName,
          ipAddress: input.ipAddress,
          expiresAt: this.refreshExpiresAt(),
        },
      });
    } catch {
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
      expiresIn: this.config.get('JWT_ACCESS_TTL', { infer: true }) as any,
    });
  }

  private signRefreshToken(userId: string, sessionId: string): Promise<string> {
    const payload: RefreshTokenPayload = { sub: userId, sid: sessionId, type: 'refresh' };
    return this.jwtService.signAsync(payload, {
      secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }),
      expiresIn: this.config.get('JWT_REFRESH_TTL', { infer: true }) as any,
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
