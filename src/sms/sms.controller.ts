import {
  Body,
  Controller,
  Headers,
  HttpCode,
  NotFoundException,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

@Controller('sms')
export class SmsController {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('geezsms/callback')
  @HttpCode(200)
  async callback(
    @Headers('x-callback-secret') header: string | undefined,
    @Query('secret') query: unknown,
    @Body() body: Record<string, unknown>,
  ) {
    const expected = this.config.get<string>('GEEZSMS_CALLBACK_SECRET');
    const provided = header || (typeof query === 'string' ? query : '');
    const digest = (value: string) => createHash('sha256').update(value).digest();
    if (!expected || !provided || !timingSafeEqual(digest(expected), digest(provided))) {
      throw new NotFoundException();
    }
    const status = typeof body?.status === 'string' ? body.status.toLowerCase() : '';
    const id = body?.api_log_id;
    await this.prisma.smsDeliveryLog.create({
      data: {
        status: ['sent', 'delivered', 'failed', 'pending', 'rejected'].includes(status)
          ? status
          : 'unknown',
        providerId: /^[\w-]{1,100}$/.test(String(id ?? '')) ? String(id) : null,
      },
    });
    return { received: true };
  }
}
