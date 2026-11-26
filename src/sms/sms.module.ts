import { Module } from '@nestjs/common';
import { GeezSmsService } from './geez-sms.service';
import { SmsController } from './sms.controller';

@Module({ controllers: [SmsController], providers: [GeezSmsService], exports: [GeezSmsService] })
export class SmsModule {}
