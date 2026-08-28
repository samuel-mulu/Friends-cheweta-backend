import { IsEnum, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { PaymentChannel } from '../../generated/prisma/enums';

export class CreateDepositDto {
  @Matches(/^\d+$/, { message: 'amountMinor must be a positive integer string.' })
  amountMinor!: string;

  @IsEnum(PaymentChannel)
  channel!: PaymentChannel;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  transactionReference!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  idempotencyKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
