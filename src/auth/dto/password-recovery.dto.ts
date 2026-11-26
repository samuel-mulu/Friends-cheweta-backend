import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class RequestPhoneOtpDto {
  @IsString()
  @MaxLength(24)
  phoneNumber!: string;
}

export class ResetPasswordDto extends RequestPhoneOtpDto {
  @IsString()
  @Matches(/^\d{4}$/)
  otp!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  newPassword!: string;
}

export class ChangePasswordDto {
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  currentPassword!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  newPassword!: string;
}
