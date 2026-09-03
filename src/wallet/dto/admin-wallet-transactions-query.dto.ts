import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { WalletTransactionType } from '../../generated/prisma/enums';

export class AdminWalletTransactionsQueryDto {
  @IsOptional()
  @IsEnum(WalletTransactionType)
  type?: WalletTransactionType;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 100;
}
