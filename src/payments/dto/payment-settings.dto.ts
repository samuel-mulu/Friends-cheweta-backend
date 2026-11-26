import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { DepositApprovalMode, PaymentChannel } from '../../generated/prisma/enums';

export class UpdateDepositConfigDto {
  @IsBoolean()
  enabled!: boolean;

  @IsEnum(DepositApprovalMode)
  approvalMode!: DepositApprovalMode;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  fallbackThreshold?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  fallbackWindowMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  fallbackDurationMinutes?: number;
}

export class DepositReferenceDto {
  @IsEnum(PaymentChannel)
  channel!: PaymentChannel;

  @IsString()
  @MaxLength(500)
  transactionReference!: string;
}

export class PreviewDepositDto extends DepositReferenceDto {
  @Matches(/^\d{1,18}$/)
  amountMinor!: string;
}

export class ApproveDepositDto {
  @Matches(/^\d{6}$/, { message: 'Enter the six-digit approval PIN.' })
  approvalPin!: string;
}

export class ChangeApprovalPinDto {
  @Matches(/^\d{6}$/)
  currentPin!: string;

  @Matches(/^\d{6}$/)
  newPin!: string;
}

export class PayWithdrawalDto {
  @IsString()
  @MaxLength(500)
  @IsUrl(
    { protocols: ['https'], require_protocol: true },
    { message: 'Enter an HTTPS payout receipt URL.' },
  )
  payoutTransactionUrl!: string;
}
